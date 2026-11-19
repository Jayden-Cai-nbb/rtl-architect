import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { modelHash } from '../src/core/export';
import { modelSchema, type Model } from '../src/core/schema';
import type { StreamReplayResult } from '../src/core/streamReplay';
import { diagramSvg } from '../src/web/graph/exportSvg';
import { prepareDiagram } from '../src/web/graph/prepareDiagram';
import { diagramQuality } from '../src/web/graph/quality';
import type { DiagramOptions } from '../src/web/graph/scopeDiagram';
import type { assurance as readAssurance } from '../src/workspace/assurance';
import { toolRoot, toolVersion } from '../src/workspace/environment';
import type { importYosys } from '../src/workspace/importYosys';
import type { runStateObservation } from '../src/workspace/stateObservation';
import type { importReplay } from '../src/workspace/transactionReplay';
import type { runVerification } from '../src/workspace/verification';
import { auditStructure, axisModel, axisNetlist, baseline, benchmarkRoot as frozen, stateMapping, type Configuration } from './external-axis-model';
import { auditDirected, auditReplayIdentity, auditReplayBoundaries, axisReplayMapping, axisStreamPath, type DirectedOracle } from './external-axis-replay';

type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'NOT_RUN' | 'UNSUPPORTED';
type Result = { status: Status; reason?: string; [key: string]: unknown };
type Row = { id: string; parameters: Configuration['parameters'] } & Record<'test' | 'structure' | 'state' | 'transaction' | 'reading' | 'nativeReplay', Result>;
type Verification = Awaited<ReturnType<typeof runVerification>>;
type Observation = Awaited<ReturnType<typeof runStateObservation>>;
type Imported = Awaited<ReturnType<typeof importYosys>>;
type Upstream = {
  cases: Record<string, Result & { tests?: Record<string, string> }>;
  exitCode: number;
  tools: unknown;
  error?: string;
};
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const rtl = 'rtl/axis_register.v';
const program = join(toolRoot, 'bin/rtlarch');
const lockHash = sha256(join(frozen, 'baseline.json'));
const runnerFiles = ['scripts/benchmark-external-axis.ts', 'scripts/external-axis-model.ts', 'scripts/external-axis-replay.ts',
  'examples/external-axis/benchmark/probe.py', 'examples/external-axis/benchmark/directed_replay.py'];
const runnerDigests = () => Object.fromEntries(runnerFiles.map(file => [file, sha256(join(toolRoot, file))]));
const output = mkdtempSync(join(tmpdir(), 'rtlarch-axis-benchmark-'));
const fromOutput = (path: string) => relative(output, path);

function executable(command: string) {
  const file = command.includes('/') ? resolve(command) : (process.env.PATH ?? '').split(delimiter)
    .map(dir => resolve(dir, command)).find(path => {
      try { accessSync(path, constants.X_OK); return true; } catch { return false; }
    });
  if (!file) throw new Error(`executable not found: ${command}`);
  accessSync(file, constants.X_OK);
  return file;
}

function run(cwd: string, cmd: string, args: string[], name: string, timeout = 90_000) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout });
  const log = join(cwd, name);
  writeFileSync(log + '.stdout', result.stdout ?? '', { flag: 'wx' });
  writeFileSync(log + '.stderr', result.stderr ?? '', { flag: 'wx' });
  writeJson(log + '.command.json', { cmd, args, cwd, exitCode: result.status, signal: result.signal, error: result.error?.message });
  return { exitCode: result.status, stdout: result.stdout ?? '', error: result.error, log: fromOutput(log) };
}

function cli<T>(cwd: string, name: string, args: string[]) {
  const result = run(cwd, program, [...args, '--workspace', cwd, '--json'], name, 150_000);
  if (result.error) throw result.error;
  try {
    return { ...result, value: JSON.parse(result.stdout) as T & { ok: boolean; error?: { message: string } } };
  } catch {
    throw new Error(`invalid rtlarch JSON; see ${result.log}.stderr`);
  }
}

