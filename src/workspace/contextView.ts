import {z} from 'zod';
import type {Snapshot} from '../core/api';
import {moduleDocument,moduleIssues} from '../core/spec';
import {ToolError} from './environment';
export const contextViewSchema=z.strictObject({purpose:z.enum(['design','review','implementation','debug','index']),moduleId:z.string().optional(),index:z.number().int().nonnegative().optional(),maxBytes:z.number().int().min(2048).max(1048576).default(12000),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(30)});
export type ContextViewOptions=z.input<typeof contextViewSchema>;
/** Indexes are request-local: a caller editing a model can never reuse stale cached semantics. */
export function contextView(snapshot:Snapshot,input:ContextViewOptions){
 const o=contextViewSchema.parse(input),{model}=snapshot,byId=new Map(model.modules.map(m=>[m.id,m]));
 const owner=o.moduleId?byId.get(o.moduleId):undefined;if(o.moduleId&&!owner)throw new ToolError('MODULE_NOT_FOUND','模块不存在');
 const childCounts=new Map<string,number>();for(const m of model.modules)if(m.parent)childCounts.set(m.parent,(childCounts.get(m.parent)??0)+1);
 const brief=(id:string)=>{const m=byId.get(id)!;return {id,name:m.name,parent:m.parent,kind:m.kind,children:childCounts.get(id)??0,obligations:m.contract.obligations?.length??0,openQuestions:m.contract.openQuestions.length};};
 const base={modelHash:snapshot.modelHash,design:model.design,reviewStatus:snapshot.reviewStatus,reviewAssurance:'local_record' as const,purpose:o.purpose,focus:owner?.id??null};
 const size=(value:unknown)=>Buffer.byteLength(JSON.stringify(value,null,2));
 if(o.purpose==='index'){
  const all=model.modules.filter(m=>!owner||m.parent===owner.id),items=all.slice(o.offset,o.offset+o.limit).map(m=>brief(m.id));
  const result={...base,total:all.length,offset:o.offset,modules:items,nextOffset:o.offset+items.length<all.length?o.offset+items.length:null,unknowns:{design:model.specification?.openQuestions.length??0,findings:model.provenance?.findings.filter(f=>f.classification!=='fact').length??0,unsupported:model.provenance?.unsupportedStructures.length??0,fidelity:model.provenance?.fidelity??'not_declared'},note:'这是导航索引，不是完整合同或覆盖证明。使用 context --module ID --purpose implementation 读取局部。'};
  if(size(result)>o.maxBytes)throw new ToolError('CONTEXT_BUDGET_TOO_SMALL','索引超过字节预算，请减小 --limit 或增大 --max-bytes',{requiredBytes:size(result)});return result;
 }
 if(!owner)throw new ToolError('MODULE_REQUIRED','任务上下文需指定 --module；先用 context-index 浏览索引');
 const doc=moduleDocument(model,owner.id,o.index),issues=moduleIssues(model,snapshot.issues,owner.id);
 const {interfaces:rawInterfaces,...module}=doc.module;void rawInterfaces;
 const essential={...base,module,instance:doc.instance,interfaces:doc.interfaces,parameterReport:doc.parameterReport,clocks:model.clocks.filter(c=>c.id===owner.clock),resets:model.resets.filter(r=>r.id===owner.reset),review:snapshot.moduleReviews.find(r=>r.moduleId===owner.id),unknowns:{design:model.specification?.openQuestions??[],fidelity:model.provenance?.fidelity??'not_declared',findings:doc.provenance?.findings.filter(f=>f.classification!=='fact')??[],unsupported:doc.provenance?.unsupportedStructures??[]},issues,requirements:doc.requirements};
 const result:Record<string,unknown>={...essential,related:{},omitted:[]};
 const refs={decisions:doc.decisions,connections:doc.connections,localSignals:doc.localSignals,neighbors:[...new Set(doc.connections.flatMap(l=>[l.from.moduleId,l.to.moduleId]))].filter(id=>id!==owner.id).map(brief),children:doc.children.map(m=>brief(m.id)),evidence:doc.provenance?.evidence??[]};
 const omitted:{section:string;count:number;read:string}[]=[];result.omitted=omitted;
 const order={design:['decisions','children','connections','neighbors','evidence','localSignals'],review:['decisions','evidence','connections','neighbors','children','localSignals'],implementation:['connections','localSignals','children','evidence','decisions','neighbors'],debug:['evidence','localSignals','connections','neighbors','decisions','children']}[o.purpose];
 for(const key of order){const items=refs[key as keyof typeof refs];
  const related=result.related as Record<string,unknown>;related[key]=items;
  if(size(result)>o.maxBytes-1024){delete related[key];omitted.push({section:key,count:items?.length??0,read:`context --module ${owner.id} --offline`});}
 }
 result.workbench='resume --offline：读取未解决问题、候选和继续位置；本上下文不替代工作记录。';
 result.note='保留自身合同、未知和阻断信息；省略部分有明确计数与完整读取入口。实现仍需 handoff；本地审批不是身份认证。字节预算不是精确 token 数。';
 if(size(result)>o.maxBytes)throw new ToolError('CONTEXT_BUDGET_TOO_SMALL','关键合同或未知信息超过预算，未截断；请增大 --max-bytes',{requiredBytes:size(result),moduleId:owner.id});
 return result;
}
