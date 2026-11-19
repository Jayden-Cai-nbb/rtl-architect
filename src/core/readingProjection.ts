import type {Model,ScopeLayout} from './schema';
import {stateNeighborhood} from './inspection';

export type ReadingTask={kind:'overview';expanded?:string[]}|{kind:'state';stateId:string;expanded?:string[]};
export type ReadingGroup={id:string;label:string;members:string[];basis:'stage'|'parallel'|'inventory'|'context';expanded:boolean};
export const readingTaskNames={overview:'主事务总览',state:'选中状态的局部范围'};
/** Display membership only. IDs always refer back to IR objects; no editable hardware copy. */
export function readingProjection(model:Model,scope:string,task:ReadingTask,reading?:ScopeLayout['reading']){
 const locals=(model.localSignals??[]).filter(n=>n.scope===scope),children=model.modules.filter(m=>m.parent===scope);
 const members=[...children.map(m=>m.id),...locals.map(n=>`local:${scope}:${n.id}`)];
 const available=new Set(members),groups:ReadingGroup[]=[],issues:{code:string;target:string;reason:string}[]=[];
 const add=(key:string,label:string,ids:string[],basis:ReadingGroup['basis'])=>{
  if(ids.length<2)return;
  const id=`aggregate:${scope}:${key}`;
  groups.push({id,label,members:ids,basis,expanded:task.expanded?.includes(id)??false});
 };
 let focus:string[]=[];
 if(task.kind==='state'){
  const state=locals.find(n=>n.id===task.stateId&&n.driver.kind==='register');
  if(!state)throw new Error('局部范围必须选择当前层级已记录的寄存状态。');
  const neighborhood=stateNeighborhood(model,scope,state.id);focus=neighborhood.nodes;
  add('context','范围外上下文',members.filter(id=>!focus.includes(id)),'context');
  if(neighborhood.limited)issues.push({code:'LOCAL_RANGE_LIMIT',target:state.id,reason:'组合依赖范围达到两层或 48 节点预算；剩余关系保留在上下文中，未认定为无关。'});
 }else{
  // Existing, explicit reading collections are sufficient. Their order is not a cycle claim.
  const declarations=[...(reading?.stages??[]).map(g=>({...g,basis:'stage' as const})),...(reading?.parallel??[]).map(g=>({...g,basis:'parallel' as const}))];
  const owners=new Map<string,number>();for(const g of declarations)for(const id of g.nodes)owners.set(id,(owners.get(id)??0)+1);
  const conflicted=new Set(declarations.filter(g=>g.nodes.some(id=>(owners.get(id)??0)>1)).flatMap(g=>g.nodes));
  if(conflicted.size)issues.push({code:'READING_GROUP_OVERLAP',target:scope,reason:'声明的阅读组交叠，保留这些成员独立显示；未任选一组聚合。'});
  for(const g of declarations)if(!g.nodes.some(id=>conflicted.has(id)))add(`${g.basis}:${g.id}`,g.label,g.nodes.filter(id=>available.has(id)),g.basis);
  const assigned=new Set(declarations.flatMap(g=>g.nodes));
  // A scope inventory is explicitly unnamed, not an inferred functional group.
  add('states','未分组状态',locals.filter(n=>n.driver.kind==='register'&&!assigned.has(`local:${scope}:${n.id}`)).map(n=>`local:${scope}:${n.id}`),'inventory');
  add('logic','未分组组合逻辑',locals.filter(n=>n.driver.kind==='comb'&&!assigned.has(`local:${scope}:${n.id}`)).map(n=>`local:${scope}:${n.id}`),'inventory');
 }
 const nodeFor=Object.fromEntries(members.map(id=>[id,id]));
 for(const g of groups)if(!g.expanded)for(const id of g.members)nodeFor[id]=g.id;
 return {task,groups,members,nodeFor,focus,issues,note:'只读阅读集合；不是 RTL 实例、物理网络或周期。范围外内容仍可展开。'};
}
