import { z } from 'zod';
import { resolveWidth } from './endpoints';
import { widthValue } from './parameters';
import { idSchema, type Model, type SignalValue, type StateUpdate, type StreamTransactionPath } from './schema';
import { stateCoverage } from './stateCoverage';
import type { SelectionTarget } from './selection';
import type { ReplaySamples, ReplayStatus } from './transactionReplay';

export const replayMappingSource = {
  moduleId: idSchema, pathId: idSchema, origin: z.enum(['simulation', 'manual']),
  runId: idSchema, artifact: z.string().min(1), configuration: z.string().min(1),
};
export const streamReplayMappingSchema = z.strictObject({
  schemaVersion: z.literal(2), ...replayMappingSource,
  ports: z.record(idSchema, z.string().min(1)), states: z.record(idSchema, z.string().min(1)),
});
export type StreamReplayMapping = z.infer<typeof streamReplayMappingSchema>;

export function transactionLoadBranchIssue(update: StateUpdate, branch: string, state: string) {
  const index = update.branches.findIndex(b => b.id === branch);
  if (index < 0) return `装载分支不存在：${state}.${branch}`;
  const goal = stateCoverage(update).find(g => g.key === 'branch' + index);
  if (goal?.reachability === 'unreachable') return `装载分支不可达：${state}.${branch}（${goal.reason}）`;
}

const forwarded = (path: StreamTransactionPath) => path.fields.filter(f => f.constant === undefined);
const slotsOf = (path: StreamTransactionPath) => path.semantics === 'combinational_bypass' ? []
  : path.semantics === 'registered_single_slot' ? [path.output] : [path.output, path.temporary];

