import {z} from 'zod';
import {endpointSchema,hashSchema,idSchema,type Model} from './schema';
import {stableStringify} from './diff';
import {driverReads,expandLink} from './signals';
import {stateDescription} from './stateUpdates';

const index=z.number().int().safe().nonnegative();
export const instancePathSchema=z.array(z.strictObject({moduleId:idSchema,index:index.optional()})).min(1).max(64);
export const relationMemberSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('connection'),id:idSchema}),
 z.strictObject({kind:z.literal('dependency'),localId:idSchema,endpoint:endpointSchema}),
]);
const selectionTargetSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('module'),id:idSchema,index:index.optional()}),
 z.strictObject({kind:z.literal('local'),id:idSchema,branch:idSchema.optional()}),
 z.strictObject({kind:z.literal('relationship'),members:z.array(relationMemberSchema).min(1),
  element:z.strictObject({moduleId:idSchema,index}).optional()}),
 z.strictObject({kind:z.literal('group'),members:z.array(z.union([idSchema,z.string().regex(/^local:[A-Za-z0-9_]+:[A-Za-z0-9_]+$/)])).min(2)}),
 z.strictObject({kind:z.literal('boundary'),role:z.enum(['consumer','producer']),ports:z.array(idSchema).min(1)}),
 z.strictObject({kind:z.literal('requirement'),id:idSchema,moduleId:idSchema.optional(),index:index.optional()}),
 z.strictObject({kind:z.literal('obligation'),id:idSchema,moduleId:idSchema.optional(),index:index.optional()}),
]);
export const selectionRefSchema=z.strictObject({modelHash:hashSchema,scope:idSchema,instancePath:instancePathSchema,target:selectionTargetSchema});
export type SelectionRef=z.infer<typeof selectionRefSchema>;
export type SelectionTarget=SelectionRef['target'];
export type SelectionRelation=z.infer<typeof relationMemberSchema>;
export const selectionKey=(ref:SelectionRef)=>stableStringify(ref);
export function selectionMembers<T>(values:readonly T[]):T[]{
 const byKey=new Map(values.map(value=>[stableStringify(value),value]));
 return [...byKey.keys()].sort().map(key=>byKey.get(key)!);
}

/** The IR instance path uses concrete IDs and indices, never display names or RTL module names. */
export function instancePath(model:Model,id:string,index?:number,arraySummary=false):SelectionRef['instancePath']{
 const leaf=id,path:SelectionRef['instancePath']=[];
 let current:string|null=id;
 for(let n=0;current&&n<=model.modules.length;n++){
  const m=model.modules.find(m=>m.id===current);
  if(!m)throw new Error('对象作用域不存在');
  if(m.instances&&(m.id!==leaf||(index===undefined?!arraySummary:index<m.instances.from||index>m.instances.to)))throw new Error('数组对象需要明确的有效实例索引');
  if(m.id===leaf&&!m.instances&&index!==undefined)throw new Error('非数组对象不能带实例索引');
  path.unshift({moduleId:m.id,...(m.instances&&index!==undefined?{index}:{})});
  current=m.parent;
 }
 if(current||path[0]?.moduleId!==model.design.top)throw new Error('实例层级不完整');
 return path;
}

function selectionPath(model:Model,scope:string,target:SelectionTarget){
 if(target.kind==='module')return instancePath(model,target.id,target.index,true);
 if(target.kind==='relationship'&&target.element)return instancePath(model,target.element.moduleId,target.element.index);
 if(target.kind==='requirement'||target.kind==='obligation')return instancePath(model,target.moduleId??scope,target.index);
 return instancePath(model,scope);
}

export function makeSelection(model:Model,modelHash:string,scope:string,target:SelectionTarget):SelectionRef{
 const canonical='members' in target?{...target,members:selectionMembers(target.members as (SelectionRelation|string)[])}:
  target.kind==='boundary'?{...target,ports:selectionMembers(target.ports)}:target;
 return selectionRefSchema.parse({modelHash,scope,instancePath:selectionPath(model,scope,target),target:canonical});
}