function frozenFiles(workspace: string) {
  for (const [file, hash] of Object.entries(baseline.files)) {
    assert.equal(sha256(join(workspace, file)), hash, `frozen upstream file changed: ${file}`);
  }
  assert.equal(sha256(join(frozen, 'baseline.json')), lockHash);
  const copy = join(workspace, 'baseline.json');
  if (existsSync(copy)) assert.equal(sha256(copy), lockHash, 'workspace acceptance configuration changed');
}

function workspace(path: string) {
  cpSync(join(frozen, 'upstream'), path, { recursive: true, errorOnExist: true, force: false });
  for (const file of ['baseline.json', 'probe.py', 'directed_replay.py']) copyFileSync(join(frozen, file), join(path, file), constants.COPYFILE_EXCL);
  frozenFiles(path);
  return path;
}

function saveModel(cwd: string, model: Model) {
  mkdirSync(join(cwd, 'architecture'));
  writeJson(join(cwd, 'architecture/model.json'), model);
}

function captured(work: () => Result): Result {
  try { return work(); } catch (error) { return { status: 'BLOCKED', reason: String(error) }; }
}

function elaborate(cwd: string, config: Configuration) {
  const { top } = baseline;
  const params = Object.entries(config.parameters).map(([name, value]) => `-set ${name} ${value}`).join(' ');
  writeJson(join(cwd, 'elaboration.json'), {
    schemaVersion: 1, name: `Upstream axis_register ${config.id}`, stage: 'elaboration', moduleIds: ['top'],
    inputs: [rtl, 'baseline.json', 'elaboration.json'],
    inputClosure: { status: 'declared_complete', note: 'Single translation unit, explicit top and parameter overrides, no includes.' },
    timeoutMs: 30_000,
    commands: [{ program: 'yosys', versionArgs: ['-V'], args: ['-Q', '-T', '-p',
      `read_verilog ${rtl}; chparam ${params} ${top}; hierarchy -check -top ${top}; proc; opt_muxtree; check -assert; write_json "{runDir}/netlist.json"`] }],
    checks: [{ kind: 'artifact', file: 'netlist.json' }],
  });
  const { value, exitCode, log } = cli<Verification>(cwd, 'elaboration', ['verify', 'elaboration.json']);
  assert.ok(value.ok && exitCode === 0, `Yosys elaboration failed, see ${log}.stdout`);
  return value;
}

function observe(cwd: string, config: Configuration, model: Model, verify: Verification, definition: ReturnType<typeof axisNetlist>) {
  writeJson(join(cwd, 'state-mapping.json'), stateMapping(config, model, definition, verify.id));
  const { value, exitCode, log } = cli<Observation>(cwd, 'observe', ['observe-state', 'state-mapping.json']);
  assert.ok(value.discoveryComplete && value.producerFresh && value.record && value.basis.kind === 'as_built', `observation incomplete, see ${log}.stdout`);
  assert.equal(value.modelHash, modelHash(model));
  assert.equal(value.ok, exitCode === 0);
  return value;
}

function importStructure(cwd: string, config: Configuration, model: Model, verify: Verification, definition: ReturnType<typeof axisNetlist>): Result {
  const netlist = relative(cwd, join(verify.directory, 'netlist.json'));
  writeJson(join(cwd, 'import-manifest.json'), { schemaVersion: 1, top: baseline.top, netlist,
    files: [rtl, 'baseline.json', 'elaboration.json'], configuration: model.provenance!.configuration });
  const { value, exitCode, log } = cli<Imported>(cwd, 'import', ['import-yosys', 'import-manifest.json', 'imported']);
  assert.ok(value.ok && exitCode === 0, `import failed, see ${log}.stdout`);
  const imported = modelSchema.parse(readJson(value.modelFile));
  return { status: 'PASS', ...auditStructure(config, model, imported, definition), modelHash: modelHash(model),
    yosys: verify.steps[0]?.toolVersion, run: fromOutput(join(verify.directory, 'run.json')),
    import: fromOutput(value.reportFile), netlist: fromOutput(join(cwd, netlist)) };
}