export function streamPathIssues(model: Model, owner: string, path: StreamTransactionPath): string[] {
  const errors: string[] = [];
  const m = model.modules.find(m => m.id === owner);
  if (!m || m.kind !== 'subsystem' || m.instances) return ['v2 事务路径须位于一个明确的非数组子系统作用域'];
  if (path.semantics !== 'combinational_bypass') {
    const clock = model.clocks.find(c => c.id === m.clock);
    const reset = model.resets.find(r => r.id === m.reset);
    if (clock?.id !== path.clock.id || clock.edge !== path.clock.edge || !reset?.synchronous ||
        reset.clock !== clock.id || reset.activeLevel !== path.reset.activeLevel) errors.push('仅支持同一时钟域和明确同步复位的寄存路径');
  }
  const lookupPorts = new Map(m.interfaces.map(p => [p.id, p]));
  const ports = new Set<string>();
  const port = (id: string, role: 'consumer' | 'producer', width: number) => {
    const p = lookupPorts.get(id);
    if (ports.has(id)) errors.push(`端口角色重复：${owner}.${id}`);
    ports.add(id);
    if (p?.role !== role || p.protocol !== 'signal' || resolveWidth(m, p, model) !== width) errors.push(`端口、方向或位宽不匹配：${owner}.${id}`);
  };
  port(path.reset.interfaceId, 'consumer', 1);
  port(path.ingress.valid, 'consumer', 1);
  port(path.ingress.ready, 'producer', 1);
  port(path.egress.valid, 'producer', 1);
  port(path.egress.ready, 'consumer', 1);
  if (new Set(path.fields.map(f => f.id)).size !== path.fields.length || !forwarded(path).some(f => f.id === 'data')) {
    errors.push('负载字段须唯一且含透传 data');
  }
  for (const f of path.fields) {
    port(f.input, 'consumer', f.width);
    port(f.output, 'producer', f.width);
    if (f.constant !== undefined && BigInt(f.constant) >= (1n << BigInt(f.width))) errors.push(`禁用字段常量超宽：${f.id}`);
  }

  const locals = new Map(model.localSignals?.filter(s => s.scope === owner).map(s => [s.id, s]));
  const states = new Set<string>();
  const register = (id: string, width: number, clears = false, branches: string[] = []) => {
    if (states.has(id)) errors.push(`槽位或控制状态重复使用：${owner}.${id}`);
    states.add(id);
    const s = locals.get(id);
    if (s?.driver.kind !== 'register' || !s.driver.update) {
      errors.push(`未声明寄存状态更新：${owner}.${id}`);
      return;
    }
    try {
      if (widthValue(model, m, s.width) !== width) errors.push(`状态位宽不匹配：${owner}.${id}`);
    } catch (error) { errors.push(`无法解析状态位宽：${owner}.${id}（${String(error)}）`); }
    const reset = s.driver.update.reset;
    if (clears && (!reset || reset.activeLevel !== path.reset.activeLevel || reset.signal.local || reset.signal.slice ||
        reset.signal.sliceMapping || reset.signal.index !== undefined || reset.signal.moduleId !== owner ||
        reset.signal.interfaceId !== path.reset.interfaceId || reset.value.kind !== 'constant' || BigInt(reset.value.value) !== 0n)) {
      errors.push(`复位须把 ready 或 valid 清零：${owner}.${id}`);
    }
    for (const branch of branches) {
      const issue = transactionLoadBranchIssue(s.driver.update, branch, `${owner}.${id}`);
      if (issue) errors.push(issue);
    }
  };
  if (path.semantics !== 'combinational_bypass') {
    register(path.readyState, 1, true);
    for (const slot of slotsOf(path)) {
      register(slot.validState, 1, true);
      const fields = forwarded(path);
      if (Object.keys(slot.fields).length !== fields.length || fields.some(f => !Object.hasOwn(slot.fields, f.id))) {
        errors.push(`槽位须逐一映射全部启用字段：${slot.validState}`);
      }
      const branches = [slot.loadInputBranch];
      if (path.semantics === 'registered_skid' && slot === path.output) {
        if (path.output.loadTemporaryBranch === slot.loadInputBranch) errors.push('输入和临时槽必须关联不同的输出装载分支');
        branches.push(path.output.loadTemporaryBranch);
      }
      for (const field of fields) if (slot.fields[field.id]) register(slot.fields[field.id], field.width, false, branches);
    }
  }

  const fullEndpoint = (e: Model['connections'][number]['to']) => e.moduleId === owner && !e.slice && !e.sliceMapping && e.index === undefined;
  const wires = new Map(path.connectionIds.map(id => [id, model.connections.find(c => c.id === id && c.scope === owner)]));
  if (wires.size !== path.connectionIds.length || [...wires.values()].some(c => !c)) errors.push('连接引用须唯一且均属于路径作用域');
  const driver = (id: string) => {
    const sources = [...wires.values()].filter(c => c && fullEndpoint(c.to) && !c.to.local && c.to.interfaceId === id);
    const origin = sources.length === 1 ? sources[0]?.from : undefined;
    return origin && fullEndpoint(origin) ? origin : undefined;
  };
  const route = (id: string, source: string, storage: boolean) => {
    const from = driver(id);
    const local = from?.local ? locals.get(from.interfaceId)?.driver : undefined;
    const value = local?.kind === 'comb' ? local.value : undefined;
    const e = value?.kind === 'endpoint' ? value.endpoint : undefined;
    const matches = storage ? from?.local && from.interfaceId === source
      : (!from?.local && from?.interfaceId === source) || (e && fullEndpoint(e) && !e.local && e.interfaceId === source);
    if (!matches) errors.push(`端到端路径缺少明确的${storage ? '状态' : '直连'}来源：${id} ← ${source}`);
  };
  const bypass = path.semantics === 'combinational_bypass';
  route(path.ingress.ready, bypass ? path.egress.ready : path.readyState, !bypass);
  route(path.egress.valid, bypass ? path.ingress.valid : path.output.validState, !bypass);
  for (const f of path.fields) {
    if (f.constant === undefined) route(f.output, bypass ? f.input : path.output.fields[f.id], !bypass);
    else {
      const from = driver(f.output);
      const s = from?.local ? locals.get(from.interfaceId)?.driver : undefined;
      const value: SignalValue | undefined = s?.kind === 'comb' ? s.value : undefined;
      if (value?.kind !== 'constant' || value.width !== f.width || BigInt(value.value) !== BigInt(f.constant)) {
        errors.push(`禁用字段缺少已声明的输出常量：${f.output}`);
      }
    }
  }
  for (const id of path.evidenceIds) if (!model.provenance?.evidence.some(e => e.id === id)) errors.push(`源码依据不存在：${id}`);
  return errors;
}

