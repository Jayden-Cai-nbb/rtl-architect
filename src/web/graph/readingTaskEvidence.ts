import type {Edge} from '@xyflow/react';
import type {Model} from '../../core/schema';
import type {SelectionTarget} from '../../core/selection';
import type {ReadingDiagramProjection} from './readingProjection';
import type {RtlNode} from './types';

export function readingTaskEvidence(model:Model,scope:string,graph:{nodes:RtlNode[];edges:Edge[];projection?:ReadingDiagramProjection}){
 const declarations=model.provenance?.readingTasks?.filter(task=>task.moduleId===scope)??[];
 const gaps=model.provenance?.unsupportedStructures.filter(gap=>gap.moduleIds.includes(scope))??[];
 if(!declarations.length)return {status:'unassessed' as const,tasks:[],gapIds:gaps.map(gap=>gap.id)};
 const owner=model.modules.find(m=>m.id===scope)!;
 const evidence=new Map(model.provenance?.evidence.map(e=>[e.id,e]));
 const visible=new Set(graph.nodes.map(node=>node.id));
 const links=new Set<string>(graph.edges.flatMap(edge=>(edge.data?.connectionIds as string[]|undefined)??[]));
 for(const group of Object.values(graph.projection?.internal??{}))for(const part of group)for(const id of part.connectionIds)links.add(id);
 const tasks=declarations.map(task=>{
  const steps=task.steps.map(step=>{
   const {target}=step;
   const role=target?.kind==='boundary'?owner.interfaces.find(p=>p.id===target.id)?.role:undefined;
   const selection:SelectionTarget|undefined=target?.kind==='local'?{kind:'local',id:target.id}:
    target?.kind==='module'?{kind:'module',id:target.id}:role&&target?{kind:'boundary',role,ports:[target.id]}:undefined;
   const original=target?.kind==='local'?`local:${scope}:${target.id}`:role?`rack:${scope}:${role}`:target?.id;
   const node=original?(graph.projection?.nodeFor[original]??original):undefined;
   const nodeId=node&&visible.has(node)?node:undefined;
   const gap=gaps.find(gap=>gap.id===step.gapId);
   const missingConnections=step.connectionIds?.filter(id=>!links.has(id))??[];
   const status=gap?'gap' as const:nodeId&&!missingConnections.length?'located' as const:'outside_view' as const;
   return {...step,selection,nodeId,status,missingConnections,gap:gap?.description,
    sources:[...new Set([...step.evidenceIds,...(gap?.evidenceIds??[])])].flatMap(id=>{
     const source=evidence.get(id);return source?[{id,file:source.file,line:source.line}]:[];
    })};
  });
  return {...task,steps,status:steps.every(step=>step.status==='located')?'ready' as const:'blocked' as const};
 });
 return {status:tasks.every(task=>task.status==='ready')?'ready' as const:'blocked' as const,tasks,gapIds:gaps.map(gap=>gap.id)};
}
