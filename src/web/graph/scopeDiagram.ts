import {stateDescription} from '../../core/stateUpdates';
import {hardwareView,viewNames,type ViewMode} from '../../core/hardwareView';
import {dependencyRelations} from './dependencies';
import {validateReadingRefs,readingNodes} from './readingRefs';
import {MarkerType,type Edge} from '@xyflow/react';
import type {Model,Endpoint,ScopeLayout} from '../../core/schema';
import {childrenOf,resolveEndpoint} from '../../core/endpoints';
import {endpointLabel} from '../../core/signals';
import {instanceCount} from '../../core/parameters';
import {inspectScope,interfaceGroup,linkGroup,linkAnchorGroup} from '../../core/inspection';
import type {Inspection} from '../../core/inspection';
import type {RtlNode,PortGeometry} from './types';
import {excerpt} from '../reading';
import {annotateWireNets} from './wireNets';
import {orientPorts} from './ports';
import {routeEdges} from './orthogonal';
export type Positions=Record<string,{x:number;y:number}>;
export type DiagramOptions={mode?:ViewMode;positions?:Positions;inspection?:Inspection;showAuxiliary?:boolean;showLocals?:boolean;showState?:boolean;reading?:ScopeLayout['reading'];detail?:'architecture'|'signals';measureOnly?:boolean;showPortNames?:boolean};
export const diagramColors:Record<string,string>={data:'#326ea1',request:'#7c61ab',response:'#267e80',writeback:'#b07435',configuration:'#82919c',clock_reset:'#82919c',control:'#64758b',other:'#64758b'};
const width=240,baseHeight=120;
export function scopeDiagram(model:Model,scope:string,options:DiagramOptions={},inspection=inspectScope(model,scope,options.inspection)){
 const mode=options.mode??(options.detail==='signals'?'signals':'architecture');
 options={...options,...(mode==='microarchitecture'?{showLocals:true,showState:true}:mode==='signals'?{showLocals:true,showState:true,showAuxiliary:true}:{}),detail:mode==='signals'?'signals':options.detail};
 if(options.inspection?.kind==='local'&&options.inspection.purpose==='control')options={...options,showAuxiliary:true};
 const semantics=hardwareView(model,scope),relationshipById=new Map(semantics.relationships.map(r=>[r.id,r]));
 validateReadingRefs(model,scope,options.reading);
 const owner=model.modules.find(m=>m.id===scope)!;
 const children=childrenOf(model,scope),focused=new Set(inspection.moduleIds),focus=!!options.inspection;
 const localSignals=model.localSignals?.filter(n=>n.scope===scope)??[];
 const dependencies=dependencyRelations(model,scope,options.detail==='signals');
 const readingRefs=new Set(readingNodes(options.reading));
 const bridgeLocals=new Set(inspection.stored.filter(l=>l.from.local&&!l.to.local&&!linkGroup(model,l).auxiliary).map(l=>l.from.interfaceId));
 const visibleLocals=localSignals.filter(n=>options.showLocals||(options.showLocals!==false&&bridgeLocals.has(n.id)&&n.driver.kind==='comb'&&n.driver.value.kind!=='constant')||(options.showState!==false&&n.driver.kind==='register')||readingRefs.has(`local:${scope}:${n.id}`)||inspection.localIds.includes(n.id));
 const groupRows=(role:'consumer'|'producer')=>{
  const groups=new Map<string,{id:string;label:string;count:number;auxiliary:boolean}>();
  for(const p of owner.interfaces.filter(p=>p.role===role)){
   const g=interfaceGroup(model,{moduleId:scope,interfaceId:p.id}),row=groups.get(g.id)??{id:g.id,label:g.label,count:0,auxiliary:g.auxiliary};
   row.count++;groups.set(g.id,row);
  }return [...groups.values()];
 };
 const racks=(['consumer','producer'] as const).map(role=>({role,groups:groupRows(role)}));
 // The input/output channels need room for their names too, independent of module spacing.
 const boundaryLabels=[...inspection.stored.filter(l=>[l.from,l.to].some(e=>e.moduleId===scope&&!e.local)).map(l=>linkGroup(model,l).label),...dependencies.filter(d=>d.from.moduleId===scope&&!d.from.local).map(d=>d.group.label)];
 const boundaryGap=Math.max(160,...boundaryLabels.map(label=>[...label].reduce((w,c)=>w+(c.charCodeAt(0)>255?16:8.5),0)+96));
 const frameMargin=174+boundaryGap;
 const nodeId=(e:Endpoint)=>e.local?`local:${scope}:${e.interfaceId}`:e.moduleId===scope?`rack:${scope}:${owner.interfaces.find(p=>p.id===e.interfaceId)?.role}`:e.moduleId;
 const declaredFeedback=(from:Endpoint,to:Endpoint)=>options.reading?.feedback?.find(f=>f.from===nodeId(from)&&f.to===nodeId(to));
 // Port anchors come from all stored links, so selection or folding never moves them.
 const anchorGroups=new Map<string,{in:Set<string>;out:Set<string>}>();
 for(const link of inspection.stored){
  for(const [end,direction] of [[link.from,'out'],[link.to,'in']] as const){
   const id=nodeId(end),entry=anchorGroups.get(id)??{in:new Set<string>(),out:new Set<string>()};
   const group=linkAnchorGroup(model,scope,end,link,mode==='signals');
   entry[direction].add(group);anchorGroups.set(id,entry);
  }
 }
 for(const dependency of dependencies){
  for(const [end,direction,group] of [[dependency.from,'out',dependency.fromGroup],[dependency.to,'in',dependency.toGroup]] as const){
   const id=nodeId(end),entry=anchorGroups.get(id)??{in:new Set<string>(),out:new Set<string>()};
   entry[direction].add(group);anchorGroups.set(id,entry);
  }
 }
 const geometryFor=(id:string)=>{
  const groups=anchorGroups.get(id),count=Math.max(groups?.in.size??0,groups?.out.size??0,1),height=Math.max(baseHeight,32+count*18);
  const ports:PortGeometry[]=[];
  for(const side of ['in','out'] as const){
   const ids=[...(groups?.[side]??[])].sort();
   // Dedicated dependency anchor, separate from business groups.
   ports.push({id:side,direction:side==='in'?'target':'source',side:side==='in'?'WEST':'EAST',x:side==='in'?0:width,y:height-24});
   ids.forEach((group,i)=>ports.push({id:`${side}:${group}`,direction:side==='in'?'target':'source',side:side==='in'?'WEST':'EAST',x:side==='in'?0:width,y:26+i*18}));
  }return {width,height,ports};
 };
 const nodes:RtlNode[]=children.map((m,i)=>{
  const geometry=geometryFor(m.id);
  return {id:m.id,type:'rtlModule',position:options.positions?.[m.id]??{x:i*420,y:120},width,height:geometry.height,
   style:{opacity:focus&&!focused.has(m.id)?0.65:1},data:{label:m.name,moduleId:m.id,kind:m.kind,rtlModule:m.rtlModule,boundary:false,summary:excerpt(m.contract.responsibility),title:`${m.name}\nRTL: ${m.rtlModule}\n${m.instances?.sourcePath??m.id}`,instanceCount:instanceCount(m),arrayIndex:inspection.array?.moduleId===m.id?inspection.array.index:undefined,mainDiagram:true,ports:geometry.ports.map(p=>({id:p.id,width:undefined})),geometry}};
 });
 const minX=Math.min(0,...nodes.map(n=>n.position.x));
 const preferredColumns=visibleLocals.length?Math.min(3,Math.ceil(Math.sqrt(visibleLocals.length+children.length))):0;
 const maxX=Math.max(width,...nodes.map(n=>n.position.x+width),minX+preferredColumns*(width+52)-52);
 const minY=Math.min(120,...nodes.map(n=>n.position.y)),maxY=Math.max(120+baseHeight,...nodes.map(n=>n.position.y+(n.height??baseHeight)));
 // Expand the frame when needed, balancing local rows without moving modules.
 const columns=Math.max(1,Math.floor((maxX-minX+52)/(width+52)));
 let rowY=maxY+116;
 for(let i=0;i<visibleLocals.length;i+=columns){
  const row=visibleLocals.slice(i,i+columns),heights=row.map(local=>geometryFor(`local:${scope}:${local.id}`).height);
  row.forEach((local,j)=>{
   const id=`local:${scope}:${local.id}`,geometry=geometryFor(id);
   nodes.push({id,type:'rtlModule',position:options.positions?.[id]??{x:minX+j*(width+52),y:rowY},width,height:geometry.height,data:{label:local.name,moduleId:scope,kind:local.driver.kind==='register'?'state':'local',boundary:false,localId:local.id,mainDiagram:true,summary:excerpt(local.description),statePattern:stateDescription(local)?.pattern,title:local.description+(stateDescription(local)?'\n'+stateDescription(local)!.rows.map(r=>r.condition+' → '+r.action).join('\n'):''),geometry,ports:geometry.ports.map(p=>({id:p.id,width:undefined}))},style:{opacity:focus&&!inspection.localIds.includes(local.id)?.65:1}});
  });rowY+=Math.max(...heights)+54;
 }
 const allMinX=Math.min(minX,...nodes.map(n=>n.position.x)),allMinY=Math.min(minY,...nodes.map(n=>n.position.y));
 const bottom=Math.max(maxY,...nodes.map(n=>n.position.y+(n.height??baseHeight)));
 const rackHeight=Math.max(0,...racks.map(r=>r.groups.length*44+64));
 const frame={id:`frame:${scope}`,position:{x:allMinX-frameMargin,y:allMinY-108},width:maxX-allMinX+frameMargin*2,height:Math.max(bottom-allMinY+186,rackHeight+148)};
 nodes.unshift({id:frame.id,type:'rtlModule',position:frame.position,width:frame.width,height:frame.height,draggable:false,selectable:false,zIndex:-1,data:{label:owner.name,moduleId:scope,kind:'frame',boundary:true,geometry:{width:frame.width,height:frame.height,ports:[]},ports:[],summary:`${children.length} 个模块${localSignals.length?` · ${localSignals.length} 项内部逻辑`:''}`}});
 for(const {role,groups} of racks){
  if(!groups.length)continue;
  const direction=role==='consumer'?'source':'target',side=direction==='source'?'out':'in';
  const ports:PortGeometry[]=groups.map((g,i)=>({id:`${side}:${g.id}`,direction,side:direction==='source'?'EAST':'WEST',x:direction==='source'?156:0,y:66+i*44}));
  ports.push({id:side,direction,side:direction==='source'?'EAST':'WEST',x:direction==='source'?156:0,y:42});
  nodes.push({id:`rack:${scope}:${role}`,type:'rtlModule',position:{x:role==='consumer'?frame.position.x+18:frame.position.x+frame.width-174,y:frame.position.y+78},width:156,height:groups.length*44+56,draggable:false,selectable:false,data:{label:role==='consumer'?'输入':'输出',moduleId:scope,kind:'rack',boundary:true,role,groups,summary:'当前层级接口',ports:ports.map(p=>({id:p.id,width:undefined})),geometry:{width:156,height:groups.length*44+56,ports}}});
 }
 const visibleIds=new Set(nodes.map(n=>n.id)),selectedIds=new Set(inspection.links.map(l=>l.id));
 const omissions:{connectionId:string;reason:string}[]=[];const bundles=new Map<string,Edge>();let auxiliaryCount=0,foldedLocalCount=0;
 for(const link of inspection.stored){
  const relation=relationshipById.get(link.id)!;
  const group=linkGroup(model,link),selected=focus&&selectedIds.has(link.id);
  if(group.auxiliary&&!options.showAuxiliary&&!selected&&!declaredFeedback(link.from,link.to)){auxiliaryCount++;omissions.push({connectionId:link.id,reason:'显式时钟/配置折叠'});continue;}
  const from=nodeId(link.from),to=nodeId(link.to);
  if(!visibleIds.has(from)||!visibleIds.has(to)){foldedLocalCount++;omissions.push({connectionId:link.id,reason:'内部节点未展开'});continue;}
  const fromGroup=linkAnchorGroup(model,scope,link.from,link,mode==='signals');
  const toGroup=linkAnchorGroup(model,scope,link.to,link,mode==='signals');
  const key=`relation:${from}>${to}/${fromGroup}/${toGroup}/${group.id}/${relation.kind}${mode==='signals'||relation.kind==='ready_valid'?'/'+link.id:''}`,color=diagramColors[group.category]??diagramColors.other;
  const edge=bundles.get(key)??{id:key,source:from,sourceHandle:`out:${fromGroup}`,target:to,targetHandle:`in:${toGroup}`,type:'relationship',reconnectable:false,markerEnd:{type:MarkerType.ArrowClosed,color,width:16,height:16},data:{connectionIds:[] as string[],category:group.category,title:group.description+'\n'+relation.meaning,semanticKind:relation.kind,classification:relation.classification,members:relation.members,selected:false,color},style:{stroke:color,opacity:focus?0.12:0.86,strokeWidth:1.7}};
  (edge.data!.connectionIds as string[]).push(link.id);
  if(selected){edge.data!.selected=true;edge.style={stroke:color,opacity:1,strokeWidth:2.6};}
  edge.label=(mode==='signals'?`${endpointLabel(link.from)} → ${endpointLabel(link.to)} · ${relation.width??'?'}b`:group.label)+(relation.kind==='ready_valid'?' [RV →data/valid ←ready]':'')+((edge.data!.connectionIds as string[]).length>1?` ×${(edge.data!.connectionIds as string[]).length}`:'');bundles.set(key,edge);
 }
 const edges=[...bundles.values()].sort((a,b)=>a.id.localeCompare(b.id));
 let foldedDependencyCount=0;
 for(const dependency of dependencies){
  const {from: endpoint,localId,group,endpoints}=dependency;
  const source=nodeId(endpoint),target=`local:${scope}:${localId}`;
  if(!visibleIds.has(target))continue;
  if((group.auxiliary&&!options.showAuxiliary&&!declaredFeedback(dependency.from,dependency.to))||!visibleIds.has(source)){foldedDependencyCount+=endpoints.length;continue;}
  const color=diagramColors[group.category]??diagramColors.other;
  const selected=!focus||inspection.dependencies.some(d=>d.localId===localId&&endpoints.some(e=>endpointLabel(d.endpoint)===endpointLabel(e)));
  edges.push({id:dependency.id,source,target,sourceHandle:`out:${dependency.fromGroup}`,targetHandle:`in:${dependency.toGroup}`,type:'relationship',label:group.label,reconnectable:false,
   data:{localSignalId:localId,dependencyEndpoint:endpoint,dependencyEndpoints:endpoints,semanticKind:'dependency',dependencyRole:dependency.role,category:group.category,relationBundle:endpoints.length>1,title:(dependency.role==='state_unknown'?'状态输入集合；数据/使能/取消和逐位关系尚未表达\n':'模型表达式依赖；不是一条直接物理线\n')+endpoints.map(endpointLabel).join('\n'),color,granularity:dependency.role==='state_unknown'?'input_set':'expression'},
   style:{stroke:color,strokeWidth:endpoints.length>1?2.4:1.8,opacity:selected?1:.24},markerEnd:{type:MarkerType.Arrow,color}});
 }

 if(focus)for(const node of nodes){
  const selected=inspection.links.flatMap(l=>[l.from,l.to]).filter(e=>nodeId(e)===node.id);
  node.data.inspectedPorts=[...new Set(selected.map(e=>`${e.interfaceId}${e.slice?`[${e.slice.msb}:${e.slice.lsb}]`:''} · ${resolveEndpoint(model,scope,e)?.width??'?'}位`))];
 }
 for(const node of nodes)node.data.activeHandles=edges.flatMap(e=>[...(e.source===node.id?[e.sourceHandle]:[]),...(e.target===node.id?[e.targetHandle]:[])]);
 const lanes=new Map<string,Edge[]>();
 for(const edge of edges){const key=`${edge.source}>${edge.target}`;lanes.set(key,[...lanes.get(key)??[],edge])}
 let feedbackLane=0;
 for(const siblings of lanes.values())siblings.forEach((edge,index)=>{
  const source=nodes.find(n=>n.id===edge.source)!,target=nodes.find(n=>n.id===edge.target)!,feedback=source.position.x>=target.position.x;
  edge.data={...edge.data,feedback,laneOffset:(index-(siblings.length-1)/2)*30,routeY:feedback?minY-44-feedbackLane++*30:undefined};
 });
 for(const edge of edges){
  const feedback=options.reading?.feedback?.find(f=>f.from===edge.source&&f.to===edge.target);
  if(feedback)edge.data={...edge.data,readingFeedback:feedback.side};
  const sources=inspection.stored.filter(l=>(edge.data?.connectionIds as string[]??[]).includes(l.id)).map(l=>[l.from.moduleId,l.from.interfaceId,l.from.index??null,l.from.local??false,l.from.slice??null,l.from.sliceMapping??null]);
  if(sources.length&&edge.data?.semanticKind==='wire')edge.data={...edge.data,netKey:JSON.stringify([...new Set(sources.map(s=>JSON.stringify(s)))].sort())};
 }
 orientPorts(nodes,model,scope,inspection.stored,nodeId,dependencies,mode==='signals',options.reading?.feedback,options.reading?.shared);
 // Spread boundary groups toward their connected ports; keep each declared group intact.
 // All stored relations participate so selection and auxiliary folding cannot move pins.
 const boundaryRelations=[...inspection.stored.map(link=>({from:link.from,to:link.to,fromGroup:linkAnchorGroup(model,scope,link.from,link,mode==='signals'),toGroup:linkAnchorGroup(model,scope,link.to,link,mode==='signals')})),...dependencies];
 for(const rack of nodes.filter(n=>n.data.kind==='rack')){
  const groups=rack.data.groups as {id:string;label:string;count:number}[];
  const rows=groups.map((group,index)=>{
   const ys=boundaryRelations.flatMap(link=>{
    const source=nodeId(link.from)===rack.id&&link.fromGroup===group.id,target=nodeId(link.to)===rack.id&&link.toGroup===group.id;
    if(!source&&!target)return [];
    const other=nodes.find(n=>n.id===nodeId(source?link.to:link.from));
    const port=other?.data.geometry.ports.find(p=>p.id===`${source?'in':'out'}:${source?link.toGroup:link.fromGroup}`);
    return other&&port?[other.position.y+port.y-rack.position.y]:[];
   });
   return {group,desired:ys.length?ys.reduce((a,b)=>a+b,0)/ys.length:66+index*44};
  }).sort((a,b)=>a.desired-b.desired||a.group.id.localeCompare(b.group.id));
  let previous=22;
  for(const row of rows){const y=Math.max(previous+44,row.desired);previous=y;const port=rack.data.geometry.ports.find(p=>p.id.endsWith(':'+row.group.id));if(port)port.y=y;}
  rack.data.groups=rows.map(r=>r.group);rack.height=rack.data.geometry.height=previous+34;
 }
 const contentRight=Math.max(minX+width,...nodes.filter(n=>!n.data.boundary).map(n=>n.position.x+n.data.geometry.width));
 const outputRack=nodes.find(n=>n.id===`rack:${scope}:producer`);if(outputRack)outputRack.position.x=contentRight+boundaryGap;
 frame.width=contentRight-allMinX+frameMargin*2;nodes[0].width=frame.width;nodes[0].data.geometry.width=frame.width;
 const graph={reading:options.reading,omissions,mode,modeLabel:viewNames[mode],semantics,nodes,edges,inspection,frame,auxiliaryCount,foldedLocalCount,foldedDependencyCount,localCount:localSignals.length,stateCount:localSignals.filter(n=>n.driver.kind==='register').length};
 for(const stage of options.reading?.stages??[]){
  const members=nodes.filter(n=>stage.nodes.includes(n.id));if(!members.length)continue;
  const left=Math.min(...members.map(n=>n.position.x))-24,top=Math.min(...members.map(n=>n.position.y))-60;
  const right=Math.max(...members.map(n=>n.position.x+n.data.geometry.width))+24,bottom=Math.max(...members.map(n=>n.position.y+n.data.geometry.height))+24;
  nodes.splice(1,0,{id:`stage:${scope}:${stage.id}`,type:'rtlModule',position:{x:left,y:top},width:right-left,height:bottom-top,draggable:false,selectable:false,zIndex:-1,data:{label:stage.label,moduleId:scope,kind:'region',boundary:true,summary:stage.note??'阅读分区 · 非 RTL 实例',geometry:{width:right-left,height:bottom-top,ports:[]},ports:[]}});
 }
 // Port reorientation may grow a node, including in measurement-only layout passes.
 const contentBottom=Math.max(frame.position.y+frame.height,...nodes.slice(1).map(n=>n.position.y+n.data.geometry.height+34));
 frame.height=contentBottom-frame.position.y;nodes[0].height=frame.height;nodes[0].data.geometry.height=frame.height;
 if(!options.measureOnly)return routeDiagram(graph);
 return graph;
}
export type ScopeDiagram=ReturnType<typeof scopeDiagram>;
/** Shared by the Worker, CLI and SVG export; mutates only newly constructed geometry. */
export function routeDiagram<T extends {nodes:RtlNode[];edges:Edge[];frame:{position:{x:number;y:number};width:number;height:number}}>(graph:T):T{
 const {nodes,edges,frame}=graph;
 routeEdges(nodes,edges);annotateWireNets(edges);
 // Return paths belong inside the scope too.
 const points=edges.flatMap(e=>(e.data?.routePoints as {x:number;y:number}[]|undefined)??[]);
 const routeTop=Math.min(frame.position.y,...points.map(p=>p.y-34));
 if(routeTop<frame.position.y){frame.height+=frame.position.y-routeTop;frame.position={...frame.position,y:routeTop};const node=nodes[0];node.position=frame.position;node.height=frame.height;node.data.geometry.height=frame.height;}
 const routeBottom=Math.max(frame.position.y+frame.height,...points.map(p=>p.y+34),...nodes.slice(1).map(n=>n.position.y+n.data.geometry.height+34));
 frame.height=routeBottom-frame.position.y;nodes[0].height=frame.height;nodes[0].data.geometry.height=frame.height;
 const routeLeft=Math.min(frame.position.x,...points.map(p=>p.x-34));
 const routeRight=Math.max(frame.position.x+frame.width,...points.map(p=>p.x+34));
 frame.position={...frame.position,x:routeLeft};frame.width=routeRight-routeLeft;
 nodes[0].position=frame.position;nodes[0].width=frame.width;nodes[0].data.geometry.width=frame.width;
 return graph;
}
