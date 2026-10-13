import type {ScopeDiagram} from './scopeDiagram';
/** A pure style projection: never changes nodes, ports, routes or visible topology. */
export function highlightDiagram(graph:ScopeDiagram,selectedId:string):Pick<ScopeDiagram,'nodes'|'edges'>{
 const related=new Set(graph.edges.filter(e=>e.source===selectedId||e.target===selectedId).map(e=>e.id));
 const peers=new Set(graph.edges.filter(e=>related.has(e.id)).flatMap(e=>[e.source,e.target]));
 const active=peers.size>0;
 return {nodes:graph.nodes.map(n=>({...n,selected:n.id===selectedId,style:{...n.style,opacity:!active||n.data.boundary||peers.has(n.id)?1:.75}})),edges:graph.edges.map(e=>({...e,style:{...e.style,opacity:!active?.86:related.has(e.id)?1:.3,strokeWidth:related.has(e.id)?2.6:e.style?.strokeWidth},data:{...e.data,selected:related.has(e.id)}}))};
}