export function selectedConnections(ref?:SelectionRef){
 return ref?.target.kind==='relationship'?ref.target.members.flatMap(member=>member.kind==='connection'?[member.id]:[]):[];
}
export function selectedInstance(ref:SelectionRef){
 return ref.instancePath.at(-1)!;
}
export const selectionNodeId=(scope:string,id:string)=>`local:${scope}:${id}`;
export function selectionNodeName(model:Model,scope:string,id:string){
 return model.modules.find(m=>m.id===id)?.name??model.localSignals?.find(l=>l.scope===scope&&selectionNodeId(scope,l.id)===id)?.name??id;
}

export function selectionProblems(model:Model,ref:SelectionRef):string[]{
 const {scope,target}=ref,owner=model.modules.find(m=>m.id===scope);
 if(!owner)return [scope];
 const moduleInScope=(id:string)=>id===scope||model.modules.some(m=>m.id===id&&m.parent===scope);
 const locals=(model.localSignals??[]).filter(l=>l.scope===scope);
 try{
  if(stableStringify(ref.instancePath)!==stableStringify(selectionPath(model,scope,target)))return ['实例身份不匹配'];
 }catch(e){return [String(e)];}
 if(target.kind==='module')return moduleInScope(target.id)?[]:[target.id];
 if(target.kind==='local'){
  const local=locals.find(l=>l.id===target.id);
  return local&&(!target.branch||stateDescription(local)?.rows.some(row=>row.id===target.branch))?[]:[target.branch?`${target.id}/${target.branch}`:target.id];
 }
 if(target.kind==='requirement'||target.kind==='obligation'){
  const id=target.moduleId??scope;
  const records=target.kind==='requirement'
   ?model.specification?.requirements.filter(r=>id===model.design.top||r.moduleIds.includes(id))
   :model.modules.find(m=>m.id===id)?.contract.obligations;
  return moduleInScope(id)&&records?.some(r=>r.id===target.id)?[]:[target.id];
 }
 if(target.kind==='boundary')return target.ports.filter(id=>!owner.interfaces.some(port=>port.id===id&&port.role===target.role));
 if(target.kind==='group')return target.members.filter(id=>id===scope||!moduleInScope(id)&&!locals.some(l=>selectionNodeId(scope,l.id)===id));
 const links=new Map(model.connections.filter(link=>link.scope===scope).map(link=>[link.id,link]));
 return target.members.flatMap(member=>{
  if(member.kind==='connection'){
   const link=links.get(member.id);
   return link&&(!target.element||[link.from,link.to].some(e=>e.moduleId===target.element!.moduleId)&&expandLink(model,link,target.element).length)?[]:[member.id];
  }
  const local=locals.find(l=>l.id===member.localId);
  return !target.element&&local&&driverReads(local).some(e=>stableStringify(e)===stableStringify(member.endpoint))?[]:[member.localId];
 });
}

export function selectionLabel(model:Model,ref:SelectionRef){
 const {scope,target}=ref;
 const path=ref.instancePath.map(p=>p.moduleId+(p.index===undefined?'':`[${p.index}]`)).join('/');
 if(target.kind==='module')return path;
 if(target.kind==='local')return `${path} · ${target.id}${target.branch?'/'+target.branch:''}`;
 if(target.kind==='requirement'||target.kind==='obligation')return `${path} · ${target.id}`;
 if(target.kind==='boundary')return `${target.role==='consumer'?'输入':'输出'} · ${target.ports.join('、')}`;
 if(target.kind==='group')return target.members.map(id=>selectionNodeName(model,scope,id)).join('、');
 return target.members.map(member=>member.kind==='connection'?member.id:`依赖 ${member.endpoint.interfaceId} → ${member.localId}`).join('、');
}
