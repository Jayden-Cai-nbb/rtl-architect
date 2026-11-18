import {MarkerType,type Edge} from '@xyflow/react';
import {readingProjection,readingTaskNames,type ReadingTask} from '../../core/readingProjection';
import type {Endpoint,Link,Model,ScopeLayout} from '../../core/schema';
import type {RtlNode,PortGeometry} from './types';

type Options={task?:ReadingTask;positions?:Record<string,{x:number;y:number}>;reading?:ScopeLayout['reading'];showAuxiliary?:boolean};
export type RelationMember={id:string;source:string;target:string;label:string;connectionIds:string[];connections:Link[];dependencyEndpoints:Endpoint[];localSignalId?:string;semanticKind:string};
export type ReadingDiagramProjection=ReturnType<typeof readingProjection>&{
 internal:Record<string,RelationMember[]>;auxiliary:RelationMember[];relationCount:number;
};
type Graph={nodes:RtlNode[];edges:Edge[];frame:{id:string;position:{x:number;y:number};width:number;height:number};reading?:ScopeLayout['reading'];projection?:ReadingDiagramProjection;modeLabel:string;omissions:{connectionId:string;reason:string}[];auxiliaryCount:number;foldedLocalCount:number;foldedDependencyCount:number;semantics:{issues:{code:string;target:string;reason:string}[]}};
/** Reduce the existing scope graph before any routing. Never construct or persist a Model. */
export function projectReadingDiagram<T extends Graph>(model:Model,scope:string,options:Options,graph:T):T{
 const projection=readingProjection(model,scope,options.task!,options.reading);
 const nodeFor=(id:string)=>projection.nodeFor[id]??id;

 const groups=projection.groups.filter(g=>!g.expanded),internal:Record<string,RelationMember[]>={},auxiliary:RelationMember[]=[];
 const context=groups.find(g=>g.basis==='context');
 const body:RtlNode[]=graph.nodes.filter(n=>!n.data.boundary&&nodeFor(n.id)===n.id).map(n=>({...n,data:{...n.data,memberIds:[n.id]},style:undefined}));
 for(const g of groups){
  internal[g.id]=[];
  const unknown=g.members.filter(id=>graph.semantics.issues.some(i=>i.target===id)).length;
  body.push({id:g.id,type:'rtlModule',position:{x:0,y:0},data:{label:g.label,moduleId:scope,kind:'aggregate',boundary:false,mainDiagram:true,memberIds:g.members,groupBasis:g.basis,summary:`${g.members.length} 项 · 只读集合`,title:`${g.label} · ${g.members.length} 项\n${projection.note}\n${g.members.join('\n')}`,statePattern:`阅读集合 · ${g.members.length} 项${unknown?' · UNKNOWN '+unknown:''}`,ports:[],geometry:{width:260,height:120,ports:[]}},style:undefined});
 }
 const bundles=new Map<string,Edge>();
 for(const edge of graph.edges){
  const source=nodeFor(edge.source),target=nodeFor(edge.target),changed=source!==edge.source||target!==edge.target;
  const member:RelationMember={id:edge.id,source:edge.source,target:edge.target,label:String(edge.label??''),connectionIds:edge.data?.connectionIds as string[]??[],connections:model.connections.filter(l=>(edge.data?.connectionIds as string[]??[]).includes(l.id)),dependencyEndpoints:edge.data?.dependencyEndpoints as Endpoint[]??[],localSignalId:edge.data?.localSignalId as string|undefined,semanticKind:String(edge.data?.semanticKind??'wire')};
  if(context&&!projection.focus.includes(edge.source)&&!projection.focus.includes(edge.target)){
   internal[context.id].push(member);continue;
  }
  if(source===target&&groups.some(g=>g.id===source)){internal[source].push(member);continue;}
  if(['clock_reset','configuration'].includes(String(edge.data?.category))&&!options.showAuxiliary){auxiliary.push(member);continue;}
  // Unknown groups keep identity. Declared group labels and dependency roles remain separate.
  const category=String(edge.data?.category??'other'),role=String(edge.data?.dependencyRole??'');
  const key=changed?JSON.stringify([source,target,member.semanticKind,category,role,edge.label,category==='other'?edge.id:'',edge.source.startsWith('rack:')?edge.sourceHandle:'',edge.target.startsWith('rack:')?edge.targetHandle:'']):edge.id;
  let bundle=bundles.get(key);
  if(!bundle){
   const id=changed?`reading-relation:${key}`:edge.id,color=String(edge.data?.color??'#64758b');
   bundle={...edge,id,source,target,sourceHandle:edge.source.startsWith('rack:')?edge.sourceHandle:`out:${id}`,targetHandle:edge.target.startsWith('rack:')?edge.targetHandle:`in:${id}`,
    data:{...edge.data,relationMembers:[] as RelationMember[],connectionIds:[] as string[],dependencyEndpoints:[] as Endpoint[],...(changed?{semanticKind:'aggregate',netKey:undefined,relationBundle:true}:{})},
    style:{stroke:color,strokeWidth:changed?2:1.8,opacity:.9},markerEnd:{type:changed||member.semanticKind==='dependency'?MarkerType.Arrow:MarkerType.ArrowClosed,color}};
   bundles.set(key,bundle);
  }
  (bundle.data!.relationMembers as RelationMember[]).push(member);
  (bundle.data!.connectionIds as string[]).push(...member.connectionIds);
  (bundle.data!.dependencyEndpoints as Endpoint[]).push(...member.dependencyEndpoints);
 }
 const edges=[...bundles.values()];
 for(const e of edges){const members=e.data!.relationMembers as RelationMember[];e.data!.title=(e.data!.semanticKind==='aggregate'?'阅读关系集合；不是物理网络\n':'')+members.map(m=>`${m.label}\n${m.id}\n${m.connectionIds.join(', ')}`).join('\n');if(members.length>1)e.label=String(e.label)+` · ${members.length} 关系`;}
 body.sort((a,b)=>projection.members.indexOf((a.data.memberIds as string[])[0])-projection.members.indexOf((b.data.memberIds as string[])[0]));
 for(const [i,n] of body.entries())n.position=options.positions?.[n.id]??{x:i*540,y:100};
 // Reuse the same frame/racks and route engine. Only visible relation anchors need geometry.
 const racks:RtlNode[]=graph.nodes.filter(n=>n.data.kind==='rack').map(n=>({...n,data:{...n.data,geometry:{...n.data.geometry,ports:n.data.geometry.ports.map(p=>({...p}))}}}));
 const nodes=[...body,...racks];
 for(const n of body){
  const ports:PortGeometry[]=[];
  for(const direction of ['target','source'] as const){
   const incoming=direction==='target';
   const incident=edges.filter(e=>incoming?e.target===n.id:e.source===n.id);
   const unique=new Map(incident.map(e=>[String(incoming?e.targetHandle:e.sourceHandle),e]));
   [...unique].forEach(([id,e],i)=>ports.push({id,direction,side:incoming?'WEST':'EAST',x:incoming?0:260,y:100+i*36,category:String(e.data?.category??'other')}));
  }
  const height=Math.max(140,Math.max(0,...ports.map(p=>p.y))+26);
  n.width=260;n.height=height;n.data.geometry={width:260,height,captionY:24,ports};n.data.ports=ports.map(p=>({id:p.id,width:undefined}));
  n.data.activeHandles=ports.map(p=>p.id);
  if(n.data.kind==='aggregate')n.data.internalRelationCount=internal[n.id]?.length??0;
 }
 const minX=Math.min(0,...body.map(n=>n.position.x)),minY=Math.min(100,...body.map(n=>n.position.y));
 const right=Math.max(260,...body.map(n=>n.position.x+n.data.geometry.width));
 const gap=340;
 for(const rack of racks){
  rack.position={x:rack.data.role==='consumer'?minX-gap-156:right+gap,y:minY-36};
  const rows=rack.data.groups as {id:string;label:string;count:number}[];
  let previous=22;
  for(const row of rows){
   const port=rack.data.geometry.ports.find(p=>p.id.endsWith(':'+row.id))!;
   const incident=edges.filter(e=>e.source===rack.id&&e.sourceHandle===port.id||e.target===rack.id&&e.targetHandle===port.id);
   const ys=incident.flatMap(e=>{const n=nodes.find(n=>n.id===(e.source===rack.id?e.target:e.source));const p=n?.data.geometry.ports.find(p=>p.id===(e.source===rack.id?e.targetHandle:e.sourceHandle));return n&&p?[n.position.y+p.y-rack.position.y]:[];});
   port.y=Math.max(previous+44,ys.length?ys.reduce((a,b)=>a+b,0)/ys.length:previous+44);previous=port.y;
  }
  rack.height=rack.data.geometry.height=previous+34;
 }
 const frame={id:graph.frame.id,position:{x:minX-gap-180,y:minY-100},width:right-minX+2*(gap+180),height:Math.max(240,...nodes.map(n=>n.position.y+n.data.geometry.height))-minY+160};
 const frameNode={...graph.nodes[0],position:frame.position,width:frame.width,height:frame.height,data:{...graph.nodes[0].data,summary:`${projection.members.length} 个原始成员 · ${groups.length} 个阅读集合`,geometry:{width:frame.width,height:frame.height,ports:[]}}};
 for(const e of edges){const source=nodes.find(n=>n.id===e.source)!,target=nodes.find(n=>n.id===e.target)!;e.data={...e.data,feedback:source.position.x>=target.position.x};}
 const omissions=auxiliary.flatMap(m=>m.connectionIds.map(connectionId=>({connectionId,reason:'显式时钟/配置折叠；阅读清单保留原始成员'})));
 return {...graph,nodes:[frameNode,...nodes],edges,frame,reading:undefined,modeLabel:readingTaskNames[options.task!.kind],projection:{...projection,internal,auxiliary,relationCount:graph.edges.length},omissions,auxiliaryCount:auxiliary.length,foldedLocalCount:0,foldedDependencyCount:0,semantics:{...graph.semantics,issues:[...graph.semantics.issues,...projection.issues]}};
}
