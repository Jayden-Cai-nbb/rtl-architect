import { z } from 'zod';
import { hashSchema, idSchema, type Model } from './schema';
import {stableStringify} from './diff';
import { studySchema } from './studies';
import {decisionSchema,decisionInputSchema} from './decisions';
const text = z.string().trim().min(1).max(12000);
const objectBase={scope:idSchema,instancePath:z.array(z.strictObject({moduleId:idSchema,index:z.number().int().safe().nonnegative().optional()})).min(1).max(64)};
export const workObjectSchema=z.discriminatedUnion('kind',[
 z.strictObject({...objectBase,kind:z.literal('local_state'),id:idSchema}),
 z.strictObject({...objectBase,kind:z.literal('update_branch'),id:idSchema,stateId:idSchema}),
 z.strictObject({...objectBase,kind:z.literal('requirement'),id:idSchema}),
 z.strictObject({...objectBase,kind:z.literal('obligation'),id:idSchema}),
]);
export type WorkObject=z.infer<typeof workObjectSchema>;
export type ObjectRequest=Omit<WorkObject,'instancePath'> & {stateId?:string};
export const workTargetSchema = z.strictObject({modelHash:hashSchema,moduleId:idSchema.optional(),connectionIds:z.array(idSchema).max(100).default([]),proposalId:hashSchema.optional(),object:workObjectSchema.optional()});
const messageSchema=z.strictObject({id:idSchema,author:z.enum(['user','agent']),text,createdAt:z.iso.datetime(),modelHash:hashSchema,proposalId:hashSchema.optional()});
const threadSchema=z.strictObject({id:idSchema,target:workTargetSchema,title:z.string().trim().min(1).max(240),status:z.enum(['open','addressed','resolved']),messages:z.array(messageSchema).min(1),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()});
export const checkpointSchema=z.strictObject({intent:text,nextStep:text,target:workTargetSchema,updatedAt:z.iso.datetime()});
export const workbenchSchema=z.strictObject({schemaVersion:z.literal(1),threads:z.array(threadSchema),checkpoint:checkpointSchema.nullable(),studies:z.array(studySchema),decisions:z.array(decisionSchema).optional()});
export const workActionSchema=z.intersection(z.strictObject({baseHash:hashSchema,action:z.unknown()}),z.object({action:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('ask'),title:z.string().trim().min(1).max(240),text,target:workTargetSchema}),
 z.strictObject({kind:z.literal('reply'),threadId:idSchema,author:z.enum(['user','agent']),text,modelHash:hashSchema,proposalId:hashSchema.optional()}),
 z.strictObject({kind:z.literal('resolve'),threadId:idSchema,modelHash:hashSchema}),
 z.strictObject({kind:z.literal('reopen'),threadId:idSchema,modelHash:hashSchema}),
 z.strictObject({kind:z.literal('checkpoint'),intent:text,nextStep:text,target:workTargetSchema}),
 z.strictObject({kind:z.literal('study'),study:studySchema}),
 z.strictObject({kind:z.literal('decision'),decision:decisionInputSchema}),
 z.strictObject({kind:z.literal('choose_decision'),decisionId:idSchema,optionId:idSchema,reason:text}),
])}));
export type Workbench=z.infer<typeof workbenchSchema>;
export type WorkTarget=z.infer<typeof workTargetSchema>;
export type WorkAction=z.infer<typeof workActionSchema>;
export type TargetState={versionChanged:boolean;missingTargets:string[];canLocate:boolean;reason:string;proposalState?:string};
export type WorkbenchSnapshot={workbench:Workbench;workbenchHash:string;modelHash:string;threadStates:({id:string}&TargetState)[];checkpointState:TargetState|null;studyStates:{id:string;stale:boolean;reason:string}[];decisionStates:{id:string;options:{id:string;stale:boolean;reason:string;experiments:{runId:string;status:string;fresh:boolean}[]}[]}[]};
export const emptyWorkbench=():Workbench=>({schemaVersion:1,threads:[],checkpoint:null,studies:[]});

/** IR instance IDs, never rtlModule names or inferred RTL paths. Array indices must be explicit. */
export function workInstancePath(model:Model,scope:string,index?:number):WorkObject['instancePath']{
 const path:WorkObject['instancePath']=[];let id:string|null=scope;
 for(let n=0;id&&n<=model.modules.length;n++){
  const m=model.modules.find(m=>m.id===id);if(!m)throw new Error('对象作用域不存在');
  if(m.instances&&(m.id!==scope||index===undefined||index<m.instances.from||index>m.instances.to))throw new Error('数组对象需要明确的有效实例索引');
  if(m.id===scope&&!m.instances&&index!==undefined)throw new Error('非数组对象不能带实例索引');
  path.unshift({moduleId:m.id,...(m.instances?{index}: {})});id=m.parent;
 }
 if(id||path[0]?.moduleId!==model.design.top)throw new Error('实例层级不完整');return path;
}
export function makeWorkObject(model:Model,ref:ObjectRequest,index?:number):WorkObject{return workObjectSchema.parse({...ref,instancePath:workInstancePath(model,ref.scope,index)});}
export function workObjectLabel(o:WorkObject){return `${o.instancePath.map(p=>p.moduleId+(p.index===undefined?'':`[${p.index}]`)).join('/')} · ${o.kind} · ${o.kind==='update_branch'?o.stateId+'/':''}${o.id}`;}
export function workTargetState(model:Model,hash:string,t:WorkTarget):TargetState{
 const missing=[...(t.moduleId&&!model.modules.some(m=>m.id===t.moduleId)?[t.moduleId]:[]),...t.connectionIds.filter(id=>!model.connections.some(l=>l.id===id))];
 const o=t.object;
 if(o){
  try{if(t.moduleId!==o.scope||stableStringify(workInstancePath(model,o.scope,o.instancePath.at(-1)?.index))!==stableStringify(o.instancePath))missing.push('实例身份不匹配');}catch(e){missing.push(String(e));}
  const local=model.localSignals?.find(l=>l.scope===o.scope&&l.id===(o.kind==='update_branch'?o.stateId:o.id));
  const exists=o.kind==='local_state'?local?.driver.kind==='register':o.kind==='update_branch'?local?.driver.kind==='register'&&!!local.driver.update&&(o.id==='otherwise'||o.id==='reset'&&!!local.driver.update.reset||local.driver.update.branches.some(b=>b.id===o.id)):o.kind==='requirement'?model.specification?.requirements.some(r=>r.id===o.id&&(o.scope===model.design.top||r.moduleIds.includes(o.scope))):model.modules.find(m=>m.id===o.scope)?.contract.obligations?.some(b=>b.id===o.id);
  if(!exists)missing.push(workObjectLabel(o));
 }
 const versionChanged=hash!==t.modelHash,canLocate=!versionChanged&&!missing.length;
 return {versionChanged,missingTargets:missing,canLocate,reason:missing.length?'原对象或实例身份已失效':versionChanged?'对象版本已失效；不会按同名对象重绑':'对象与版本匹配'};
}
export function sameWorkObject(a:WorkTarget,b:WorkTarget){return !!a.object&&!!b.object&&stableStringify(a.object)===stableStringify(b.object)&&a.modelHash===b.modelHash&&(!a.proposalId||!b.proposalId||a.proposalId===b.proposalId);}
