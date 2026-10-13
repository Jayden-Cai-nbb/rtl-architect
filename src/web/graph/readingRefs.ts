import type {Model,ScopeLayout} from '../../core/schema';
/** Validate display references even when a complete saved position set bypasses layout. */
export function validateReadingRefs(model:Model,scope:string,reading?:ScopeLayout['reading']){
 if(!reading)return;
 const ids=new Set([...model.modules.filter(m=>m.parent===scope).map(m=>m.id),...(model.localSignals??[]).filter(n=>n.scope===scope).map(n=>`local:${scope}:${n.id}`)]);
 const assigned=[...reading.mainPath,...reading.control,...reading.adjacent.map(a=>a.node)],stages=reading.stages??[],members=stages.flatMap(s=>s.nodes);
 if(new Set(assigned).size!==assigned.length||assigned.some(id=>!ids.has(id))||reading.adjacent.some(a=>!reading.mainPath.includes(a.anchor)))throw new Error('阅读布局含重复/非本层对象，或邻接锚点不在主行。');
 if(new Set(members).size!==members.length||members.some(id=>!ids.has(id))||new Set(stages.map(s=>s.id)).size!==stages.length)throw new Error('阅读分区含重复或不存在的对象；分区不会创建实例。');
}