function captureSimulation(cwd: string, profile: string, name: string, python: string, args: string[], inputs: string[], artifacts: string[]) {
  writeJson(join(cwd, profile), {
    schemaVersion: 1, name, stage: 'simulation', moduleIds: ['top'], inputs: [...inputs, profile],
    inputClosure: { status: 'declared_complete', note: 'Explicit frozen sources, simulator inputs and collector. Simulator versions are recorded with the artifacts.' },
    timeoutMs: 65_000,
    commands: [{ program: python, versionArgs: ['--version'], args }],
    checks: artifacts.map(file => ({ kind: 'artifact', file })),
  });
  const { value, exitCode, log } = cli<Verification>(cwd, profile, ['verify', profile]);
  assert.ok(value.ok && exitCode === 0 && value.status === 'passed', `capture failed, see ${log}.stdout`);
  return value;
}

function convertUpstream(cwd: string, config: Configuration, upstreamDir: string, python: string, fst2vcd: string) {
  const caseDir = `original-input/${config.id}`;
  mkdirSync(join(cwd, caseDir), { recursive: true });
  copyFileSync(join(upstreamDir, 'upstream-results.json'), join(cwd, 'original-input/upstream-results.json'), constants.COPYFILE_EXCL);
  const raw = ['axis_register.fst', 'cocotb.xml'];
  for (const file of raw) copyFileSync(join(upstreamDir, config.id, file), join(cwd, caseDir, file), constants.COPYFILE_EXCL);
  return captureSimulation(cwd, 'original-wave.json', `Archived original cocotb simulation ${config.id}`, python,
    ['probe.py', 'trace', '--fst2vcd', fst2vcd, '--case', config.id, '--upstream', 'original-input', '--out', '{runDir}/transaction.json', '--replay-samples'],
    [...Object.keys(baseline.files), 'baseline.json', 'probe.py', 'original-input/upstream-results.json', ...raw.map(f => `${caseDir}/${f}`)],
    ['transaction.json', 'unpaused.samples.json', 'backpressure.samples.json', 'wave.vcd']);
}

function directedSimulation(cwd: string, config: Configuration, python: string, icarusBin: string) {
  return captureSimulation(cwd, 'directed.json', `Supplemental directed capture ${config.id}`, python,
    ['directed_replay.py', '--case', config.id, '--icarus-bin', icarusBin, '--out', '{runDir}'],
    [rtl, 'tox.ini', 'baseline.json', 'probe.py', 'directed_replay.py'], ['directed.samples.json', 'directed-oracle.json', 'directed-inputs.json']);
}

function importNative(cwd: string, model: Model, run: Verification, scenario: string, configuration: string) {
  const file = `${scenario}.replay.json`;
  writeJson(join(cwd, file), axisReplayMapping(model, run.id, configuration, `${scenario}.samples.json`));
  const { value, exitCode, log } = cli<Awaited<ReturnType<typeof importReplay>>>(cwd, scenario + '-replay', ['replay', file]);
  assert.ok(value.ok && exitCode === 0 && 'schemaVersion' in value.result && value.result.schemaVersion === 2, `replay import failed, see ${log}.stdout`);
  assert.equal(value.modelHash, modelHash(model));
  return { ...value, result: value.result as StreamReplayResult, record: fromOutput(join(cwd, 'evidence', 'replays', value.id, 'record.json')),
    samples: fromOutput(join(run.directory, value.mapping.artifact)), run: fromOutput(join(run.directory, 'run.json')), mapping: fromOutput(join(cwd, file)) };
}

