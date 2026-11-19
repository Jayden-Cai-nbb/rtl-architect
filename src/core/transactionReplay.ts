import { z } from 'zod';
import { resolveWidth } from './endpoints';
import { widthValue } from './parameters';
import { idSchema, transactionClockSchema, type LegacyTransactionPath, type Model, type StreamTransactionPath, type TransactionPath } from './schema';
import { readReplaySample, replayMappingSource, replayStream, streamPathIssues, streamReplayMappingSchema,
  transactionLoadBranchIssue, type StreamReplayEvent, type StreamReplayMapping, type StreamReplayResult } from './streamReplay';

export const REPLAY_CHECKER_VERSION = 3;
const legacyReplayMappingSchema = z.strictObject({
  schemaVersion: z.literal(1), ...replayMappingSource,
  reset: z.string().min(1),
  points: z.array(z.strictObject({
    model: z.strictObject({ moduleId: idSchema, data: idSchema, valid: idSchema, ready: idSchema }),
    data: z.string().min(1), valid: z.string().min(1), ready: z.string().min(1),
  })).min(2).max(9),
});
export const replayMappingSchema = z.discriminatedUnion('schemaVersion', [legacyReplayMappingSchema, streamReplayMappingSchema]);
const sample = z.record(z.string().min(1), z.string().max(80).nullable());
export const replaySamplesSchema = z.strictObject({
  format: z.enum(['rtlarch-rv-samples-v1', 'rtlarch-rv-samples-v2']),
  clock: transactionClockSchema,
  sampling: z.literal('pre_edge_handshake_post_edge_settled'),
  rows: z.array(z.strictObject({ edge: z.number().int().nonnegative().max(1000000), pre: sample, post: sample })).min(1).max(4096),
});
export type ReplayMapping = z.infer<typeof replayMappingSchema>;
type LegacyReplayMapping = z.infer<typeof legacyReplayMappingSchema>;
export type ReplaySamples = z.infer<typeof replaySamplesSchema>;

export function transactionPathIssues(model: Model, owner: string, path: TransactionPath) {
  if (path.semantics !== 'ordered_lossless_single_slot_stages') return streamPathIssues(model, owner, path);
  const errors: string[] = [];
  const clock = model.clocks.find(c => c.id === path.clock);
  const reset = model.resets.find(r => r.id === path.reset);
  if (!clock || !reset?.synchronous || reset.clock !== path.clock) errors.push('仅支持明确单时钟、同步复位');
  const seen = new Set<string>();
  for (const stage of path.stages) {
    for (const [ref, width] of [[stage.dataState, path.width], [stage.validState, 1]] as const) {
      const key = `${ref.moduleId}.${ref.localSignalId}`;
      if (seen.has(key)) errors.push('状态被重复用作事务保存位置');
      seen.add(key);
      const m = model.modules.find(m => m.id === ref.moduleId);
      const local = model.localSignals?.find(s => s.scope === ref.moduleId && s.id === ref.localSignalId);
      if (!m || m.instances || m.clock !== path.clock || m.reset !== path.reset || local?.driver.kind !== 'register' || !local.driver.update) {
        errors.push(`状态未明确映射或不在同一域：${key}`);
        continue;
      }
      try {
        const resolved = widthValue(model, m, local.width);
        if (resolved !== width) errors.push(`${key} 的位宽为 ${resolved}，事务路径要求 ${width}`);
      } catch (error) {
        errors.push(`无法解析 ${key} 的位宽：${String(error)}`);
      }
    }
    const data = model.localSignals?.find(s => s.scope === stage.dataState.moduleId && s.id === stage.dataState.localSignalId);
    if (data?.driver.kind === 'register' && data.driver.update) {
      const issue = transactionLoadBranchIssue(data.driver.update, stage.loadBranch, `${data.scope}.${data.id}`);
      if (issue) errors.push(issue);
    }
    const valid = model.localSignals?.find(s => s.scope === stage.validState.moduleId && s.id === stage.validState.localSignalId);
    if (valid?.driver.kind === 'register') {
      const r = valid.driver.update?.reset;
      if (!r || r.activeLevel !== reset?.activeLevel || r.value.kind !== 'constant' || BigInt(r.value.value) !== 0n) {
        errors.push('cancel_all 需要有效状态明确复位为 0');
      }
    }
    if (stage.dataState.moduleId !== stage.validState.moduleId) errors.push('data/valid 必须属于同一个状态作用域');
    for (const id of stage.evidenceIds) if (!model.provenance?.evidence.some(e => e.id === id)) errors.push(`源码依据不存在：${id}`);
    // The engine rejects cycles separately. This traversal only checks ownership.
    let moduleId: string | null = stage.dataState.moduleId;
    for (let n = 0; moduleId && moduleId !== owner && n <= model.modules.length; n++) {
      moduleId = model.modules.find(m => m.id === moduleId)?.parent ?? null;
    }
    if (moduleId !== owner) errors.push('状态不在声明模块内');
  }
  if (new Set(path.connectionIds).size !== path.connectionIds.length) errors.push('连接引用重复');
  for (const id of path.connectionIds) if (!model.connections.some(l => l.id === id)) errors.push(`连接不存在：${id}`);
  return errors;
}

