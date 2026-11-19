import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Model } from '../../core/schema';
import type { ReplayEvent, ReplayIssue, ReplayLocation } from '../../core/transactionReplay';
import type { StreamReplayResult } from '../../core/streamReplay';
import { replayAvailability, replayCapabilities } from '../../core/replayCapability';
import { makeSelection, selectionKey, selectionLabel, type SelectionTarget } from '../../core/selection';
import type { ReplayStaleReason, replayRecords, replayVerification } from '../../workspace/transactionReplay';
import { workSelection, type WorkbenchSnapshot } from '../../core/workbench';

const staleLabels: Record<ReplayStaleReason, string> = {
  CHECKER_VERSION: '回放检查器已升级。重新导入原轨迹可生成当前检查器的结果。',
  MODEL_CHANGED: '模型版本已变化。',
  PATH_CHANGED: '事务路径与历史记录不一致。',
  RUN_CHANGED: '原运行、输入或轨迹已变化或不可读。',
};
const matchLabel = (match: 'MATCH' | 'MISMATCH' | null) => match === 'MATCH' ? '匹配' : match === 'MISMATCH' ? '失配' : '未比较';
const edgeLabel = (edge: number, phase: 'pre' | 'post') => `E${edge}${phase === 'pre' ? '−' : '+'}`;

function ObservationLabel({ observation }: { observation: NonNullable<ReplayEvent['observation']> }) {
  return <span>{observation.phase === 'pre' ? '沿前' : '沿后'} valid {matchLabel(observation.valid)}，负载 {matchLabel(observation.data)}</span>;
}

type ReplayItem = ReplayEvent | ReplayIssue | StreamReplayResult['issues'][number];
function objectOf(item: ReplayItem): { scope: string; target: SelectionTarget } {
  if ('object' in item) return { scope: item.scope, target: item.object };
  return { scope: item.state.moduleId, target: { kind: 'local', id: item.state.localSignalId, ...('branch' in item && item.branch ? { branch: item.branch } : {}) } };
}
function objectName(item: ReplayItem) {
  const { scope, target } = objectOf(item);
  if (target.kind === 'local') return `${scope}.${target.id}`;
  return target.kind === 'boundary' ? `${scope}.${target.ports.join('、')}` : scope;
}

type Props = {
  model: Model;
  hash: string;
  scope: string;
  readOnly: boolean;
  locate: (scope: string, target: SelectionTarget, discuss?: boolean) => void;
  observe: (locations: ReplayLocation[]) => void;
  evidence: (id: string) => void;
};

const slotLabel = { output: '输出槽', temporary: '临时槽' };
const topology = { combinational_bypass: '组合旁路 · 零存储', registered_single_slot: '简单寄存 · 单槽', registered_skid: 'skid · 输出槽和临时槽' };
const rowsPerPage = 80;

function IndependentVerification({scope,hash,current}:{scope:string;hash:string;current:boolean}){
  const [runs,setRuns]=useState<Awaited<ReturnType<typeof replayVerification>>['runs']>();
  const [message,setMessage]=useState('');
  const [loading,setLoading]=useState(false);
  const load=async()=>{
    setLoading(true);setMessage('');
    try{
      const response=await api<Awaited<ReturnType<typeof replayVerification>>>('replay-verification?moduleId='+encodeURIComponent(scope));
      if(response.modelHash!==hash)throw new Error('模型版本已变化，请重新加载再查看核验证据。');
      setRuns(response.runs);
    }catch(error){setMessage(String(error));}
    finally{setLoading(false);}
  };
  return <section data-testid="replay-independent-verification">
    <p>可用独立 scoreboard 或定向仿真，保存 JUnit 和逐沿产物。</p>
    <code>rtlarch {replayCapabilities.independentVerification.command}</code>
    {current?<button disabled={loading} onClick={()=>void load()}>{loading?'读取中…':'查看独立仿真证据'}</button>:<p>请从已保存的对应模型查看运行记录。</p>}
    {message&&<p role="alert">{message}</p>}
    {runs&&(runs.length?<ul>{runs.map(run=><li key={run.id}>
      <strong>{run.name}</strong> · {run.status} · {run.fresh?'模型与输入仍匹配':'历史证据'} {run.record&&<code>{run.record}</code>}
    </li>)}</ul>:<p>当前范围尚无仿真运行记录。</p>)}
  </section>;
}

