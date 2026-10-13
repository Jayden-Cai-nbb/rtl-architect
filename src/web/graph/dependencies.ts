import type {Endpoint,Model} from '../../core/schema';
import {driverReads,endpointLabel} from '../../core/signals';
import {interfaceGroup,type GroupInfo} from '../../core/inspection';

export type DependencyRelation={id:string;localId:string;from:Endpoint;to:Endpoint;fromGroup:string;toGroup:string;group:GroupInfo;endpoints:Endpoint[];labels:string[]};
/** A reading bundle is a set of recorded dependencies, never a new physical net. */
export function dependencyRelations(model:Model,scope:string,detail=false):DependencyRelation[]{
 const result=new Map<string,DependencyRelation>();
 for(const local of (model.localSignals??[]).filter(s=>s.scope===scope)){
  for(const endpoint of new Map(driverReads(local).map(e=>[endpointLabel(e),e])).values()){
   const group=interfaceGroup(model,endpoint);
   const source=endpoint.local?`local:${scope}:${endpoint.interfaceId}`:endpoint.moduleId;
   // Auxiliary/unknown groups retain identity. Only declared business categories may combine.
   const bucket=detail?endpointLabel(endpoint):group.auxiliary||group.category==='other'||(endpoint.moduleId===scope&&!endpoint.local)?group.id:group.category;
   const id=`dependency:${source}>${local.id}/${bucket}`;
   const item=result.get(id)??{id,localId:local.id,from:endpoint,to:{moduleId:scope,interfaceId:local.id,local:true},fromGroup:endpoint.moduleId===scope&&!endpoint.local?group.id:`dep:${id}`,toGroup:`dep:${id}`,group:{...group,id},endpoints:[],labels:[]};
   item.endpoints.push(endpoint);
   const label=endpoint.local?endpoint.interfaceId:group.label;
   if(!item.labels.includes(label))item.labels.push(label);
   result.set(id,item);
  }
 }
 return [...result.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(item=>{
  item.endpoints.sort((a,b)=>endpointLabel(a).localeCompare(endpointLabel(b)));item.labels.sort();
  const category:Record<string,string>={data:'数据',control:'控制',request:'请求',response:'响应',writeback:'写回'};
  const label=item.labels.length===1?item.labels[0]:`${category[item.group.category]??'信号'}依赖`;
  return {...item,group:{...item.group,label:label+(item.endpoints.length>1?` · ${item.endpoints.length} 项`:'')}};
 });
}