type Phase = 'pre' | 'post';
type StateRef = LegacyTransactionPath['stages'][number]['dataState'];
type Match = 'MATCH' | 'MISMATCH';
type Observation = { phase: Phase; valid: Match; data: Match | null };
type Token = { id: string; payload: string };
type Beat = { valid: boolean; ready: boolean; data: string };
type HeldInput = { edge: number; payload: string };
export type ReplayLocation = { transaction: string; payload: string; state: StateRef };
type LegacyReplayEvent = {
  kind: 'accept' | 'visible' | 'consume' | 'cancel';
  phase: Phase;
  edge: number;
  transaction: string;
  payload: string;
  stage: number;
  state: StateRef;
  branch: string | null;
  observation?: Observation | null;
};
export type ReplayEvent = LegacyReplayEvent | StreamReplayEvent;
export type ReplayIssue = {
  code: string; edge: number; phase: Phase; transaction: string | null; stage: number; state: StateRef; expected: string; actual: string;
};
type InputViolation = {
  code: 'INPUT_VALID_DROPPED' | 'INPUT_PAYLOAD_CHANGED';
  edge: number; phase: Phase; stalledAt: number;
  endpoint: { moduleId: string; interfaceId: string };
  expected: string; actual: string;
};
type SampleIssue = { edge: number; phase: Phase; message: string };
type ReplayRow = {
  edge: number; events: LegacyReplayEvent[]; locations: ReplayLocation[]; blocked: number[]; issues: ReplayIssue[];
  inputBlocked?: boolean; recovered?: number[];
};
export type ReplayStatus = 'OBSERVED' | 'FAILED' | 'UNKNOWN' | 'COVERAGE_INCOMPLETE' | 'ENVIRONMENT_VIOLATION';

function inputViolation(held: HeldInput, beat: Beat, endpoint: LegacyReplayMapping['points'][number]['model'], edge: number, phase: Phase): InputViolation | undefined {
  if (beat.valid && held.payload === beat.data) return;
  return {
    code: beat.valid ? 'INPUT_PAYLOAD_CHANGED' : 'INPUT_VALID_DROPPED',
    edge, phase, stalledAt: held.edge,
    endpoint: { moduleId: endpoint.moduleId, interfaceId: beat.valid ? endpoint.data : endpoint.valid },
    expected: beat.valid ? held.payload : '1',
    actual: beat.valid ? beat.data : '0',
  };
}

export function replayTransactions(model: Model, path: LegacyTransactionPath, mapping: LegacyReplayMapping, samples: ReplaySamples): LegacyReplayResult;
export function replayTransactions(model: Model, path: StreamTransactionPath, mapping: StreamReplayMapping, samples: ReplaySamples): StreamReplayResult;
export function replayTransactions(model: Model, path: TransactionPath, mapping: ReplayMapping, samples: ReplaySamples): ReplayResult;
export function replayTransactions(model: Model, path: TransactionPath, mapping: ReplayMapping, samples: ReplaySamples): ReplayResult {
  if (mapping.pathId !== path.id) throw new Error('映射路径 ID 与声明不符');
  if (samples.rows.some((row, index) => row.edge !== index)) throw new Error('首沿必须 E0，记录必须连续；不允许省略采样沿');
  const pathIssues = transactionPathIssues(model, mapping.moduleId, path);
  if (pathIssues.length) throw new Error(pathIssues.join('；'));
  if (path.semantics === 'ordered_lossless_single_slot_stages' && mapping.schemaVersion === 1 && samples.format === 'rtlarch-rv-samples-v1') {
    return replayStages(model, path, mapping, samples);
  }
  if (path.semantics !== 'ordered_lossless_single_slot_stages' && mapping.schemaVersion === 2 && samples.format === 'rtlarch-rv-samples-v2') {
    return replayStream(path, mapping, samples, REPLAY_CHECKER_VERSION);
  }
  throw new Error('事务路径、采样文件和映射的格式版本必须一致');
}

