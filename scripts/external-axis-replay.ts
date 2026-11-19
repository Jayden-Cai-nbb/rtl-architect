import assert from 'node:assert/strict';
import { validateModel } from '../src/core/engine';
import type { Model, StreamTransactionPath } from '../src/core/schema';
import { stateUpdateReads } from '../src/core/signals';
import type { StreamReplayMapping, StreamReplayResult } from '../src/core/streamReplay';
import { replaySamplesSchema, replayTransactions } from '../src/core/transactionReplay';

export function axisStreamPath(model: Model): StreamTransactionPath {
  const path = model.modules[0].contract.transactionPaths?.[0];
  assert(path && path.semantics !== 'ordered_lossless_single_slot_stages');
  return path;
}

export function axisReplayMapping(model: Model, runId: string, configuration: string, artifact: string): StreamReplayMapping {
  const path = axisStreamPath(model);
  const ports = [path.reset.interfaceId, path.ingress.valid, path.ingress.ready, path.egress.valid, path.egress.ready,
    ...path.fields.flatMap(f => f.constant === undefined ? [f.input, f.output] : [f.output])];
  const states = path.semantics === 'combinational_bypass' ? [] : [path.readyState, path.output.validState, ...Object.values(path.output.fields)];
  if (path.semantics === 'registered_skid') states.push(path.temporary.validState, ...Object.values(path.temporary.fields));
  const columns = (ids: string[]) => Object.fromEntries(ids.map(id => [id, id]));
  return { schemaVersion: 2, moduleId: model.design.top, pathId: path.id, origin: 'simulation', runId, configuration,
    artifact, ports: columns(ports), states: columns(states) };
}

export type DirectedOracle = {
  accepted: { edge: number; fields: Record<string, number> }[];
  consumed: { edge: number; sequence: number }[];
  cancelled: { edge: number; sequence: number }[];
  inFlight: number[];
  failures: { edge: number; sequence: number; expected: Record<string, number>; actual: Record<string, number> }[];
};

export function auditReplayIdentity(result: StreamReplayResult) {
  const accepted = result.events.filter(e => e.kind === 'accept');
  const ended = result.events.filter(e => e.kind === 'consume' || e.kind === 'cancel');
  const acceptedIds = accepted.map(a => a.transaction);
  assert.deepEqual(acceptedIds, accepted.map((_, i) => `T${i}`));
  assert.deepEqual([...ended.map(e => e.transaction), ...result.inFlight.map(t => t.id)].sort(), acceptedIds.sort());
  assert.deepEqual(ended.filter(e => e.kind === 'consume').map(e => +e.transaction.slice(1)),
    ended.filter(e => e.kind === 'consume').map(e => +e.transaction.slice(1)).sort((a, b) => a - b));
  for (const e of result.events) assert.deepEqual(e.fields, accepted[+e.transaction.slice(1)]?.fields);
}

export function auditDirected(result: StreamReplayResult, oracle: DirectedOracle, type: number) {
  assert.deepEqual(oracle.failures, [], 'independent end-to-end queue detected a mismatch');
  auditReplayIdentity(result);
  const { coverage, events } = result;
  assert.deepEqual(events.filter(e => e.kind === 'accept').map(e => ({ edge: e.edge, fields: e.fields })),
    oracle.accepted.map(a => ({ edge: a.edge, fields: Object.fromEntries(Object.keys(result.observations.fields).map(f => [f, String(a.fields[`t${f}`])])) })));
  for (const [kind, expected] of [['consume', oracle.consumed], ['cancel', oracle.cancelled]] as const) {
    assert.deepEqual(events.filter(e => e.kind === kind).map(e => ({ edge: e.edge, sequence: +e.transaction.slice(1) })), expected);
  }
  assert.deepEqual(result.inFlight.map(t => +t.id.slice(1)), oracle.inFlight);
  assert.equal(coverage.peakOccupancy, type);
  assert.equal(coverage.cancelled, type);
  assert(coverage.inputBlockedEdges >= 16 && coverage.longestOutputStall >= 16 && coverage.recovered > 0 && coverage.inputRecovered > 0);
  assert(coverage.continuousInputEdges > 0 && coverage.sameBeatSuccessors > 0 && coverage.sameDataSuccessors > coverage.sameBeatSuccessors);
  if (type === 0) {
    assert.equal(coverage.sameEdgeAcceptConsume, coverage.accepted);
    assert.equal(coverage.resetHandshakes, 1);
    assert(events.every(e => e.object.kind === 'boundary' && e.phase === 'pre'));
  } else if (type === 1) {
    assert.equal(coverage.consecutiveAccepts, 0);
    assert.equal(coverage.sameEdgeAcceptConsume, 0);
    assert.equal(coverage.temporaryStores, 0);
  } else {
    assert(coverage.consecutiveAccepts > 0 && coverage.sameEdgeOutputReplacement > 0 && coverage.temporaryStores > 0 && coverage.sameEdgeConsumeTransfer > 0);
    const simultaneous = result.rows.find(r => r.events.some(e => e.kind === 'consume') && r.events.some(e => e.kind === 'transfer'))!;
    const moved = simultaneous.events.find(e => e.kind === 'transfer')!;
    const consumed = simultaneous.events.find(e => e.kind === 'consume')!;
    assert.notEqual(moved.transaction, consumed.transaction);
    assert.equal(moved.fields.data, consumed.fields.data);
    assert.notEqual(moved.fields.dest, consumed.fields.dest);
    assert.deepEqual(events.filter(e => e.kind === 'cancel').map(e => e.slot), ['output', 'temporary']);
  }
}