export function readReplaySample(row: ReplaySamples['rows'][number], phase: 'pre' | 'post', key: string, width: number) {
  const value = row[phase][key];
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error(`未知采样值 ${phase}.${key}`);
  const n = BigInt(value);
  if (n >= 1n << BigInt(width)) throw new Error(`采样值超宽 ${phase}.${key}`);
  return n;
}

type Phase = 'pre' | 'post';
type Slot = 'output' | 'temporary';
type Fields = Record<string, string>;
type HeldInput = { edge: number; fields: Fields };
type Beat = { valid: boolean; fields: Fields };
type PortBeat = Beat & { ready: boolean };
type Token = { id: string; payload: string; fields: Fields };
type Target = Extract<SelectionTarget, { kind: 'boundary' | 'local' }>;
type Observation = { phase: Phase; valid: 'MATCH' | 'MISMATCH'; data: 'MATCH' | 'MISMATCH' | null };
type Counts = { matched: number; mismatched: number };
type Issue = {
  code: string; edge: number; phase: Phase; transaction: string | null; object: Target; scope: string;
  field?: string; expected: string; actual: string;
};
type InputViolation = {
  code: 'INPUT_VALID_DROPPED' | 'INPUT_PAYLOAD_CHANGED'; edge: number; phase: Phase; stalledAt: number;
  endpoint: { moduleId: string; interfaceId: string }; field?: string; expected: string; actual: string;
};
export type StreamReplayEvent = {
  kind: 'accept' | 'visible' | 'consume' | 'cancel' | 'store' | 'transfer'; phase: Phase; edge: number;
  transaction: string; payload: string; fields: Fields; scope: string; object: Target; slot?: Slot; from?: Slot;
  observation?: Observation | null;
};
type Location = { transaction: string; payload: string; fields: Fields; state: { moduleId: string; localSignalId: string }; slot: Slot };
type Row = {
  edge: number; events: StreamReplayEvent[]; locations: Location[]; blocked: number[]; issues: Issue[];
  inputBlocked?: boolean; recovered?: number[]; reset?: boolean;
};

function replayColumns(path: StreamTransactionPath, mapping: StreamReplayMapping) {
  const ports = [path.reset.interfaceId, path.ingress.valid, path.ingress.ready, path.egress.valid, path.egress.ready,
    ...path.fields.flatMap(f => f.constant === undefined ? [f.input, f.output] : [f.output])];
  const states = path.semantics === 'combinational_bypass' ? [] : [path.readyState, ...slotsOf(path).flatMap(s => [s.validState, ...Object.values(s.fields)])];
  for (const [kind, ids] of [['ports', ports], ['states', states]] as const) {
    const columns = mapping[kind];
    if (Object.keys(columns).length !== ids.length || ids.some(id => !Object.hasOwn(columns, id))) {
      throw new Error(`映射须逐一对应当前路径声明的 ${kind}`);
    }
  }
  const columns = [...Object.values(mapping.ports), ...Object.values(mapping.states)];
  if (new Set(columns).size !== columns.length) throw new Error('每个观察角色须使用独立映射列');
}