export function TransactionReplay({ model, hash, scope, readOnly, locate, observe, evidence }: Props) {
  const [data, setData] = useState<Awaited<ReturnType<typeof replayRecords>>>();
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<{ id: string; edge: number; event?: ReplayEvent }>();
  const [page, setPage] = useState(0);
  const [work, setWork] = useState<WorkbenchSnapshot>();
  const [semantics,setSemantics]=useState('');
  useEffect(() => {
    let active = true;
    setError('');
    void Promise.all([api<Awaited<ReturnType<typeof replayRecords>>>('replays'), api<WorkbenchSnapshot>('workbench')])
      .then(([r, w]) => { if (active) { setData(r); setWork(w); } })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; observe([]); };
  }, [hash, observe]);

  const records = data?.records.filter(r => 'result' in r) ?? [];
  const record = records.find(r => r.id === selection?.id) ?? records[0];
  const fresh = !readOnly && !!record?.fresh && record.modelHash === hash;
  const edge = selection && selection.id === record?.id ? selection.edge : 0;
  const event = selection && selection.id === record?.id ? selection.event : undefined;
  const path = record && model.modules.find(m => m.id === record.mapping.moduleId)?.contract.transactionPaths?.find(p => p.id === record.mapping.pathId);
  const object = event && objectOf(event);
  const selected = fresh && object ? makeSelection(model, hash, object.scope, object.target) : undefined;
  const state = object?.target.kind === 'local' ? model.localSignals?.find(s => s.scope === object.scope && s.id === ('id' in object.target ? object.target.id : null)) : undefined;
  const declaredBranch = object?.target.kind === 'local' ? object.target.branch : undefined;
  const threads = work?.workbench.threads.filter(t => {
    if (!selected) return false;
    const ref = workSelection(model, t.target);
    return ref && selectionKey({ ...ref, modelHash: hash }) === selectionKey(selected);
  }) ?? [];
  const result = record?.result;
  const availability=replayAvailability(model,scope,semantics||undefined);
  const stream = result && 'schemaVersion' in result ? result : undefined;
  const coverage = result?.coverage;
  const observations = result?.observations;
  const violation = result?.environment?.violation;
  const sampleIssue = result?.sampleIssue;
  const staleLabel = record?.staleReason ? staleLabels[record.staleReason] : staleLabels.MODEL_CHANGED;
  const evidenceIds = !path ? [] : path.semantics !== 'ordered_lossless_single_slot_stages' ? path.evidenceIds
    : event && 'stage' in event ? path.stages[event.stage]?.evidenceIds ?? [] : [];
  const pageCount = Math.ceil((result?.rows.length ?? 0) / rowsPerPage);
  const visiblePage = Math.min(page, Math.max(0, pageCount - 1));

  function selectEdge(row: NonNullable<typeof result>['rows'][number], event?: ReplayEvent) {
    setSelection({ id: record.id, edge: row.edge, event });
    observe(fresh ? row.locations : []);
  }

  return <section data-testid="transaction-replay">
    <h2>事务场景回放</h2>
    <p>accept 和 consume 记录沿前握手。T 编号按接受顺序分配。</p>
    {error && <p role="alert">{error}</p>}
    <p>显示 {records.length} 份 · 路径差异 {records.filter(r => r.result.issues.some(i => i.code !== 'UNKNOWN')).length} · 入口前提违规 {records.filter(r => r.result.environment?.violation).length} · 过期 {records.filter(r => !r.fresh || r.modelHash !== hash).length}</p>
    {data?.limited && <p>按创建时间显示最近 100 份记录。完整记录保留在 evidence/replays。</p>}
    <label>回放语义 <select value={semantics} onChange={event=>setSemantics(event.target.value)}>
      <option value="">当前模型</option>
      {replayCapabilities.supported.map(item=><option key={item.semantics} value={item.semantics}>{item.label}</option>)}
      {replayCapabilities.unsupported.map(item=><option key={item.semantics} value={item.semantics}>{item.label}</option>)}
    </select></label>
    {(availability.status!=='DECLARED'||!records.length)&&<p data-testid="replay-capability"><strong>{availability.status}</strong> · {availability.message}
      {availability.status==='UNSUPPORTED'&&availability.evidenceIds.map(id=><button key={id} onClick={()=>evidence(id)}>{id} ↗</button>)}</p>}
    {availability.status==='UNSUPPORTED'&&<IndependentVerification key={`${hash}/${scope}`} scope={scope} hash={hash} current={!readOnly&&data?.modelHash===hash}/>}
    {data?.records.map(r => 'error' in r && <p key={r.id}>{r.id} · UNKNOWN · {r.error}</p>)}
    {record && result && <>
      <label>事务回放记录 <select value={record.id} onChange={e => {
        setSelection({ id: e.target.value, edge: 0 });
        setPage(0);
        observe([]);
      }}>
        {records.map(r => <option key={r.id} value={r.id}>{r.createdAt} · {r.mapping.origin === 'manual' ? '人工推演' : '仿真观察'} · {r.assurance}</option>)}
      </select></label>
      <p><strong>{fresh ? record.assurance : 'STALE'} · {record.mapping.origin === 'manual' ? '人工推演' : '仿真产物'}</strong> · {fresh ? '回放核对' : '历史核对'} {result.status} · verify {record.verificationStatus}</p>
      {stream && <p data-testid="replay-topology">{topology[stream.semantics]}{stream.semantics === 'combinational_bypass' && ' · valid 与负载正向传递，ready 反向返回，复位期间仍透传'}</p>}
      <details><summary>版本、输入摘要与映射</summary><pre>{JSON.stringify({
        checkerVersion: record.checkerVersion ?? null, currentCheckerVersion: data?.checkerVersion,
        modelHash: record.modelHash, sourceDigest: record.sourceDigest,
        configuration: record.mapping.configuration, mapping: record.mapping,
      }, null, 2)}</pre></details>
      {!fresh && <p>{staleLabel}仅查看历史，当前结构定位已停用。</p>}
      {observations && <p data-testid="replay-observations"><strong>路径观察</strong> · valid 匹配 {observations.valid.matched}、失配 {observations.valid.mismatched} · 负载匹配 {observations.data.matched}、失配 {observations.data.mismatched}</p>}
      {stream && <details><summary>ready、启用字段和禁用常量</summary><dl>{Object.entries({ ready: stream.observations.ready, ...stream.observations.fields, 禁用常量: stream.observations.constants }).map(([name, counts]) =>
        <div key={name}><dt>{name}</dt><dd>匹配 {counts.matched}，失配 {counts.mismatched}</dd></div>)}</dl></details>}
      {result.environment && <p data-testid="replay-environment"><strong>入口前提</strong> · {
        violation ? `保持违规，E${violation.edge} 起停止路径归因`
          : result.environment.status === 'UNKNOWN' ? '采样不足，入口保持未核对完毕' : '所采样的入口保持符合约定'
      }</p>}
      {coverage && <p data-testid="replay-coverage"><strong>场景覆盖</strong> · 检查 {coverage.checkedEdges} 沿 · 复位 {coverage.resetEdges} 沿 · 接受 {coverage.accepted} · 消费 {coverage.consumed} · {stream ? '输出阻塞段' : '级内阻塞'} {coverage.blocked} · 恢复 {coverage.recovered} · 取消 {coverage.cancelled} · 在途 {result.inFlight.length} · 入口等待 {coverage.inputBlockedEdges} 沿、恢复握手 {coverage.inputRecovered} 次</p>}
      {stream && <p data-testid="replay-slot-coverage">峰值占用 {stream.coverage.peakOccupancy} 槽 · 同沿接受与消费 {stream.coverage.sameEdgeAcceptConsume} 次 · 最长输出阻塞 {stream.coverage.longestOutputStall} 沿
        {stream.semantics === 'registered_skid' && ` · 临时槽装载 ${stream.coverage.temporaryStores} 次、移入输出 ${stream.coverage.temporaryTransfers} 次，其中与旧输出同沿消费 ${stream.coverage.sameEdgeConsumeTransfer} 次`}
        {stream.semantics === 'combinational_bypass' && ` · 复位期间同沿握手 ${stream.coverage.resetHandshakes} 次`}</p>}
      {pageCount > 1 && <p><button disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>上一段</button> · {visiblePage + 1} / {pageCount} · <button disabled={visiblePage + 1 === pageCount} onClick={() => setPage(visiblePage + 1)}>下一段</button></p>}
      <div className="replay-rows"><table>
        <thead><tr><th>采样沿</th><th>沿前事件</th><th>沿后观察与跟踪位置</th><th>阻塞与诊断</th></tr></thead>
        <tbody>{result.rows.slice(visiblePage * rowsPerPage, (visiblePage + 1) * rowsPerPage).map(row => <tr key={row.edge} aria-selected={row.edge === edge}>
          <td><button onClick={() => selectEdge(row)}>E{row.edge}</button></td>
          {(['pre', 'post'] as const).map(phase => <td key={phase}>
            {row.events.filter(e => e.phase === phase).map((e, i) => <div key={i}>
              <button onClick={() => selectEdge(row, e)}>{e.kind} {e.transaction}</button>{'slot' in e && e.slot && <> · {e.from && `${slotLabel[e.from]} → `}{slotLabel[e.slot]}</>}
              {e.observation && <> · <ObservationLabel observation={e.observation}/></>}
            </div>)}
            {phase === 'post' && row.locations.map(l => <div key={l.transaction}>{l.transaction} → {l.state.moduleId}.{l.state.localSignalId} = {l.payload}</div>)}
          </td>)}
          <td>
            {row.inputBlocked && <div>入口等待 ready</div>}
            {row.blocked.map(i => <div key={i}>{stream ? '输出' : `级 ${i}`}阻塞 · valid=1，ready=0</div>)}
            {row.recovered?.map(i => <div key={i}>{stream ? '输出' : `级 ${i}`}恢复握手</div>)}
            {violation?.edge === row.edge && <p data-testid="replay-input-violation">
              {violation.code} · {edgeLabel(violation.edge, violation.phase)} · {violation.endpoint.moduleId}.{violation.endpoint.interfaceId} · E{violation.stalledAt} 开始等待 · 期望 {violation.expected}，观察 {violation.actual}
            </p>}
            {sampleIssue?.edge === row.edge && <p>{edgeLabel(sampleIssue.edge, sampleIssue.phase)} · {sampleIssue.message}</p>}
            {row.issues.map((i, n) => <p key={n}>
              {i.code} · {i.transaction ?? '身份未知'} · {edgeLabel(i.edge, i.phase)} · {objectName(i)} · 期望 {i.expected}，观察 {i.actual}
              {i.code !== 'UNKNOWN' && <button disabled={!fresh} onClick={() => { const object = objectOf(i); locate(object.scope, object.target); }}>在图中定位</button>}
            </p>)}
          </td>
        </tr>)}</tbody>
      </table></div>
      {event && object && <aside data-testid="replay-event-details">
        <strong>{event.transaction} · {edgeLabel(event.edge, event.phase)} · {event.kind}</strong>
        <p>{selected ? selectionLabel(model, selected) : objectName(event)}</p>
        {'fields' in event && <dl>{Object.entries(event.fields).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
        {event.observation && <p><ObservationLabel observation={event.observation}/></p>}
        {declaredBranch && <p>模型声明关联 {declaredBranch}。实际分支命中未核验。</p>}
        <button disabled={!fresh} onClick={() => locate(object.scope, object.target)}>{declaredBranch ? '查看声明分支' : '在图中定位'}</button>
        {fresh && state?.driver.kind === 'register' && <p>{state.driver.sourceText}</p>}
        {evidenceIds.map(id => <button key={id} disabled={!fresh} onClick={() => evidence(id)}>源码依据 {id}</button>)}
        <p>相关讨论 {threads.length} 项</p>
        {threads.map(t => <p key={t.id}>{t.title} · {t.target.modelHash === hash ? '当前版本' : '旧版本'}</p>)}
        <button disabled={!fresh} onClick={() => locate(object.scope, object.target, true)}>打开该对象的讨论</button>
      </aside>}
      <p>{fresh ? result.note : '历史核对结果保留供追溯。'} {result.unprocessed > 0 && `其后未处理 ${result.unprocessed} 沿。`}</p>
    </>}
  </section>;
}
