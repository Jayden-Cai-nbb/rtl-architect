import type {Model,ScopeLayout} from '../../core/schema';
import {dependencyRelations} from './dependencies';
export function readingNodes(reading?:ScopeLayout['reading']):string[]{
 return reading?[...reading.mainPath,...reading.control,...reading.adjacent.flatMap(a=>[a.node,a.anchor]),...(reading.stages??[]).flatMap(s=>s.nodes),...(reading.parallel??[]).flatMap(s=>s.nodes),...(reading.shared??[]).flatMap(s=>[s.node,...s.clients]),...(reading.feedback??[]).flatMap(f=>[f.from,f.to])]:[];
}
/** Validate display references even when a complete saved position set bypasses layout. */
export function validateReadingRefs(model:Model,scope:string,reading?:ScopeLayout['reading']){
 if(!reading)return;
 const ids=new Set([...model.modules.filter(m=>m.parent===scope).map(m=>m.id),...(model.localSignals??[]).filter(n=>n.scope===scope).map(n=>`local:${scope}:${n.id}`)]);
 const assigned=[...reading.mainPath,...reading.control,...reading.adjacent.map(a=>a.node)],stages=reading.stages??[],members=stages.flatMap(s=>s.nodes);
 if(new Set(assigned).size!==assigned.length||assigned.some(id=>!ids.has(id))||reading.adjacent.some(a=>!reading.mainPath.includes(a.anchor)))throw new Error('阅读布局含重复/非本层对象，或邻接锚点不在主行。');
 if(new Set(members).size!==members.length||members.some(id=>!ids.has(id))||new Set(stages.map(s=>s.id)).size!==stages.length)throw new Error('阅读分区含重复或不存在的对象；分区不会创建实例。');
 if(readingNodes(reading).some(id=>!ids.has(id)))throw new Error('阅读约束引用不存在或非本层对象。');
 const parallel=reading.parallel??[],shared=reading.shared??[],feedback=reading.feedback??[],parallelNodes=parallel.flatMap(p=>p.nodes),sharedNodes=shared.map(s=>s.node);
 if(new Set(parallel.map(p=>p.id)).size!==parallel.length||new Set(parallelNodes).size!==parallelNodes.length)throw new Error('并排分支不能重复分组或重复成员。');
 const reserved=new Set([...reading.control,...reading.adjacent.map(a=>a.node),...sharedNodes]);
 if(parallelNodes.some(id=>reserved.has(id))||sharedNodes.some(id=>assigned.includes(id))||new Set(sharedNodes).size!==sharedNodes.length)throw new Error('并排、共享、控制和邻接位置约束冲突。');
 for(const group of parallel){
  if(group.nodes.filter(id=>reading.mainPath.includes(id)).length>1)throw new Error('同一并排组只能有一个主线锚点，不能又串行又并排。');
  const owners=new Set(group.nodes.map(id=>stages.find(s=>s.nodes.includes(id))?.id));
  if(owners.size>1)throw new Error('并排成员必须属于同一阅读分区，不能跨分区排列。');
 }
 if(sharedNodes.some(id=>members.includes(id)))throw new Error('跨使用方的共享资源应放在分区外，不能同时归入阅读分区。');
 const orderedStages=reading.mainPath.flatMap(id=>{const i=stages.findIndex(s=>s.nodes.includes(id));return i<0?[]:[i];});
 if(orderedStages.slice(1).some((n,i)=>n<orderedStages[i]))throw new Error('主线与阅读分区顺序冲突；请修正约束。');
 if(!shared.length&&!feedback.length)return;
 const endpoint=(e:{moduleId:string;interfaceId:string;local?:boolean})=>e.local?`local:${scope}:${e.interfaceId}`:e.moduleId;
 const pairs=new Set([...model.connections.filter(c=>c.scope===scope),...dependencyRelations(model,scope)].map(r=>`${endpoint(r.from)}>${endpoint(r.to)}`));
 if(new Set(feedback.map(f=>`${f.from}>${f.to}`)).size!==feedback.length||feedback.some(f=>!pairs.has(`${f.from}>${f.to}`)))throw new Error('返回路径必须引用唯一、真实存在的有向连接或表达式依赖。');
 for(const s of shared)if(new Set(s.clients).size!==s.clients.length||s.clients.some(c=>c===s.node||reserved.has(c)||!pairs.has(`${c}>${s.node}`)&&!pairs.has(`${s.node}>${c}`)))throw new Error('共享资源的使用方必须唯一、位于主图并与资源直接相连。');
}