/** A bounded FIFO identity scoreboard over the legacy explicit single-slot stages. */
function replayStages(model: Model, path: LegacyTransactionPath, mapping: LegacyReplayMapping, samples: ReplaySamples) {
  if (samples.clock.id !== path.clock || samples.clock.edge !== model.clocks.find(c => c.id === path.clock)?.edge) {
    throw new Error('产物采样时钟/有效边沿与声明不符');
  }
  if (mapping.points.length !== path.stages.length + 1) throw new Error('映射点数必须是保存级数 + 1');
  for (const [i, point] of mapping.points.entries()) {
    const m = model.modules.find(m => m.id === point.model.moduleId);
    if (!m || m.instances || m.clock !== path.clock || m.id !== (i === 0 ? mapping.moduleId : path.stages[i - 1].dataState.moduleId)) {
      throw new Error('观察点须显式对应路径入口与每级输出的同域模块');
    }
    for (const role of ['data', 'valid', 'ready'] as const) {
      const p = m.interfaces.find(p => p.id === point.model[role]);
      if (!p || p.protocol !== 'signal' || resolveWidth(m, p, model) !== (role === 'data' ? path.width : 1) ||
          p.role !== ((i === 0) === (role === 'ready') ? 'producer' : 'consumer')) {
        throw new Error(`观察点接口/方向/位宽未匹配：${m.id}.${point.model[role]}`);
      }
    }
  }
  const keys = [mapping.reset, ...mapping.points.flatMap(p => [p.data, p.valid, p.ready])];
  if (new Set(keys).size !== keys.length) throw new Error('每个观察角色须使用独立映射列');
  const resetLevel = model.resets.find(r => r.id === path.reset)!.activeLevel === 'high' ? 1n : 0n;
  let slots: (Token | null)[] = path.stages.map(() => null);
  const stalled = new Map<number, string>();
  const blockedIds = new Set<string>();
  const recoveredIds = new Set<string>();
  let heldInput: HeldInput | undefined;
  let violation: InputViolation | undefined;
  let sampleIssue: SampleIssue | undefined;
  const issues: ReplayIssue[] = [], events: LegacyReplayEvent[] = [], rows: ReplayRow[] = [];
  const observations = { valid: { matched: 0, mismatched: 0 }, data: { matched: 0, mismatched: 0 } };
  const coverage = { checkedEdges: 0, resetEdges: 0, accepted: 0, consumed: 0, cancelled: 0, inputBlockedEdges: 0, inputRecovered: 0 };

  for (const row of samples.rows) {
    const { edge } = row;
    const entry: ReplayRow = { edge, events: [], locations: [], blocked: [], issues: [] };
    rows.push(entry);
    let phase: Phase = 'pre';
    const read = (at: Phase, key: string, width: number) => {
      phase = at;
      return readReplaySample(row, at, key, width);
    };
    const points = (at: Phase) => mapping.points.map(p => ({
      valid: read(at, p.valid, 1) === 1n, ready: read(at, p.ready, 1) === 1n, data: read(at, p.data, path.width).toString(),
    }));
    let reset: boolean, pre: Beat[], post: Beat[];
    try {
      reset = read('pre', mapping.reset, 1) === resetLevel;
      if ((read('post', mapping.reset, 1) === resetLevel) !== reset) throw new Error('同一沿前后复位变化超出同步回放范围');
      phase = 'pre';
      if (edge === 0 && !reset) throw new Error('E0 未观察到复位，初始事务身份未知');
      pre = points('pre');
      post = points('post');
    } catch (error) {
      sampleIssue = { edge, phase, message: (error as Error).message };
      break;
    }

    const previouslyHeld = heldInput;
    entry.inputBlocked = !reset && pre[0].valid && !pre[0].ready;
    if (reset) {
      heldInput = undefined;
    } else {
      const source = mapping.points[0].model;
      if (previouslyHeld) violation = inputViolation(previouslyHeld, pre[0], source, edge, 'pre');
      heldInput = entry.inputBlocked ? previouslyHeld ?? { edge, payload: pre[0].data } : undefined;
      if (!violation && heldInput) violation = inputViolation(heldInput, post[0], source, edge, 'post');
      // An invalid offered beat invalidates identity tracking from this edge onward.
      if (violation) break;
    }
    coverage.checkedEdges++;
    if (entry.inputBlocked) coverage.inputBlockedEdges++;

    const issue = (code: string, phase: Phase, stage: number, t: Token | null, expected: string, actual: string) => {
      const { dataState, validState } = path.stages[stage];
      const item = { code, edge, phase, stage, transaction: t?.id ?? null, state: code === 'VALID_PHASE' ? validState : dataState, expected, actual };
      issues.push(item);
      entry.issues.push(item);
    };
    const addEvent = (kind: LegacyReplayEvent['kind'], t: Token, stage: number, observation: Observation | null = null) => {
      const { dataState, validState, loadBranch } = path.stages[stage];
      const event: LegacyReplayEvent = {
        kind, phase: kind === 'visible' ? 'post' : 'pre', edge, transaction: t.id, payload: t.payload, stage,
        state: kind === 'cancel' ? validState : dataState,
        branch: kind === 'cancel' ? 'reset' : kind === 'visible' ? loadBranch : null,
        observation,
      };
      events.push(event);
      entry.events.push(event);
    };
    const compare = (phase: Phase, stage: number, expected: Token | null, actual: Beat): Observation => {
      const valid = actual.valid === (expected !== null);
      observations.valid[valid ? 'matched' : 'mismatched']++;
      if (!valid) issue('VALID_PHASE', phase, stage, expected, String(expected !== null), String(actual.valid));
      if (!expected || !actual.valid) return { phase, valid: valid ? 'MATCH' : 'MISMATCH', data: null };
      const data = actual.data === expected.payload;
      observations.data[data ? 'matched' : 'mismatched']++;
      if (!data) {
        const retained = phase === 'post' && entry.blocked.includes(stage) && slots[stage]?.id === expected.id;
        issue(retained ? 'BLOCKED_PAYLOAD_OVERWRITE' : 'PAYLOAD_MISMATCH', phase, stage, expected, expected.payload, actual.data);
      }
      return { phase, valid: valid ? 'MATCH' : 'MISMATCH', data: data ? 'MATCH' : 'MISMATCH' };
    };

    const next = slots.slice();
    if (reset) {
      coverage.resetEdges++;
      stalled.clear();
      slots.forEach((token, i) => {
        next[i] = null;
        const observed = compare('post', i, null, post[i + 1]);
        if (token) {
          addEvent('cancel', token, i, observed);
          if (observed.valid === 'MATCH') coverage.cancelled++;
        }
      });
    } else {
      const moves = pre.map(p => p.valid && p.ready);
      const before = slots.map((token, i) => compare('pre', i, token, pre[i + 1]));
      entry.recovered = [];
      slots.forEach((token, i) => {
        const p = pre[i + 1];
        if (p.valid && !p.ready) entry.blocked.push(i);
        const wasStalled = stalled.get(i);
        stalled.delete(i);
        if (!token || before[i].data !== 'MATCH') return;
        if (!p.ready) {
          stalled.set(i, token.id);
          blockedIds.add(token.id);
        } else if (wasStalled === token.id) {
          recoveredIds.add(token.id);
          entry.recovered!.push(i);
        }
      });
      const input = moves[0] ? { id: `T${coverage.accepted}`, payload: pre[0].data } : null;
      if (input) {
        coverage.accepted++;
        if (previouslyHeld) coverage.inputRecovered++;
        addEvent('accept', input, 0);
      }
      const last = slots.length - 1;
      const consumed = slots[last];
      if (moves[last + 1] && consumed) {
        coverage.consumed++;
        addEvent('consume', consumed, last, before[last]);
      }
      for (let i = 0; i < slots.length; i++) {
        if (moves[i + 1]) next[i] = null;
        let arriving: Token | null = null;
        if (moves[i]) {
          arriving = i === 0 ? input : slots[i - 1];
          if (next[i]) issue('OCCUPIED_OVERWRITE', 'pre', i, next[i], '保持在途事务', '新的输入握手');
          if (!arriving) issue('UNIDENTIFIED_TRANSFER', 'pre', i, null, '已接受的事务', '无身份的上游传输');
          next[i] = arriving;
        }
        const observed = compare('post', i, next[i], post[i + 1]);
        if (arriving) addEvent('visible', arriving, i, observed);
      }
    }
    slots = next;
    entry.locations = slots.flatMap((token, i) => token ? [{ transaction: token.id, payload: token.payload, state: path.stages[i].dataState }] : []);
  }
  const status: ReplayStatus = violation ? 'ENVIRONMENT_VIOLATION' : issues.length ? 'FAILED'
    : sampleIssue ? 'UNKNOWN' : coverage.accepted ? 'OBSERVED' : 'COVERAGE_INCOMPLETE';
  return {
    checkerVersion: REPLAY_CHECKER_VERSION,
    status,
    events, issues, rows, observations, sampleIssue: sampleIssue ?? null,
    environment: {
      status: violation ? 'VIOLATED' as const : sampleIssue ? 'UNKNOWN' as const : 'CHECKED' as const,
      violation: violation ?? null,
    },
    coverage: { ...coverage, blocked: blockedIds.size, recovered: recoveredIds.size },
    unprocessed: samples.rows.length - rows.length,
    inFlight: slots.filter(token => token !== null),
    note: '该记录核对本次采样轨迹上的有序单槽传输。分支仅为声明关联。OBSERVED 不等于形式证明。',
  };
}

export type LegacyReplayResult = ReturnType<typeof replayStages>;
export type ReplayResult = LegacyReplayResult | StreamReplayResult;
