import type {ScopeDiagram} from './scopeDiagram';
import type {Edge} from '@xyflow/react';
import {selectionMembers,selectionNodeId,type SelectionRef,type SelectionRelation} from '../../core/selection';
import {stableStringify} from '../../core/diff';
import type {Endpoint} from '../../core/schema';
import type {RelationMember} from './readingProjection';

export function originalEdgeMembers(edge:Edge):SelectionRelation[]{
 const data=edge.data;
 const originals=data?.relationMembers as RelationMember[]|undefined;
 const list=originals??[{connectionIds:data?.connectionIds as string[]??[],localSignalId:data?.localSignalId as string|undefined,dependencyEndpoints:data?.dependencyEndpoints as Endpoint[]??[]}];
 return selectionMembers(list.flatMap((m):SelectionRelation[]=>m.localSignalId?
  m.dependencyEndpoints.map(endpoint=>({kind:'dependency',localId:m.localSignalId!,endpoint})):
  m.connectionIds.map(id=>({kind:'connection',id}))));
}

export function diagramSelection(graph:ScopeDiagram,ref:SelectionRef):string[]{
 const {scope,target}=ref;
 const shown=(id:string)=>graph.projection?.nodeFor[id]??id;
 if(target.kind==='relationship'){
  const members=new Set(target.members.map(stableStringify));
  return graph.edges.filter(edge=>originalEdgeMembers(edge).some(member=>members.has(stableStringify(member)))).map(edge=>edge.id);
 }
 if(target.kind==='local')return [shown(selectionNodeId(scope,target.id))];
 if(target.kind==='group')return [...new Set(target.members.map(shown))];
 if(target.kind==='boundary')return [`rack:${scope}:${target.role}`];
 return [shown(target.kind==='module'?target.id:target.moduleId??scope)];
}

/** A pure style projection: never changes nodes, ports, routes or visible topology. */
export function highlightDiagram(graph:ScopeDiagram,ids:string|string[],tracing=false):Pick<ScopeDiagram,'nodes'|'edges'>{
 const selected=new Set(typeof ids==='string'?[ids]:ids);
 const related=new Set(graph.edges.filter(e=>selected.has(e.id)||selected.has(e.source)||selected.has(e.target)).map(e=>e.id));
 const peers=new Set(graph.edges.filter(e=>related.has(e.id)).flatMap(e=>[e.source,e.target]));
 // Keep the actual fanout name visible, without highlighting its other consumers.
 for(const e of graph.edges.filter(e=>related.has(e.id)))if(e.data?.labelSharedWith)related.add(String(e.data.labelSharedWith));
 const active=peers.size>0;
 return {nodes:graph.nodes.map(n=>({...n,selected:selected.has(n.id),style:{...n.style,opacity:selected.has(n.id)||peers.has(n.id)?1:tracing?n.style?.opacity:!active||n.data.boundary?1:.75}})),
  edges:graph.edges.map(e=>({...e,selected:selected.has(e.id),style:{...e.style,opacity:related.has(e.id)?1:tracing?e.style?.opacity:active?.3:.86,strokeWidth:related.has(e.id)?2.6:e.style?.strokeWidth},data:{...e.data,selected:related.has(e.id)}}))};
}
