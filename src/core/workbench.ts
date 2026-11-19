import { z } from 'zod';
import { hashSchema, idSchema, type Model } from './schema';
import {stableStringify} from './diff';
import { studySchema } from './studies';
import {decisionSchema,decisionInputSchema} from './decisions';
import {instancePath,instancePathSchema,makeSelection,selectedConnections,selectionProblems,selectionRefSchema,type SelectionRef} from './selection';
const text = z.string().trim().min(1).max(12000);
const objectBase={scope:idSchema,instancePath:instancePathSchema};
export const workObjectSchema=z.discriminatedUnion('kind',[
 z.strictObject({...objectBase,kind:z.literal('local_state'),id:idSchema}),
 z.strictObject({...objectBase,kind:z.literal('update_branch'),id:idSchema,stateId:idSchema}),
 z.strictObject({...objectBase,kind:z.literal('requirement'),id:idSchema}),
 z.strictObject({...objectBase,kind:z.literal('obligation'),id:idSchema}),
]);
export type WorkObject=z.infer<typeof workObjectSchema>;
export type ObjectRequest=Omit<WorkObject,'instancePath'> & {stateId?:string};
export const workTargetSchema = z.strictObject({modelHash:hashSchema,moduleId:idSchema.optional(),connectionIds:z.array(idSchema).default([]),proposalId:hashSchema.optional(),object:workObjectSchema.optional(),selection:selectionRefSchema.optional()})
 .refine(t=>!!t.selection||t.connectionIds.length<=100,{path:['connectionIds'],message:'旧格式最多保留 100 条连接'});
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

export const workInstancePath=(model:Model,scope:string,index?:number)=>instancePath(model,scope,index);
export function makeWorkObject(model:Model,ref:ObjectRequest,index?:number):WorkObject{return workObjectSchema.parse({...ref,instancePath:workInstancePath(model,ref.scope,index)});}
export function workObjectLabel(o:WorkObject){return `${o.instancePath.map(p=>p.moduleId+(p.index===undefined?'':`[${p.index}]`)).join('/')} · ${o.kind} · ${o.kind==='update_branch'?o.stateId+'/':''}${o.id}`;}
export function makeWorkTarget(model:Model,selection:SelectionRef,proposalId?:string):WorkTarget{
 const {target,scope,instancePath,modelHash}=selection;
 const object:WorkObject|undefined=target.kind==='requirement'||target.kind==='obligation'?{kind:target.kind,id:target.id,scope:target.moduleId??scope,instancePath}:
  target.kind==='local'&&target.branch?{kind:'update_branch',id:target.branch,stateId:target.id,scope,instancePath}:
  target.kind==='local'&&model.localSignals?.some(l=>l.scope===scope&&l.id===target.id&&l.driver.kind==='register')?{kind:'local_state',id:target.id,scope,instancePath}:undefined;
 return {modelHash,moduleId:target.kind==='module'?target.id:object?.scope??scope,connectionIds:selectedConnections(selection),selection,...(object?{object}:{}),...(proposalId?{proposalId}:{})};
}

/** Resolve old records using their declared identifiers. Projection identity is stored on new records. */
export function workSelection(model:Model,t:WorkTarget):SelectionRef|undefined{
 if(t.selection)return t.selection;
 const object=t.object;
 try{
  if(object){
   if(object.kind==='local_state'||object.kind==='update_branch')return makeSelection(model,t.modelHash,object.scope,{kind:'local',id:object.kind==='local_state'?object.id:object.stateId,...(object.kind==='update_branch'?{branch:object.id}:{})});
   const index=object.instancePath.at(-1)?.index,m=model.modules.find(n=>n.id===object.scope);
   if(!m)return;
   const scope=m.kind==='subsystem'?m.id:m.parent??m.id;
   return makeSelection(model,t.modelHash,scope,{kind:object.kind,id:object.id,...(scope===m.id?{}:{moduleId:m.id}),...(index===undefined?{}:{index})});
  }
  if(t.connectionIds.length){
   const scopes=new Set(t.connectionIds.map(id=>model.connections.find(l=>l.id===id)?.scope));
   const scope=[...scopes][0];
   if(scope&&scopes.size===1)return makeSelection(model,t.modelHash,scope,{kind:'relationship',members:t.connectionIds.map(id=>({kind:'connection',id}))});
   return;
  }
  const m=model.modules.find(m=>m.id===(t.moduleId??model.design.top));
  if(m)return makeSelection(model,t.modelHash,m.kind==='subsystem'?m.id:m.parent??m.id,{kind:'module',id:m.id});
 }catch{return;}
}
export function workTargetState(model:Model,hash:string,t:WorkTarget):TargetState{
 const missing=[...(t.moduleId&&!model.modules.some(m=>m.id===t.moduleId)?[t.moduleId]:[]),...t.connectionIds.filter(id=>!model.connections.some(l=>l.id===id))];
 const o=t.object;
 if(t.selection){
  const expected=makeWorkTarget(model,t.selection,t.proposalId);
  if(expected.modelHash!==t.modelHash||expected.moduleId!==t.moduleId||
    stableStringify(expected.connectionIds)!==stableStringify(t.connectionIds)||stableStringify(expected.object??null)!==stableStringify(o??null))missing.push('当前选择与讨论目标不匹配');
  missing.push(...selectionProblems(model,t.selection));
 }else if(o){
  try{if(t.moduleId!==o.scope||stableStringify(workInstancePath(model,o.scope,o.instancePath.at(-1)?.index))!==stableStringify(o.instancePath))missing.push('实例身份不匹配');}catch(e){missing.push(String(e));}
  const local=model.localSignals?.find(l=>l.scope===o.scope&&l.id===(o.kind==='update_branch'?o.stateId:o.id));
  const exists=o.kind==='local_state'?local?.driver.kind==='register':o.kind==='update_branch'?local?.driver.kind==='register'&&!!local.driver.update&&(o.id==='otherwise'||o.id==='reset'&&!!local.driver.update.reset||local.driver.update.branches.some(b=>b.id===o.id)):o.kind==='requirement'?model.specification?.requirements.some(r=>r.id===o.id&&(o.scope===model.design.top||r.moduleIds.includes(o.scope))):model.modules.find(m=>m.id===o.scope)?.contract.obligations?.some(b=>b.id===o.id);
  if(!exists)missing.push(workObjectLabel(o));
 }
 const versionChanged=hash!==t.modelHash,canLocate=!versionChanged&&!missing.length;
 return {versionChanged,missingTargets:missing,canLocate,reason:missing.length?'原对象或实例身份已失效':versionChanged?'对象版本已失效；不会按同名对象重绑':'对象与版本匹配'};
}
export function sameWorkObject(a:WorkTarget,b:WorkTarget){return !!a.object&&!!b.object&&stableStringify(a.object)===stableStringify(b.object)&&a.modelHash===b.modelHash&&(!a.proposalId||!b.proposalId||a.proposalId===b.proposalId);}
