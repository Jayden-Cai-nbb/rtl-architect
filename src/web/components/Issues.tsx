import {useMemo,useState} from 'react';
import type {Issue,Model} from '../../core/schema';
import {diagnosticGroups,issueModule} from '../../core/diagnostics';
import {EvidenceLinks} from './Evidence';
export {issueModule};
const labels:Record<string,string>={AS_BUILT_READ_ONLY:'现状模型暂不用于实现交接',PARTIAL_MODEL:'模型尚未完整',INCOMPLETE_COVERAGE:'实例路径待核对',SOURCE_UNRESOLVED:'源码冲突或未知',REQUIRED_UNCONNECTED:'模型中的连线缺口',OPEN_QUESTIONS:'行为约定待确认',DESIGN_OPEN_QUESTIONS:'设计问题待确认',RESET_RELEASE_UNKNOWN:'复位释放方式待确认',COVERAGE_DIMENSION:'覆盖范围待核对'};
const pageSize=30;
export function PageList<T>({items,render}:{items:T[];render:(item:T,index:number)=>React.ReactNode}){
 const [page,setPage]=useState(0),last=Math.max(0,Math.ceil(items.length/pageSize)-1),current=Math.min(page,last);
 return <>{items.slice(current*pageSize,(current+1)*pageSize).map((item,i)=>render(item,current*pageSize+i))}{items.length>pageSize&&<div className="pagination"><button disabled={!current} onClick={()=>setPage(current-1)}>上一页</button><span>{current+1} / {last+1} · 共 {items.length} 项</span><button disabled={current===last} onClick={()=>setPage(current+1)}>下一页</button></div>}</>;
}
function LazyDetails({summary,children,className}:{summary:React.ReactNode;children:()=>React.ReactNode;className:string}){
 const [open,setOpen]=useState(false);return <details className={className} open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>{summary}</summary>{open&&children()}</details>;
}
export function IssueList({model,issues,navigate}:{model:Model;issues:Issue[];navigate?:(id:string)=>void}){
 const groups=useMemo(()=>diagnosticGroups(model,issues),[model,issues]);
 return <div className="issue-groups"><p className="hint">共 {issues.length} 项。先选类别，再按模块、端口和索引范围查看；展开后每页最多 {pageSize} 项。</p><PageList items={groups} render={group=><LazyDetails key={group.key} className="issue-group" summary={<><strong>{group.key.startsWith('cause:')?group.label:labels[group.code]??group.label}</strong><span>{group.count} 项</span><small>{group.code}</small></>}>{()=> <PageList items={group.items} render={item=><LazyDetails key={item.key} className="issue-module" summary={<>{model.modules.find(m=>m.id===item.moduleId)?.name??item.moduleId}{item.interfaceId?` · ${item.interfaceId}`:''}{item.indexLabel?` · 索引 ${item.indexLabel}`:''} · {item.issues.length} 项</>}>{()=> <><p className="hint">所在层级：{item.scope??'见问题位置'}{navigate&&<button onClick={()=>navigate(item.moduleId)}>定位模块</button>}</p><PageList items={item.issues} render={(issue,n)=><div key={n} className="problem-row" data-testid="issue"><span className={`problem-severity ${issue.severity}`}>{issue.blocks.includes('commit')?'无法提交':'待核对'}</span><div><strong>{issue.message}</strong><small>{issue.target} · {issue.code}</small>{issue.location?.bits&&<small>待补位域：{issue.location.bits.map(b=>`[${b.msb}:${b.lsb}]`).join(', ')}</small>}{issue.evidenceIds&&<EvidenceLinks ids={issue.evidenceIds}/>}</div></div>}/></>}</LazyDetails>}/>}</LazyDetails>}/></div>;
}
