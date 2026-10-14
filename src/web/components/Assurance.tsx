import {useState} from 'react';
import {api} from '../api';
import type {assurance} from '../../workspace/assurance';
type Report=Awaited<ReturnType<typeof assurance>>;
type Behavior=Report['behavior'][number];
function StateEvidence({report:r}:{report:Report['stateObservation']}){
 const label:Record<string,string>={MATCH:'单步更新一致',MISMATCH:'单步更新有差异',UNKNOWN:'尚不能判断',STALE:'证据已过期',NOT_RUN:'尚未比较'};
 return <section aria-label="RTL 状态比较">
  <h4>RTL 状态比较 · {label[r.status]??r.status}</h4>
  <p className="hint">{r.reason}</p>
  <p>{r.basis.label} · 声明 {r.coverage.declared} 个状态：一致 {r.coverage.matched}，差异 {r.coverage.mismatched}，未知 {r.coverage.unknown}，过期 {r.coverage.stale}，未比较 {r.coverage.notRun}</p>
  {r.scope&&<p className="hint">本次参与比较的 RTL 作用域发现 {r.scope.stateCount} 个状态；未建模的状态仍不在声明比较范围内。{r.scope.truncated?'发现明细已达预算，存在截断。':''}</p>}
  {r.results?.map(item=><div className="interface-card" key={item.moduleId+'/'+item.localSignalId}>
   <strong>{item.moduleId}/{item.localSignalId}：{label[item.status]}</strong><p>{item.reason}</p><p className="hint">RTL：{item.instancePath.length?item.instancePath.join('/')+'/':''}{item.state} · {item.basis?.label??'无比较证据'}</p>
   {item.status==='MISMATCH'&&item.witness&&<>
    <p><strong>反例输入：</strong>{item.witness.inputs.filter(v=>v.kind==='input').map(v=>`${v.signal}=${v.value}`).join('，')||'无外部输入'}</p>
    <p><strong>沿前状态：</strong>{item.witness.inputs.filter(v=>v.kind==='state').map(v=>`${v.signal}=${v.value}`).join('，')||'不依赖旧状态'}</p>
    <p>下一拍：设计 <strong>{item.witness.expected}</strong>；RTL <strong>{item.witness.actual}</strong>。</p>
    <p className="hint">这是单步函数的反例；该旧状态能否实际到达尚未检查。</p>
   </>}
   {item.record&&<details><summary>本状态证据记录</summary><code>{item.record}</code></details>}
   {item.observed&&<details><summary>展开更新逻辑与源码位置</summary>
    <p>{item.observed.width} 位 · {item.observed.clock.edge==='rising'?'上升沿':'下降沿'} · <code>{item.observed.source??'来源位置未知'}</code></p>
    <p><code>{item.observed.expression.text}</code></p>
    {item.observed.expression.abbreviated&&<p className="hint">长表达式已缩略；完整逻辑网络保存在证据记录。</p>}
    <p className="hint">表达式用于阅读，完整位序、扩展/截断与符号参数保存在快照中。</p>
   </details>}
  </div>)}
  {r.record&&<details><summary>状态比较证据</summary><code>{r.record}</code></details>}
  <p className="hint">限定二态单步函数。未映射的状态、四态行为、初始状态与跨周期需求仍需核验。</p>
 </section>;
}
const labels:Record<string,string>={PASSED:'本次场景通过',FAILED:'最新运行失败',COVERAGE_INCOMPLETE:'覆盖不足',NOT_RUN:'未运行',INCONCLUSIVE:'证据不足',STALE:'已过期',UNKNOWN:'未知',MATCH:'映射范围匹配',MISMATCH:'结构不匹配',DRAFT:'草稿',APPROVED:'已记录批准',HIT:'已命中',UNTESTED:'未命中',UNREACHABLE:'常量规则证明不可达',NO_CHECK:'未关联检查',NOT_VERIFIED:'尚无已批准承诺的通过证据',SCENARIO_SUPPORTED:'关联义务在本次场景通过'};
function BehaviorEvidence({item:o}:{item:Behavior}){
 const coverage=o.coverage,next=o.nextSteps[0];
 return <div className="interface-card">
  <strong>{o.description}</strong>
  <p><strong>{o.basis.label}</strong> · {labels[o.status]??o.status}</p>
  <p className="hint">{o.basis.reason}。{o.reason}</p>
  <p>{o.requirements.length?o.requirements.map(r=>r.id+'：'+r.text).join('；'):'未关联需求；不代表需求验收通过。'}</p>
  {next&&<p className="coverage-next"><strong>下一步：{next.label}</strong><br/>{next.suggestion}{o.nextSteps.length>1&&<small> 另有 {o.nextSteps.length-1} 项待核对，可展开状态覆盖查看。</small>}</p>}
  {coverage&&<details>
   <summary>状态覆盖 · {coverage.goals.filter(g=>g.status==='HIT').length} 项命中 / {coverage.goals.filter(g=>g.required).length} 项需覆盖</summary>
   <ul>{coverage.goals.map(g=><li key={g.key}>
    <strong>{g.label}</strong>：{labels[g.status]}{g.hits!==null?`（${g.hits} 次）`:''}
    {g.status!=='HIT'&&<><br/><small>{g.reason}</small></>}
    {o.nextSteps.length>1&&o.nextSteps.find(s=>s.key===g.key)&&<p>{o.nextSteps.find(s=>s.key===g.key)!.suggestion}</p>}
   </li>)}</ul>
   <p className="hint">改变旧值的写入 {coverage.changedWrites??'未知'} 次；观察到状态变化 {coverage.observedTransitions??'未知'} 次。计数不是故障检测能力证明；优先级竞争仅检查已声明的分支对。</p>
  </details>}
  <small>{o.obligationId} · {o.kind}</small>
  {o.checkerFingerprint&&<details><summary>义务绑定指纹</summary><code>{o.checkerFingerprint}</code></details>}
  {o.record&&<p><code>{o.record}</code></p>}
 </div>;
}
export function Assurance({moduleId,modelHash,candidate}:{moduleId:string;modelHash:string;candidate:boolean}){
 const [report,setReport]=useState<Report>(),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const load=async()=>{
  setLoading(true);setError('');
  try{
   const r=await api<Report>('assurance?moduleId='+encodeURIComponent(moduleId));
   if(r.modelHash!==modelHash){setReport(undefined);setError('模型版本已变化，请重新加载页面。');}else setReport(r);
  }catch(e){setReport(undefined);setError(String(e));}finally{setLoading(false)}
 };
 return <details className="assurance" onToggle={e=>{if(e.currentTarget.open&&!report&&!loading&&!candidate)void load()}}>
  <summary>核验状态 · 审阅 / 结构 / 行为</summary>
  {candidate?<p className="hint">候选尚未保存，不能套用当前工作区的核验结果。</p>:<>
   <p className="hint">本地审阅记录不认证身份，也不代表 RTL 通过验证。</p>
   <button disabled={loading} onClick={()=>void load()}>{loading?'核对中…':'刷新证据'}</button>
   {error&&<p role="alert">{error}</p>}
   {report&&<>
    <p>架构审阅：{labels[report.approval.status]??report.approval.status}</p>
    <p>RTL 结构：<strong>{labels[report.structural.status]??report.structural.status}</strong></p>
    <p className="hint">{report.structural.reason}</p>
    {report.structural.record&&<code>{report.structural.record}</code>}
    <StateEvidence report={report.stateObservation}/>
    <h4>行为检查</h4>
    {!report.behavior.length?<p className="hint">尚未声明可执行验证义务；自然语言合同仍需逐项核对。</p>:report.behavior.map(o=><BehaviorEvidence key={o.obligationId} item={o}/>)}
    {report.requirements.length>0&&<details>
     <summary>需求追溯 · {report.requirements.filter(r=>r.status==='NO_CHECK').length} 项未关联检查</summary>
     <ul>{report.requirements.map(r=><li key={r.id}>{r.id}：{r.text}<br/><strong>{labels[r.status]}</strong><br/><small>验收：{r.acceptance}</small></li>)}</ul>
    </details>}
    <p className="hint">各项分别报告映射范围、单步函数及实际仿真场景；未自动发现全部构建依赖，不代表整个设计已验证。</p>
   </>}
  </>}
 </details>;
}