function nativeReplay(cwd: string, config: Configuration, model: Model, original: Verification, python: string, icarusBin: string): Result {
  const directed = directedSimulation(cwd, config, python, icarusBin);
  const oracleFile = join(directed.directory, 'directed-oracle.json');
  const scenarios = [];
  for (const [tag, run, profile] of [['unpaused', original, 'original-wave.json'], ['backpressure', original, 'original-wave.json'],
    ['directed', directed, 'directed.json']] as const) {
    const replay = importNative(cwd, model, run, tag, profile);
    const { result, assurance, record, samples, mapping } = replay;
    const info = { tag, assurance, result: result.status, coverage: result.coverage, inFlight: result.inFlight.length, observations: result.observations,
      record, sampling: samples, mapping, run: replay.run, checkerVersion: replay.checkerVersion };
    scenarios.push(info);
    if (assurance !== 'OBSERVED' || result.environment.status !== 'CHECKED') return { status: 'FAIL', scenarios,
      reason: 'Missing current observation or invalid source premise.', firstIssue: result.issues[0], environment: result.environment, sampleIssue: result.sampleIssue };
    assert(result.coverage.accepted > 0 && result.coverage.consumed > 0);
    assert.equal(result.coverage.outputHandshakes, result.coverage.consumed);
    if (tag === 'backpressure') assert(result.coverage.blocked > 0 && result.coverage.recovered > 0);
    try {
      auditReplayIdentity(result);
      if (tag === 'directed') auditDirected(result, readJson(oracleFile) as DirectedOracle, config.parameters.REG_TYPE);
    } catch (error) { return { status: 'FAIL', reason: String(error), scenarios, oracle: fromOutput(oracleFile) }; }
  }
  const boundaries = config.id === '16-2' ? auditReplayBoundaries(model, readJson(join(directed.directory, 'directed.samples.json'))) : undefined;
  return { status: 'PASS', scenarios, oracle: fromOutput(oracleFile), boundaries };
}

function sidebandFault(python: string, icarusBin: string): Result {
  const config = baseline.configurations.find(c => c.id === '16-2')!;
  const cwd = workspace(join(output, 'fault-skid-sideband'));
  const pristine = readFileSync(join(cwd, rtl), 'utf8');
  const before = 'm_axis_tdest_reg <= temp_m_axis_tdest_reg;';
  const after = 'm_axis_tdest_reg <= temp_m_axis_tid_reg;';
  assert.equal(pristine.split(before).length, 2);
  const line = pristine.slice(0, pristine.indexOf(before)).split('\n').length;
  writeFileSync(join(cwd, rtl), pristine.replace(before, after));
  const model = axisModel(config, baseline.files[rtl]);
  saveModel(cwd, model);
  const run = directedSimulation(cwd, config, python, icarusBin);
  const replay = importNative(cwd, model, run, 'directed', 'directed.json');
  const oracleFile = join(run.directory, 'directed-oracle.json');
  const oracle = readJson(oracleFile) as DirectedOracle;
  const issue = replay.result.issues.find(i => i.field === 'dest' && i.object.kind === 'local' && i.object.id === 'm_axis_tdest_reg');
  assert.equal(replay.assurance, 'FAILED');
  assert.equal(replay.result.environment.status, 'CHECKED');
  assert(issue && issue.object.kind === 'local' && issue.object.branch === 'move_temp');
  assert.equal(replay.result.observations.fields.data.mismatched, 0);
  assert(replay.result.observations.fields.dest.mismatched > 0);
  const independent = oracle.failures[0];
  assert(independent && independent.sequence === +issue.transaction!.slice(1));
  assert.equal(independent.expected.tdata, independent.actual.tdata);
  const report = { status: 'PASS' as const, case: config.id, verdict: replay.assurance, issue, independent,
    original: { file: rtl, line, sha256: baseline.files[rtl] }, injected: { before, after, sha256: sha256(join(cwd, rtl)) },
    record: replay.record, oracle: fromOutput(oracleFile), samples: replay.samples, run: replay.run };
  writeJson(join(output, 'skid-sideband-fault.json'), report);
  return report;
}

