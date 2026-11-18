import {useEffect,useState} from 'react';
import {api} from '../api';
import type {Model} from '../../core/schema';
import type {ReplayEvent} from '../../core/transactionReplay';
import type {replayRecords} from '../../workspace/transactionReplay';
import type {WorkbenchSnapshot} from '../../core/workbench';
type Location={transaction:string;payload:string;state:{moduleId:string;localSignalId:string}};
export function TransactionReplay({model,hash,locate,observe,branch,evidence,discuss}:{model:Model;hash:string;locate:(id:string)=>void;observe:(locations:Location[])=>void;branch:(s:ReplayEvent['state'],branch:string|null)=>void;evidence:(id:string)=>void;discuss:(event:ReplayEvent)=>void}){
 const [data,setData]=useState<Awaited<ReturnType<typeof replayRecords>>>(),[error,setError]=useState(''),[id,setId]=useState(''),[edge,setEdge]=useState(0),[event,setEvent]=useState<ReplayEvent>(),[work,setWork]=useState<WorkbenchSnapshot>();
 useEffect(()=>{let active=true;void Promise.all([api<Awaited<ReturnType<typeof replayRecords>>>('replays'),api<WorkbenchSnapshot>('workbench')]).then(([r,w])=>{if(active){setData(r);setWork(w)}}).catch(e=>active&&setError(String(e)));return()=>{active=false;observe([])};},[hash]);
 const records=data?.records.filter(r=>'result' in r)??[],r=records.find(r=>r.id===id)??records[0],fresh=!!r&&r.fresh&&r.modelHash===hash;
 const row=r?.result.rows.find(row=>row.edge===edge)??r?.result.rows[0];
 const path=r&&model.modules.find(m=>m.id===r.mapping.moduleId)?.contract.transactionPaths?.find(p=>p.id===r.mapping.pathId);
 const state=event&&model.localSignals?.find(s=>s.scope===event.state.moduleId&&s.id===event.state.localSignalId);
 const threads=work?.workbench.threads.filter(t=>event&&t.target.moduleId===event.state.moduleId&&(!t.target.object||(t.target.object.kind==='local_state'&&t.target.object.id===event.state.localSignalId)||(t.target.object.kind==='update_branch'&&t.target.object.stateId===event.state.localSignalId&&t.target.object.id===event.branch)))??[];
 return <section data-testid="transaction-replay"><h2>事务场景回放</h2><p>accept / consume：沿前握手；visible：沿后稳定观察；cancel：复位沿撤销在途身份。T 编号按接受顺序追踪，不是 RTL 标签或自动计拍证明。</p>{error&&<p role="alert">{error}</p>}
 <p>已保存 {records.length} 份 · 失败轨迹 {records.filter(r=>r.result.status==='FAILED').length} · 过期 {records.filter(r=>!r.fresh||r.modelHash!==hash).length}</p>
 {data?.limited&&<p>本页最多列出 100 份记录，尚有未列出轨迹；不能据此判断全部运行。完整记录保留在 evidence/replays。</p>}
 {!records.length&&<p>尚无回放。先声明 contract.transactionPaths，再由 CLI replay 导入 verify 的显式 JSON 产物。</p>}
 {data?.records.filter(r=>!('result' in r)).map(r=><p key={r.id}>{r.id} · UNKNOWN · {'error' in r?r.error:''}</p>)}
 {r&&<><select aria-label="事务回放记录" value={r.id} onChange={e=>{setId(e.target.value);setEdge(0);setEvent(undefined);observe([])}}>{records.map(r=><option key={r.id} value={r.id}>{r.createdAt} · {r.mapping.origin==='manual'?'人工推演':'仿真观察'} · {r.assurance}</option>)}</select>
 <p><strong>{fresh?r.assurance:'STALE'} · {r.mapping.origin==='manual'?'人工推演，非仿真证据':'仿真产物'}</strong> · 运行 {r.mapping.runId} · 核对 {r.result.status} · verify {r.verificationStatus}</p><details><summary>版本、输入摘要与映射</summary><pre>{JSON.stringify({modelHash:r.modelHash,sourceDigest:r.sourceDigest,configuration:r.mapping.configuration,mapping:r.mapping},null,2)}</pre></details>
 {!fresh&&<p>旧模型、旧来源或候选：仅查看历史，已禁用当前结构定位。</p>}
 <div className="replay-rows"><table><thead><tr><th>采样沿</th><th>沿前事件</th><th>沿后可见核对 / 跟踪位置</th><th>阻塞与诊断</th></tr></thead><tbody>{r.result.rows.map(row=><tr key={row.edge} aria-selected={row.edge===edge}><td><button onClick={()=>{setEdge(row.edge);setEvent(undefined);observe(fresh?row.locations:[])}}>E{row.edge}</button></td><td>{row.events.filter(e=>e.phase==='pre').map((e,i)=><button key={i} onClick={()=>{setEdge(row.edge);setEvent(e);if(fresh){observe(row.locations);locate(e.state.moduleId)}}}>{e.kind} {e.transaction}{e.matched?'':'（未匹配）'}</button>)}</td><td>{row.events.filter(e=>e.phase==='post').map((e,i)=><button key={i} onClick={()=>{setEdge(row.edge);setEvent(e);if(fresh){observe(row.locations);locate(e.state.moduleId)}}}>{e.kind} {e.transaction}{e.matched?'':'（未匹配）'}</button>)}{row.locations.map(l=><div key={l.transaction}>{l.transaction} → {l.state.moduleId}.{l.state.localSignalId} = {l.payload}</div>)}</td><td>{row.blocked.map(i=><div key={i}>级 {i}：valid=1，ready=0</div>)}{row.issues.map((i,n)=><p key={n}>{i.code} · {i.transaction??'身份未知'} · E{i.edge}{i.phase==='pre'?'−':'+'} · {i.state.moduleId}.{i.state.localSignalId}：期望 {i.expected}，观察 {i.actual}<button disabled={!fresh} onClick={()=>branch(i.state,null)}>定位状态</button></p>)}</td></tr>)}</tbody></table></div>
 {event&&<aside><strong>{event.transaction} · E{event.edge}{event.phase==='pre'?'−':'+'} · {event.kind}</strong><p>关联声明分支 {event.branch??'消费事件不推断分支'}（声明关联，不是 RTL 分支自动提取）</p><button disabled={!fresh} onClick={()=>branch(event.state,event.branch)}>查看状态更新分支</button><p>{fresh&&state?.driver.kind==='register'?state.driver.sourceText:''}</p>{path?.stages[event.stage]?.evidenceIds.map(id=><button key={id} disabled={!fresh} onClick={()=>evidence(id)}>源码依据 {id}</button>)}<p>相关讨论 {threads.length} 项（精确状态/分支与旧模块记录）</p>{threads.map(t=><p key={t.id}>{t.title} · {t.target.modelHash===hash?'当前版本':'旧版本'}</p>)}<button disabled={!fresh} onClick={()=>discuss(event)}>打开该对象的讨论</button></aside>}
 <p>{r.result.note} 未处理记录 {r.result.unprocessed}；结束时在途 {r.result.inFlight.length}。当前 E{row?.edge}。</p></>}
 </section>;
}
