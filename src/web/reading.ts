import type {Model,Module,Issue} from '../core/schema';

export const kindLabel:Record<string,string>={subsystem:'子系统',module:'模块',memory:'存储',compute:'运算',controller:'控制',fifo:'队列',add_const:'运算',state:'寄存状态',local:'内部逻辑'};
// Only remove known audit wrappers in a short preview. The original is always
// available in the inspector / Spec and never rewritten into the model.
export function excerpt(text:string,length=110){
 const clean=text.replace(/^\[(?:源码事实|事实)\]\s*/,'').replace(/^\[(推断|建模决定)\]\s*/,'$1：').replace(/\s+(?:定义\s+src\/|实例路径[：:]).*$/s,'').trim();
 return clean.length>length?clean.slice(0,length)+'…':clean;
}
export const moduleLabel=(module:Module)=>module.name;
export function decisionItems(model:Model,scope:string){
 const owner=model.modules.find(m=>m.id===scope)!;
 const questions=[...(scope===model.design.top?model.specification?.openQuestions??[]:[]),...owner.contract.openQuestions];
 const findings=model.provenance?.findings.filter(f=>['unknown','conflict'].includes(f.classification)&&(!f.moduleIds.length||f.moduleIds.includes(scope)))??[];
 return [...new Set([...questions,...findings.map(f=>f.text)])];
}
export function issueSummary(issues:Issue[]){
 return {errors:issues.filter(i=>i.blocks.includes('commit')).length,gaps:issues.filter(i=>i.code==='REQUIRED_UNCONNECTED').length,questions:issues.filter(i=>['SOURCE_UNRESOLVED','RESET_RELEASE_UNKNOWN'].includes(i.code)).length};
}