async function diagrams(cwd: string, config: Configuration, model: Model): Promise<Result> {
  const type = config.parameters.REG_TYPE;
  const hash = modelHash(model);
  const scope = model.design.top;
  const tasks: { name: string; options: DiagramOptions }[] = [
    { name: 'overview', options: { task: { kind: 'overview' } } },
    type === 0 ? { name: 'signals', options: { mode: 'signals' } }
      : { name: 'state', options: { task: { kind: 'state', stateId: 'm_axis_tdata_reg' } } },
  ];
  if (type === 2) tasks.push({ name: 'temporary-slot', options: { task: { kind: 'state', stateId: 'temp_m_axis_tdata_reg' } } });
  const results = [];
  for (const { name, options } of tasks) {
    const { graph, layoutSource, readingSource } = await prepareDiagram(model, scope, hash, undefined, options);
    const quality = diagramQuality(graph);
    const ok = quality.status === 'passed' && quality.structuralFidelity.status === 'passed' && quality.readingConstraints.status !== 'needs_attention';
    const json = join(cwd, `diagram-${name}.json`);
    const svg = join(cwd, `diagram-${name}.svg`);
    writeJson(json, { modelHash: hash, scope, options, layoutSource, readingSource, quality });
    writeFileSync(svg, diagramSvg(model, scope, { ...options, showPortNames: true }, hash, graph), { flag: 'wx' });
    results.push({ task: name, ok, report: fromOutput(json), svg: fromOutput(svg), geometry: quality.status,
      fidelity: quality.structuralFidelity.status, readability: quality.geometricReadability.status,
      crossings: quality.crossings, hiddenLabels: quality.hiddenLabels.length });
  }
  const bundle = cli<{ entry: string; modelHash: string; reviewStatus: string }>(cwd, 'bundle', ['bundle', 'reading']);
  assert.equal(bundle.value.modelHash, modelHash(model));
  assert.ok(bundle.value.entry && existsSync(bundle.value.entry));
  const guide = {
    modelHash: modelHash(model), humanReview: 'NOT_RUN', bundle: fromOutput(bundle.value.entry), reports: results,
    tasks: baseline.acceptance.readingTasks,
    transactionPath: axisStreamPath(model),
    anchors: {
      forward: ['s_axis_tdata', 'm_axis_tdata', 'm_axis_tlast', 'm_axis_tid', 'm_axis_tdest', 'm_axis_tuser'],
      reverse: ['m_axis_tready', 's_axis_tready'],
      storage: (model.localSignals ?? []).filter(s => s.driver.kind === 'register').map(s => s.id),
      backpressure: model.modules[0].contract.backpressure,
      reset: type ? { pins: ['clk', 'rst'], clears: (model.localSignals ?? []).flatMap(s =>
        s.driver.kind === 'register' && s.driver.update?.reset ? [s.id] : []) } : { pins: ['clk', 'rst'], clears: [] },
      keep: { output: 'm_axis_tkeep', source: config.parameters.KEEP_ENABLE ? (type ? 'm_axis_tkeep_reg' : 's_axis_tkeep') : 'constant_1' },
    },
  };
  writeJson(join(cwd, 'reading-tasks.json'), guide);
  return { status: results.every(r => r.ok) && bundle.exitCode === 0 ? 'PASS' : 'FAIL', ...guide };
}