export function auditReplayBoundaries(model: Model, artifact: unknown) {
  const path = axisStreamPath(model);
  assert.equal(path.semantics, 'registered_skid');
  const samples = replaySamplesSchema.parse(artifact);
  const mapping = axisReplayMapping(model, 'boundary_check', 'directed.json', 'directed.samples.json');
  const play = (trace = samples) => replayTransactions(model, path, mapping, trace);
  const result = play();
  const waiting = result.rows.find(r => r.inputBlocked)!;
  assert(waiting);
  const inputViolation = structuredClone(samples);
  const id = path.fields.find(f => f.id === 'id')!;
  const sampled = inputViolation.rows[waiting.edge].post;
  sampled[id.input] = (BigInt(sampled[id.input]!) ^ 1n).toString();
  sampled[path.egress.valid] = 'x';
  const invalid = play(inputViolation);
  assert.equal(invalid.status, 'ENVIRONMENT_VIOLATION');
  assert.equal(invalid.environment.violation?.field, 'id');
  assert.deepEqual(invalid.issues, []);
  const onlyReset = play({ ...samples, rows: samples.rows.slice(0, 1) });
  assert.equal(onlyReset.status, 'COVERAGE_INCOMPLETE');
  const occupied = result.rows.find(row => row.locations.length === 2)!;
  assert(occupied);
  const finite = play({ ...samples, rows: samples.rows.slice(0, occupied.edge + 1) });
  assert.equal(finite.status, 'OBSERVED');
  assert.equal(finite.inFlight.length, 2);
  assert.equal(finite.coverage.accepted, finite.coverage.consumed + finite.inFlight.length);
  const unknown = structuredClone(samples);
  unknown.rows[occupied.edge].post[path.temporary.fields.user] = 'x';
  const unresolved = play(unknown);
  assert.equal(unresolved.status, 'UNKNOWN');
  assert.match(unresolved.sampleIssue!.message, /temp_m_axis_tuser_reg/);
  const falseValid = structuredClone(samples);
  const initialLoad = result.events.find(e => e.kind === 'accept')!.edge;
  const { pre, post } = falseValid.rows[initialLoad];
  pre[path.egress.ready] = '0';
  pre[path.egress.valid] = '1';
  for (const f of path.fields) pre[f.output] = pre[f.input];
  const data = path.fields.find(f => f.id === 'data')!;
  post[data.output] = (BigInt(post[data.output]!) ^ 1n).toString();
  const initialIssues = play(falseValid).rows[initialLoad].issues;
  assert.deepEqual(initialIssues.map(i => i.code), ['VALID_PHASE', 'PAYLOAD_MISMATCH']);
  assert.throws(() => play({ ...samples, format: 'rtlarch-rv-samples-v1' }), /格式版本/);
  const missing = structuredClone(mapping);
  delete missing.states[path.temporary.fields.data];
  assert.throws(() => replayTransactions(model, path, missing, samples), /states/);

  const explicit = structuredClone(model);
  const output = explicit.localSignals!.find(s => s.id === path.output.fields.data)!;
  output.width = { expr: 'DATA_WIDTH * 2 / 2' };
  assert.deepEqual(validateModel(explicit).filter(i => i.blocks.includes('commit')), []);
  const driver = output.driver;
  assert(driver.kind === 'register' && driver.update);
  driver.update.branches.find(b => b.id === path.output.loadTemporaryBranch)!.condition = { kind: 'constant', width: 1, value: '0' };
  driver.inputs = stateUpdateReads(driver.update);
  const blocked = validateModel(explicit).find(i => i.code === 'TRANSACTION_PATH');
  assert.match(blocked!.message, /装载分支不可达/);
  return { onlyReset: onlyReset.status, finite: { status: finite.status, inFlight: finite.inFlight.map(t => t.id) },
    environment: invalid.environment, unknown: unresolved.sampleIssue, falseValid: initialIssues,
    unreachableBranch: blocked!.message, versionMix: 'REJECTED', missingMapping: 'REJECTED' };
}
