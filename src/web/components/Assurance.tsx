import {useState} from 'react';
import {api} from '../api';
import type {assurance} from '../../workspace/assurance';
type Report=Awaited<ReturnType<typeof assurance>>;
const labels:Record<string,string>={PASSED:'本次场景通过',FAILED:'最新运行失败',NOT_RUN:'未运行',INCONCLUSIVE:'证据不足',STALE:'已过期',UNKNOWN:'未知',MATCH:'映射范围匹配',MISMATCH:'结构不匹配',DRAFT:'草稿',APPROVED:'已记录批准'};
export function Assurance({moduleId,modelHash,candidate}:{moduleId:string;modelHash:string;candidate:boolean}){
 const [report,setReport]=useState<Report>(),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const load=async()=>{setLoading(true);setError('');try{const r=await api<Report>('assurance?moduleId='+encodeURIComponent(moduleId));if(r.modelHash!==modelHash){setReport(undefined);setError('模型版本已变化，请重新加载页面。');}else setReport(r);}catch(e){setReport(undefined);setError(String(e));}finally{setLoading(false)}};
 return <details className="assurance" onToggle={e=>{if(e.currentTarget.open&&!report&&!loading&&!candidate)void load()}}><summary>核验状态 · 审阅 / 结构 / 行为</summary>{candidate?<p className="hint">候选尚未保存，不能套用当前工作区的核验结果。</p>:<><p className="hint">本地审阅记录不认证身份，也不代表 RTL 通过验证。</p><button disabled={loading} onClick={()=>void load()}>{loading?'核对中…':'刷新证据'}</button>{error&&<p role="alert">{error}</p>}{report&&<><p>架构审阅：{labels[report.approval.status]??report.approval.status}</p><p>RTL 结构：<strong>{labels[report.structural.status]??report.structural.status}</strong></p><p className="hint">{report.structural.reason}</p>{report.structural.record&&<code>{report.structural.record}</code>}<h4>行为承诺</h4>{!report.behavior.length?<p className="hint">尚未声明可执行验证义务；自然语言合同仍需逐项核对。</p>:report.behavior.map(o=><div className="interface-card" key={o.obligationId}><strong>{o.description}</strong><p>{labels[o.status]??o.status} · {o.reason}</p><small>{o.obligationId} · {o.kind}</small>{o.record&&<p><code>{o.record}</code></p>}</div>)}<p className="hint">仅覆盖显式映射和实际运行场景；未自动发现全部构建依赖，不是形式证明。</p></>}</>}</details>;
}