/** Replay the finite one-scope v2 transport. Identities are allocated at actual input handshakes. */
export function replayStream(path: StreamTransactionPath, mapping: StreamReplayMapping, samples: ReplaySamples, checkerVersion: number) {
  if (samples.clock.id !== path.clock.id || samples.clock.edge !== path.clock.edge) throw new Error('产物采样时钟/有效边沿与声明不符');
  replayColumns(path, mapping);
  const scope = mapping.moduleId, fields = forwarded(path), slotDescriptions = slotsOf(path);
  const bypass = path.semantics === 'combinational_bypass';
  const skid = path.semantics === 'registered_skid';
  const slots: [Token | null, Token | null] = [null, null];
  const names = ['output', 'temporary'] as const;
  const state = (id: string, branch?: string): Target => ({ kind: 'local', id, ...(branch ? { branch } : {}) });
  const port = (id: string, role: 'consumer' | 'producer'): Target => ({ kind: 'boundary', role, ports: [id] });
  const data = fields.find(f => f.id === 'data')!;
  const inputData = port(data.input, 'consumer'), outputData = port(data.output, 'producer');
  const count = (): Counts => ({ matched: 0, mismatched: 0 });
  const observations = { valid: count(), data: count(), ready: count(), constants: count(), fields: Object.fromEntries(fields.map(f => [f.id, count()])) };
  const coverage = {
    checkedEdges: 0, resetEdges: 0, accepted: 0, outputHandshakes: 0, consumed: 0, cancelled: 0, inputBlockedEdges: 0, inputRecovered: 0,
    blocked: 0, recovered: 0, peakOccupancy: 0, temporaryStores: 0, temporaryTransfers: 0, sameEdgeConsumeTransfer: 0,
    sameEdgeAcceptConsume: 0, sameEdgeOutputReplacement: 0, resetHandshakes: 0, consecutiveAccepts: 0,
    continuousInputEdges: 0, sameDataSuccessors: 0, sameBeatSuccessors: 0, longestOutputStall: 0,
  };
  const events: StreamReplayEvent[] = [], issues: Issue[] = [], rows: Row[] = [];
  let sampleIssue: { edge: number; phase: Phase; message: string } | null = null;
  let violation: InputViolation | null = null;
  let held: HeldInput | null = null;
  let previousInput: HeldInput | null = null;
  let previousValid = false, expectedReady = false, stallRun = 0;
  const resetLevel = path.reset.activeLevel === 'high' ? 1n : 0n;

  for (const row of samples.rows) {
    const { edge } = row;
    const entry: Row = { edge, events: [], locations: [], blocked: [], recovered: [], issues: [] };
    rows.push(entry);
    let phase: Phase = 'pre';
    const p = (at: Phase, id: string, width = 1) => {
      phase = at;
      return readReplaySample(row, at, mapping.ports[id], width);
    };
    const beat = (valid: boolean, read: (f: typeof data) => bigint): Beat => ({
      valid, fields: Object.fromEntries(valid ? fields.map(f => [f.id, read(f).toString()]) : []),
    });
    const source = (at: Phase, checkOffer: boolean, checkReady = true): PortBeat => ({
      ready: checkReady && p(at, path.ingress.ready) === 1n,
      ...beat(checkOffer && p(at, path.ingress.valid) === 1n, f => p(at, f.input, f.width)),
    });
    const snapshot = (at: Phase, reset: boolean, src: PortBeat) => {
      phase = at;
      const s = (id: string, width = 1) => readReplaySample(row, at, mapping.states[id], width);
      const checkState = !(at === 'pre' && reset && !bypass);
      return {
        reset, src,
        dst: { ready: checkState && p(at, path.egress.ready) === 1n, ...beat(checkState && p(at, path.egress.valid) === 1n, f => p(at, f.output, f.width)) },
        readyState: !bypass && checkState && s(path.readyState) === 1n,
        banks: checkState ? slotDescriptions.map(slot => beat(s(slot.validState) === 1n, f => s(slot.fields[f.id], f.width))) : [],
        constants: path.fields.flatMap(f => f.constant === undefined ? [] : [{ field: f, value: p(at, f.output, f.width).toString() }]),
      };
    };
    const heldBefore: HeldInput | null = held;
    const checkInput = (expected: HeldInput, actual: PortBeat, phase: Phase): InputViolation | null => {
      const difference = fields.find(f => expected.fields[f.id] !== actual.fields[f.id]);
      if (actual.valid && !difference) return null;
      const f = actual.valid ? difference : undefined;
      return {
        code: f ? 'INPUT_PAYLOAD_CHANGED' : 'INPUT_VALID_DROPPED', edge, phase, stalledAt: expected.edge,
        endpoint: { moduleId: scope, interfaceId: f?.input ?? path.ingress.valid },
        ...(f ? { field: f.id } : {}), expected: f ? expected.fields[f.id] : '1', actual: f ? actual.fields[f.id] : '0',
      };
    };
    let pre: ReturnType<typeof snapshot>, post: ReturnType<typeof snapshot>;
    try {
      const preReset = p('pre', path.reset.interfaceId) === resetLevel;
      if (!bypass && edge === 0 && !preReset) throw new Error('E0 未观察到复位，初始事务身份未知');
      const preSource = source('pre', bypass || !preReset, bypass || !preReset);
      entry.reset = preReset;
      entry.inputBlocked = !preReset && preSource.valid && !preSource.ready;
      if (!preReset && heldBefore) violation = checkInput(heldBefore, preSource, 'pre');
      if (violation) break;

      const postReset = p('post', path.reset.interfaceId) === resetLevel;
      held = entry.inputBlocked && !postReset ? heldBefore ?? { edge, fields: preSource.fields } : null;
      const postSource = source('post', bypass || held !== null);
      if (held) violation = checkInput(held, postSource, 'post');
      if (violation) break;

      pre = snapshot('pre', preReset, preSource);
      post = snapshot('post', postReset, postSource);
    } catch (error) { sampleIssue = { edge, phase, message: (error as Error).message }; break; }

    coverage.checkedEdges++;
    if (pre.reset) {
      coverage.resetEdges++;
      previousInput = null;
      stallRun = 0;
    }
    if (entry.inputBlocked) coverage.inputBlockedEdges++;
    if (!pre.reset && pre.src.valid && previousValid) coverage.continuousInputEdges++;
    previousValid = !pre.reset && pre.src.valid;

    const issue = (code: string, phase: Phase, object: Target, t: Token | null, expected: string, actual: string, field?: string) => {
      const item: Issue = { code, edge, phase, transaction: t?.id ?? null, object, scope, expected, actual, ...(field ? { field } : {}) };
      entry.issues.push(item);
      issues.push(item);
    };
    const event = (kind: StreamReplayEvent['kind'], phase: Phase, t: Token, object: Target,
      extra: Pick<StreamReplayEvent, 'slot' | 'from' | 'observation'> = {}) => {
      const item = { kind, phase, edge, transaction: t.id, payload: t.payload, fields: t.fields, scope, object, ...extra };
      entry.events.push(item);
      events.push(item);
    };
    const compare = (phase: Phase, expected: Beat, actual: Beat,
      t: Token | null, validTarget: Target, fieldTarget: (f: typeof data) => Target, retained = false): Observation => {
      const matches = expected.valid === actual.valid;
      observations.valid[matches ? 'matched' : 'mismatched']++;
      if (!matches) issue('VALID_PHASE', phase, validTarget, t, String(expected.valid), String(actual.valid));
      if (!expected.valid || !actual.valid) return { phase, valid: matches ? 'MATCH' : 'MISMATCH', data: null };
      let payloadMatches = true;
      for (const f of fields) {
        const same = expected.fields[f.id] === actual.fields[f.id];
        observations.fields[f.id][same ? 'matched' : 'mismatched']++;
        if (same) continue;
        payloadMatches = false;
        issue(retained ? 'BLOCKED_PAYLOAD_OVERWRITE' : 'PAYLOAD_MISMATCH', phase, fieldTarget(f), t, expected.fields[f.id], actual.fields[f.id], f.id);
      }
      observations.data[payloadMatches ? 'matched' : 'mismatched']++;
      return { phase, valid: 'MATCH', data: payloadMatches ? 'MATCH' : 'MISMATCH' };
    };
    const compareReady = (phase: Phase, actual: boolean, expected: boolean, target: Target) => {
      observations.ready[actual === expected ? 'matched' : 'mismatched']++;
      if (actual !== expected) issue('READY_PHASE', phase, target, null, String(expected), String(actual));
    };
    const constants = (phase: Phase, snap: typeof pre) => {
      for (const { field: f, value } of snap.constants) {
        const expected = BigInt(f.constant!).toString();
        observations.constants[value === expected ? 'matched' : 'mismatched']++;
        if (value !== expected) issue('DISABLED_FIELD_CONSTANT', phase, port(f.output, 'producer'), null, expected, value, f.id);
      }
    };
    const input = (bypass || !pre.reset) && pre.src.valid && pre.src.ready
      ? { id: `T${coverage.accepted}`, payload: pre.src.fields.data, fields: pre.src.fields } : null;
    if (input) {
      coverage.accepted++;
      if (heldBefore && !pre.reset) coverage.inputRecovered++;
      if (previousInput?.edge === edge - 1) coverage.consecutiveAccepts++;
      if (previousInput?.fields.data === input.payload) coverage.sameDataSuccessors++;
      if (previousInput && fields.every(f => previousInput!.fields[f.id] === input.fields[f.id])) coverage.sameBeatSuccessors++;
      previousInput = { edge, fields: input.fields };
      event('accept', 'pre', input, inputData);
    }
    const consuming = (bypass || !pre.reset) && pre.dst.valid && pre.dst.ready;
    if (consuming) coverage.outputHandshakes++;
    const blocked = (bypass || !pre.reset) && pre.dst.valid && !pre.dst.ready;
    if (blocked) {
      if (stallRun++ === 0) coverage.blocked++;
      coverage.longestOutputStall = Math.max(coverage.longestOutputStall, stallRun);
      entry.blocked.push(0);
    } else {
      if (consuming && stallRun) { coverage.recovered++; entry.recovered!.push(0); }
      stallRun = 0;
    }

    const expectBeat = (t: Token | null) => ({ valid: t !== null, fields: t?.fields ?? {} });
    const oldOutput = slots[0], oldTemporary = slots[1];
    const retained = (phase: Phase, t: Token | null, old: Token | null) =>
      phase === 'post' && !pre.reset && !pre.dst.ready && t !== null && t.id === old?.id;
    const output = (phase: Phase, expected: Beat, actual: typeof pre, t: Token | null) =>
      compare(phase, expected, actual.dst, t, port(path.egress.valid, 'producer'), f => port(f.output, 'producer'), retained(phase, t, oldOutput));
    constants('pre', pre);
    constants('post', post);
    const srcReady = port(path.ingress.ready, 'producer');
    if (bypass) {
      const observed = output('pre', pre.src, pre, input);
      output('post', post.src, post, null);
      compareReady('pre', pre.src.ready, pre.dst.ready, srcReady);
      compareReady('post', post.src.ready, post.dst.ready, srcReady);
      if (input && pre.dst.valid) event('visible', 'pre', input, outputData, { observation: observed });
      if (input && consuming) {
        event('consume', 'pre', input, outputData, { observation: observed });
        coverage.consumed++;
        coverage.sameEdgeAcceptConsume++;
        if (pre.reset) coverage.resetHandshakes++;
      }
      continue;
    }

    const bank = (phase: Phase, snap: typeof pre, i: number, t: Token | null, branch?: string) => {
      const slot = slotDescriptions[i];
      return compare(phase, expectBeat(t), snap.banks[i], t, state(slot.validState), f => state(slot.fields[f.id], branch),
        retained(phase, t, i === 0 ? oldOutput : oldTemporary));
    };
    if (pre.reset) {
      expectedReady = false;
      slotDescriptions.forEach((slot, i) => {
        const observed = bank('post', post, i, null);
        const t = slots[i];
        if (t) {
          event('cancel', 'post', t, state(slot.validState, 'reset'), { slot: names[i], observation: observed });
          if (observed.valid === 'MATCH') coverage.cancelled++;
        }
        slots[i] = null;
      });
      output('post', expectBeat(null), post, null);
    } else {
      const before = output('pre', expectBeat(oldOutput), pre, oldOutput);
      slotDescriptions.forEach((_, i) => bank('pre', pre, i, slots[i]));
      compareReady('pre', pre.src.ready, expectedReady, srcReady);
      compareReady('pre', pre.readyState, expectedReady, state(path.readyState));
      if (consuming && oldOutput) {
        event('consume', 'pre', oldOutput, state(path.output.fields.data), { slot: 'output', observation: before });
        coverage.consumed++;
        if (input) coverage.sameEdgeAcceptConsume++;
      }
      let fromTemporary = false;
      let attached: Slot | undefined;
      if (pre.src.ready) {
        if (!skid || pre.dst.ready || !oldOutput) {
          if (oldOutput && !pre.dst.ready) issue('OCCUPIED_OVERWRITE', 'pre', state(path.output.validState), oldOutput, '保持在途事务', '装载输出槽');
          slots[0] = input;
          if (input) attached = 'output';
        } else {
          if (oldTemporary) issue('OCCUPIED_OVERWRITE', 'pre', state(path.temporary.validState), oldTemporary, '保持在途事务', '装载临时槽');
          slots[1] = input;
          if (input) attached = 'temporary';
        }
      } else if (pre.dst.ready) {
        slots[0] = oldTemporary;
        slots[1] = null;
        fromTemporary = oldTemporary !== null;
      }
      expectedReady = skid ? pre.dst.ready || (!oldTemporary && (!oldOutput || !pre.src.valid)) : !slots[0];
      const after = output('post', expectBeat(slots[0]), post, slots[0]);
      const loadOutput = skid && fromTemporary ? path.output.loadTemporaryBranch : attached === 'output' ? path.output.loadInputBranch : undefined;
      const observed = slotDescriptions.map((slot, i) => bank('post', post, i, slots[i],
        i === 0 ? loadOutput : attached === 'temporary' ? slot.loadInputBranch : undefined));
      if (attached === 'output' && input) {
        event('visible', 'post', input, state(path.output.fields.data, path.output.loadInputBranch), { slot: 'output', observation: after });
        if (consuming && oldOutput) coverage.sameEdgeOutputReplacement++;
      }
      if (skid && attached === 'temporary' && input) {
        event('store', 'post', input, state(path.temporary.fields.data, path.temporary.loadInputBranch), { slot: 'temporary', observation: observed[1] });
        if (observed[1].valid === 'MATCH') coverage.temporaryStores++;
      }
      if (skid && fromTemporary && oldTemporary) {
        event('transfer', 'post', oldTemporary, state(path.output.fields.data, path.output.loadTemporaryBranch),
          { slot: 'output', from: 'temporary', observation: after });
        if (after.valid === 'MATCH' && observed[0].valid === 'MATCH' && observed[1].valid === 'MATCH') {
          coverage.temporaryTransfers++;
          if (consuming && oldOutput) coverage.sameEdgeConsumeTransfer++;
        }
      }
    }
    compareReady('post', post.src.ready, expectedReady, srcReady);
    compareReady('post', post.readyState, expectedReady, state(path.readyState));
    coverage.peakOccupancy = Math.max(coverage.peakOccupancy, post.banks.filter(b => b.valid).length);
    entry.locations = slotDescriptions.flatMap((slot, i) => {
      const t = slots[i];
      return t ? [{ transaction: t.id, payload: t.payload, fields: t.fields, state: { moduleId: scope, localSignalId: slot.fields.data }, slot: names[i] }] : [];
    });
  }
  const status: ReplayStatus = violation ? 'ENVIRONMENT_VIOLATION' : issues.length ? 'FAILED'
    : sampleIssue ? 'UNKNOWN' : coverage.accepted ? 'OBSERVED' : 'COVERAGE_INCOMPLETE';
  return {
    schemaVersion: 2 as const, checkerVersion, semantics: path.semantics,
    status, events, issues, rows, observations, sampleIssue,
    environment: { status: violation ? 'VIOLATED' as const : sampleIssue ? 'UNKNOWN' as const : 'CHECKED' as const, violation },
    coverage, unprocessed: samples.rows.length - rows.length, inFlight: slots.filter(t => t !== null),
    note: '只核对当前采样的传输、槽位和启用字段。分支为模型声明关联。OBSERVED 不等于形式证明。',
  };
}

export type StreamReplayResult = ReturnType<typeof replayStream>;