function runFault(python: string, icarusBin: string): Result {
  const fault = baseline.fault;
  const config = baseline.configurations.find(c => c.id === fault.case)!;
  const pristineHash = baseline.files[rtl];
  const reference = axisModel(config, pristineHash);
  const fixture = (name: string, matched: boolean) => {
    const cwd = workspace(join(output, name));
    const path = join(cwd, fault.file);
    const lines = readFileSync(path, 'utf8').split('\n');
    assert.equal(lines[fault.line - 1], fault.before);
    lines[fault.line - 1] = fault.after;
    writeFileSync(path, lines.join('\n'));
    const sourceHash = sha256(path);
    assert.notEqual(sourceHash, pristineHash);
    const model = matched ? axisModel(config, sourceHash, true) : reference;
    saveModel(cwd, model);
    return { cwd, model, sourceHash };
  };
  const asBuilt = fixture('fault-as-built', true);
  const cwd = asBuilt.cwd;
  const simulation = 'original-test.json';
  const raw = fault.case + '/';
  writeJson(join(cwd, simulation), {
    schemaVersion: 1, name: 'Original cocotb scoreboard against single-bit fault', stage: 'simulation',
    moduleIds: [fault.moduleId], inputs: [...Object.keys(baseline.files), 'baseline.json', 'probe.py', simulation],
    inputClosure: { status: 'declared_complete', note: 'Frozen upstream files, acceptance and collector. Installed dependency versions are recorded by the collector.' },
    timeoutMs: 135_000,
    commands: [{ program: python, versionArgs: ['--version'],
      args: ['probe.py', 'upstream', '--fault', '--icarus-bin', icarusBin, '--out', '{runDir}'] }],
    checks: [
      ...['pytest.log', 'upstream-results.json', raw + 'axis_register.fst'].map(file => ({ kind: 'artifact', file })),
      ...['pytest.xml', raw + 'cocotb.xml'].map(file => ({ kind: 'junit', file })),
    ],
  });
  const failed = cli<Verification>(cwd, 'simulation', ['verify', simulation]);
  const runRecord = failed.value;
  assert.ok(failed.exitCode === 1 && runRecord.status === 'check_failed' && runRecord.basis.kind === 'as_built',
    `expected failed JUnit in rtlarch verify, see ${failed.log}.stdout`);
  const reports = readJson(join(runRecord.directory, 'upstream-results.json')) as Upstream;
  assert.equal(reports.exitCode, 1);
  assert.equal(reports.cases[fault.case]?.status, 'FAIL');
  assert.equal(reports.cases[fault.case]?.tests?.[fault.test], 'failure');
  const log = join(runRecord.directory, 'pytest.log');
  assert.ok(readFileSync(log, 'utf8').includes(fault.assertion), 'fixed scoreboard must fail its data assertion');
  const original = fixture('fault-reference', false);
  const compare = ({ cwd, model }: typeof original) => {
    const verify = elaborate(cwd, config);
    const definition = axisNetlist(readJson(join(verify.directory, 'netlist.json')));
    return observe(cwd, config, model, verify, definition);
  };
  const originalReport = compare(original);
  const faultReport = compare(asBuilt);
  const diff = originalReport.results.find(r => r.localSignalId === fault.state);
  assert.equal(originalReport.status, 'MISMATCH');
  assert.ok(diff?.status === 'MISMATCH' && diff.witness);
  assert.equal(BigInt(diff.witness.expected) ^ BigInt(diff.witness.actual), 1n << BigInt(fault.bit));
  assert.equal(faultReport.status, 'MATCH');
  assert.equal(original.sourceHash, asBuilt.sourceHash);
  assert.notEqual(modelHash(original.model), modelHash(asBuilt.model));

  const assurance = cli<Awaited<ReturnType<typeof readAssurance>>>(cwd, 'assurance', ['assurance', '--module', fault.moduleId]).value;
  const retained = assurance.runs.find(run => run.id === runRecord.id);
  assert.ok(retained?.fresh && retained.status === 'check_failed' && retained.moduleIds?.includes(fault.moduleId));
  assert.equal(assurance.stateObservation.status, 'MATCH');
  assert.notEqual(assurance.approval.status, 'APPROVED');
  assert.equal(assurance.requirements.find(r => r.id === fault.requirement)?.status, 'NO_CHECK');

  const association = {
    status: 'PASS' as const, case: fault.case, originalRequirement: { id: fault.requirement, verdict: 'FAIL', oracle: 'original_upstream_cocotb' },
    target: { moduleId: fault.moduleId, localSignalId: fault.state, interfaceId: fault.interface, bit: fault.bit },
    source: { file: fault.file, line: fault.line, pristineSha256: pristineHash, mutatedSha256: asBuilt.sourceHash },
    scoreboard: { test: fault.test, assertion: fault.assertion, log: fromOutput(log),
      run: fromOutput(join(runRecord.directory, 'run.json')), xml: fromOutput(join(runRecord.directory, raw, 'cocotb.xml')),
      inputs: reports.cases[fault.case] },
    reference: { status: originalReport.status, record: fromOutput(join(original.cwd, originalReport.record)), witness: diff.witness,
      modelHash: originalReport.modelHash },
    faultAsBuilt: { status: faultReport.status, record: fromOutput(join(cwd, faultReport.record)), modelHash: faultReport.modelHash,
      basis: faultReport.basis.kind, approval: assurance.approval.status, assurance: fromOutput(join(cwd, 'assurance.stdout')) },
  };
  writeJson(join(output, 'fault-association.json'), association);
  return association;
}

