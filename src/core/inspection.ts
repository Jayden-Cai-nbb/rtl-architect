import type {Endpoint,Link,Model} from './schema';
import {driverReads,expandLink} from './signals';
import {resolveEndpoint} from './endpoints';
import {connectionFacts} from './connectivity';
export type Inspection = {kind:'module';id:string}|{kind:'connection';ids:string[];index?:{moduleId:string;index:number}}|{kind:'array';id:string;index:number}|{kind:'local';id:string}|{kind:'boundary';role:'consumer'|'producer';groupId?:string};
export type GroupInfo={id:string;label:string;category:string;description:string;auxiliary:boolean};
export function interfaceGroup(model:Model,endpoint:Endpoint):GroupInfo{
 const module=model.modules.find(m=>m.id===endpoint.moduleId),port=module?.interfaces.find(p=>p.id===endpoint.interfaceId);
 const declared=module?.interfaceGroups?.find(g=>g.id===port?.group);
 return declared?{...declared,auxiliary:['clock_reset','configuration'].includes(declared.category)}:{id:port?.group??port?.protocol??'local',label:port?.group??(port?.protocol==='rv'?'数据通道':endpoint.local?'内部驱动':'信号'),category:'other',description:'显示分组；未声明业务含义',auxiliary:false};
}
export function linkGroup(model:Model,link:Link){
 const a=interfaceGroup(model,link.from),b=interfaceGroup(model,link.to);
 return a.category!=='other'?a:b.category!=='other'?b:a.id!=='signal'?a:b;
}
const endpointMatches=(a:Endpoint,b:Endpoint)=>a.moduleId===b.moduleId&&a.interfaceId===b.interfaceId&&!!a.local===!!b.local&&(a.index===undefined||b.index===undefined||a.index==='all'||b.index==='all'||a.index===b.index);
export function inspectScope(model:Model,scope:string,inspection?:Inspection){
 const stored=model.connections.filter(l=>l.scope===scope);
 const array=inspection?.kind==='array'?{moduleId:inspection.id,index:inspection.index}:inspection?.kind==='connection'?inspection.index:undefined;
 let links=stored.filter(link=>{
  if(!inspection)return true;
  switch(inspection.kind){
   case 'array':case 'module':return [link.from,link.to].some(e=>e.moduleId===inspection.id);
   case 'connection':return inspection.ids.includes(link.id);
   case 'local':return [link.from,link.to].some(e=>e.local&&e.interfaceId===inspection.id);
   case 'boundary':return [link.from,link.to].some(e=>e.moduleId===scope&&!e.local&&model.modules.find(m=>m.id===scope)?.interfaces.some(p=>p.id===e.interfaceId&&p.role===inspection.role)&&(!inspection.groupId||interfaceGroup(model,e).id===inspection.groupId));
  }
 });
 if(array)links=links.flatMap(link=>expandLink(model,link,array));
 const localIds=new Set<string>(),dependencies:{localId:string;endpoint:Endpoint}[]=[];
 function visit(id:string){if(localIds.has(id))return;localIds.add(id);const local=model.localSignals?.find(s=>s.id===id&&s.scope===scope);if(!local)return;for(const endpoint of driverReads(local)){dependencies.push({localId:id,endpoint});if(endpoint.local)visit(endpoint.interfaceId);else for(const link of stored)if(endpointMatches(link.from,endpoint)&&!links.some(l=>l.id===link.id))links.push(link);}}
 if(inspection?.kind==='local')visit(inspection.id);
 if(inspection)for(const link of links)if(link.from.local)visit(link.from.interfaceId);
 const moduleIds=new Set(links.flatMap(l=>[l.from.moduleId,l.to.moduleId]).concat(dependencies.map(d=>d.endpoint.moduleId)));
 if(inspection?.kind==='module'||inspection?.kind==='array')moduleIds.add(inspection.id);
 const missing=array?connectionFacts(model).ports.filter(p=>p.scope===scope&&p.endpoint.moduleId===array.moduleId&&p.endpoint.index===array.index&&p.intf.required&&p.missing.length).map(p=>({interfaceId:p.endpoint.interfaceId,bits:p.missing})):[];
 return {stored,links,localIds:[...localIds],dependencies,moduleIds:[...moduleIds],array,missing,
  resolved:links.map(link=>({link,width:resolveEndpoint(model,scope,link.from)?.width,group:linkGroup(model,link)})),
  summaryCount:stored.filter(l=>!array||[l.from,l.to].some(e=>e.moduleId===array.moduleId)).length};
}
