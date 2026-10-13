import type {Model} from './schema';
import {reviewDependencies} from './reviewImpact';
import {hashValue} from './export';
/** Uses declared dependencies, never name heuristics such as DEPTH implying latency. */
export function verificationImpact(before:Model,after:Model){
 const previous=new Map(before.modules.map(m=>[m.id,m]));
 const modules=after.modules.flatMap(m=>{
  const old=previous.get(m.id),direct=!old||hashValue(old)!==hashValue(m),a=old?reviewDependencies(before,m.id).scopeParts:{},b=reviewDependencies(after,m.id).scopeParts;
  const dependencies=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>a[k]!==b[k]);if(!dependencies.length)return [];
  return [{moduleId:m.id,classification:direct?'DIRECT' as const:'POTENTIAL' as const,dependencies,obligations:(m.contract.obligations??[]).map(o=>({id:o.id,kind:o.kind,requirementIds:o.requirementIds??[]})),verificationPlan:m.contract.verificationPlan}];
 });
 return {modules,removedModules:before.modules.filter(m=>!after.modules.some(n=>n.id===m.id)).map(m=>m.id),evidencePolicy:'模型变化使旧运行与旧一致性报告过期；这里只按已声明依赖安排复核顺序，不能据此省略其余验证。自然语言计划没有可执行映射时保持 UNKNOWN。'};
}