async function main() {
  const { values } = parseArgs({ options: {
    python: { type: 'string', default: 'python3.10' },
    'icarus-bin': { type: 'string' },
    fst2vcd: { type: 'string', default: 'fst2vcd' },
  } });
  const python = executable(values.python);
  const icarusBin = values['icarus-bin'] ? resolve(values['icarus-bin']) : dirname(executable('iverilog'));
  const fst2vcd = executable(values.fst2vcd);
  const runnerInputs = runnerDigests();
  const dimensions = [8, 16, 32].flatMap(width => [0, 1, 2].map(type => `${width}-${type}`));
  assert.deepEqual(baseline.configurations.map(c => `${c.parameters.DATA_WIDTH}-${c.parameters.REG_TYPE}`), dimensions);
  assert.deepEqual(baseline.configurations.map(c => c.id), dimensions);
  assert.equal(baseline.acceptance.denominator, dimensions.length);
  frozenFiles(join(frozen, 'upstream'));
  const cwd = workspace(join(output, 'upstream'));
  const upstreamDir = join(cwd, 'results');
  mkdirSync(upstreamDir);
  console.log(`Running original upstream pytest (nine configurations). Evidence: ${output}`);
  const first = run(cwd, python, ['probe.py', 'upstream', '--icarus-bin', icarusBin, '--out', upstreamDir], 'upstream-probe', 200_000);
  const upstreamFile = join(upstreamDir, 'upstream-results.json');
  const upstream = existsSync(upstreamFile) ? readJson(upstreamFile) as Upstream : undefined;
  const rows: Row[] = [];
  console.log('config\tupstream\tstructure\tstate\ttransaction\tnative\treading');
  for (const config of baseline.configurations) {
    const cwd = join(output, 'case-' + config.id);
    const test: Result = upstream?.cases[config.id] ?? { status: 'BLOCKED', reason: upstream?.error ?? `See ${first.log}.stderr` };
    let model: Model | undefined;
    const fixture = captured(() => {
      workspace(cwd);
      const candidate = axisModel(config, baseline.files[rtl]);
      saveModel(cwd, candidate);
      model = candidate;
      return { status: 'PASS' };
    });
    let state: Result = { status: 'NOT_RUN', reason: 'Current Yosys artifact unavailable.' };
    const structure = captured(() => {
      if (!model) return fixture;
      const verify = elaborate(cwd, config);
      const definition = axisNetlist(readJson(join(verify.directory, 'netlist.json')));
      state = captured(() => {
        const report = observe(cwd, config, model!, verify, definition);
        const vectors = baseline.acceptance.registerVectors[config.parameters.REG_TYPE];
        assert.equal(report.scope.stateCount, vectors);
        assert.equal(report.results.length, vectors);
        const info = { record: fromOutput(join(cwd, report.record)), vectors, mapped: report.results.length, observedStatus: report.status };
        if (vectors === 0) {
          assert.equal(report.status, 'UNKNOWN');
          return { status: 'NOT_APPLICABLE', boundary: 'PASS', reason: 'Pure combinational bypass. No register state to compare.', ...info };
        }
        return { status: report.status === 'MATCH' ? 'PASS' : report.status === 'MISMATCH' ? 'FAIL' : 'UNKNOWN', ...info,
          gaps: report.results.filter(r => r.status !== 'MATCH').map(r => ({ state: r.state, reason: r.reason })) };
      });
      return importStructure(cwd, config, model, verify, definition);
    });
    let originalSimulation: Verification | undefined;
    const transaction = captured(() => {
      if (!model) return fixture;
      if (test.status !== 'PASS') return { status: 'NOT_RUN', reason: 'No passing upstream waveform for this configuration.' };
      originalSimulation = convertUpstream(cwd, config, upstreamDir, python, fst2vcd);
      const artifact = join(originalSimulation.directory, 'transaction.json');
      const trace = readJson(artifact) as { status: Status; unpaused: { acceptToConsumeCycles: number }; nativeScenarios: unknown };
      return { status: trace.status, evidence: fromOutput(artifact), acceptToConsumeCycles: trace.unpaused.acceptToConsumeCycles, samples: trace.nativeScenarios };
    });
    const native = originalSimulation && model ? captured(() => nativeReplay(cwd, config, model!, originalSimulation!, python, icarusBin))
      : { status: 'NOT_RUN' as const, reason: 'Original waveform has no verified adaptation.' };
    let reading = fixture;
    if (model) {
      try { reading = await diagrams(cwd, config, model); }
      catch (error) { reading = { status: 'BLOCKED', reason: String(error) }; }
    }
    console.log([config.id, test.status, structure.status, state.status, transaction.status, native.status, reading.status].join('\t'));
    rows.push({ id: config.id, parameters: config.parameters, test, structure, state, transaction, reading, nativeReplay: native });
  }
  const fault = captured(() => runFault(python, icarusBin));
  const skidFault = captured(() => sidebandFault(python, icarusBin));
  frozenFiles(join(frozen, 'upstream'));
  frozenFiles(cwd);
  assert.deepEqual(runnerDigests(), runnerInputs, 'benchmark adapter changed during the run');
  const stages = ['test', 'structure', 'state', 'transaction', 'reading', 'nativeReplay'] as const;
  const tally = Object.fromEntries(stages.map(stage => [stage, {
    passed: rows.filter(r => r[stage].status === 'PASS').length, denominator: baseline.acceptance.denominator,
    statuses: Object.fromEntries([...new Set(rows.map(r => r[stage].status))].map(status => [status, rows.filter(r => r[stage].status === status).length])),
  }]));
  const passed = fault.status === 'PASS' && skidFault.status === 'PASS' && rows.every(row => stages.every(stage => row[stage].status === 'PASS'
    || stage === 'state' && row.state.status === 'NOT_APPLICABLE' && row.state.boundary === 'PASS'));
  const summary = join(output, 'summary.json');
  writeJson(summary, {
    schemaVersion: 2, finishedAt: new Date().toISOString(), repository: baseline.repository, commit: baseline.commit,
    frozenConfigurationSha256: lockHash, frozenInputs: baseline.files,
    runnerInputs,
    tools: { rtlArchitect: toolVersion, frontendBuild: existsSync(join(toolRoot, 'dist/build-info.json')) ? readJson(join(toolRoot, 'dist/build-info.json')) : null,
      node: process.version, npmUserAgent: process.env.npm_config_user_agent, upstream: upstream?.tools,
      fst2vcd: { executable: fst2vcd, sha256: sha256(fst2vcd) } },
    upstream: fromOutput(upstreamDir), seed: baseline.seed, denominator: baseline.acceptance.denominator,
    tally, humanReading: { passed: 0, denominator: baseline.acceptance.denominator, status: 'NOT_RUN' },
    nativeReplay: tally.nativeReplay,
    rows, fault, skidFault, passed,
  });
  console.log(`Fault evidence: ${fault.status}`);
  console.log(`Skid sideband fault: ${skidFault.status}`);
  console.log(`Summary: ${summary}`);
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(`Benchmark stopped: ${String(error)}. Evidence: ${output}`);
  process.exitCode = 1;
});
