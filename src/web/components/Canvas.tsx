import {viewNames,type ViewMode} from '../../core/hardwareView';
import type {diagramQuality} from '../graph/quality';
import {useEffect,useMemo,useRef,useState} from 'react';
import {ReactFlow,Controls,MiniMap,getNodesBounds,getViewportForBounds,useReactFlow,type Viewport} from '@xyflow/react';
import {layoutSchema,type Endpoint,type Link,type Model,type ScopeLayout} from '../../core/schema';
import type {Snapshot} from '../../core/api';
import {inspectScope,type Inspection} from '../../core/inspection';
import {diagramSvg} from '../graph/exportSvg';
import {type ScopeDiagram,type Positions} from '../graph/scopeDiagram';
import {DiagramClient} from '../graph/diagramClient';
import {highlightDiagram} from '../graph/selection';
import type {RtlNode} from '../graph/types';
import {portDetailZoom} from '../graph/ports';
import {ModuleNode} from './ModuleNode';
import {RelationshipEdge} from './RelationshipEdge';
const nodeTypes={rtlModule:ModuleNode},edgeTypes={relationship:RelationshipEdge};
export type ScopeView={mode?:ViewMode;modeViews?:Partial<Record<ViewMode,{positions?:Positions;viewport?:Viewport}>>;reading?:ScopeLayout['reading'];positions?:Positions;viewport?:Viewport;inspection?:Inspection;showAuxiliary?:boolean;showLocals?:boolean;showState?:boolean;selectedId?:string;checkpoint?:{inspection?:Inspection;viewport?:Viewport;selectedId?:string;showAuxiliary?:boolean;showLocals?:boolean};restoreTick?:number};
export function Canvas({view,changeView,selectLocal,model,modelHash,scope,select,enter,selectEdge,report,selectedId,reviews,readOnly,layout,saveLayout}: {
 view:ScopeView;changeView:(patch:Partial<ScopeView>)=>void;selectLocal:(id:string,endpoints?:Endpoint[])=>void;selectedId:string;reviews:Snapshot['moduleReviews'];readOnly:boolean;
 model:Model;modelHash:string;scope:string;layout?:ScopeLayout;layoutHash:string;
 select:(id:string)=>void;enter:(id:string)=>void;connect:(link:Link,replaceId?:string)=>void;
 selectEdge:(ids:string[])=>void;saveLayout:(scope:string,layout:ScopeLayout)=>Promise<void>;report:(text:string)=>void;
}){
 const flow=useReactFlow<RtlNode>(),container=useRef<HTMLDivElement>(null),[layingOut,setLayingOut]=useState(false),[previousPositions,setPreviousPositions]=useState<Positions>();
 const reading=Object.hasOwn(view,'reading')?view.reading:layout?.reading;
 const latest=useRef({view,changeView,model,scope});latest.current={view,changeView,model,scope};
 const client=useRef<DiagramClient|null>(null);if(!client.current)client.current=new DiagramClient();
 const [graph,setGraph]=useState<ScopeDiagram>(),[routing,setRouting]=useState(false),[routeError,setRouteError]=useState(''),[drag,setDrag]=useState<{id:string;position:{x:number;y:number}}>();
 const inspection=useMemo(()=>inspectScope(model,scope,view.inspection),[model,scope,view.inspection]);
 const options=useMemo(()=>({mode:view.mode,positions:view.positions,inspection:view.inspection,showAuxiliary:view.showAuxiliary,showLocals:view.showLocals,showState:view.showState,reading}),[view.mode,view.positions,view.inspection,view.showAuxiliary,view.showLocals,view.showState,reading]);
 const [quality,setQuality]=useState<ReturnType<typeof diagramQuality>>();
 const previousMode=useRef(view.mode);
 const generation=useRef(0);
 async function compute(arrange:boolean,fit:boolean){
  const ticket=++generation.current;setRouting(true);setRouteError('');
  try{
   const result=await client.current!.run(model,scope,modelHash,options,arrange);
   if(ticket!==generation.current)return;
   setGraph(result.graph);setQuality(result.quality);
   if(fit){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));if(ticket!==generation.current)return;const bounds=getNodesBounds(result.graph.nodes);const viewport=getViewportForBounds(bounds,container.current?.clientWidth??900,container.current?.clientHeight??600,0.15,1,0.1);if(viewport.zoom<.65){const first=result.graph.nodes.find(n=>n.id===reading?.mainPath[0])??result.graph.nodes.filter(n=>!n.data.boundary).sort((a,b)=>a.position.x-b.position.x)[0];if(first){viewport.zoom=.65;viewport.x=48-first.position.x*.65;viewport.y=((container.current?.clientHeight??600)-bounds.height*.65)/2-bounds.y*.65;}}await flow.setViewport(viewport);latest.current.changeView({viewport});}
   else if(!graph&&view.viewport)void flow.setViewport(view.viewport);
   if(arrange){setPreviousPositions(view.positions);latest.current.changeView({positions:result.positions});}
  }catch(e){if(ticket===generation.current&&String(e)!=='Error: DIAGRAM_CANCELLED')setRouteError(String(e));}
  finally{if(ticket===generation.current){setRouting(false);setLayingOut(false)}}
 }
 async function arrange(){setLayingOut(true);await compute(true,true)}
 useEffect(()=>{
  const required=[...model.modules.filter(m=>m.parent===scope).map(m=>m.id),...(model.localSignals??[]).filter(n=>n.scope===scope&&n.driver.kind==='register'&&view.showState!==false).map(n=>`local:${scope}:${n.id}`)];
  const missing=!view.positions||required.some(id=>!view.positions?.[id]);
  const changedMode=previousMode.current!==view.mode;previousMode.current=view.mode;
  void compute(missing,(!graph||changedMode)&&(!view.viewport||missing));
  return()=>{generation.current++;client.current?.cancel()};
 },[model,modelHash,scope,options]);
 useEffect(()=>()=>client.current?.dispose(),[]);
 // Keep the same graph center and zoom when docks/sidebar resize the canvas. No relayout.
 useEffect(()=>{const element=container.current;if(!element)return;let previous:{width:number;height:number}|undefined;const observer=new ResizeObserver(()=>{const width=element.clientWidth,height=element.clientHeight;if(width<1||height<1)return;const old=previous;previous={width,height};if(!old||Math.abs(width-old.width)+Math.abs(height-old.height)<2)return;const before=flow.getViewport(),viewport={...before,x:before.x+(width-old.width)/2,y:before.y+(height-old.height)/2};void flow.setViewport(viewport);latest.current.changeView({viewport});});observer.observe(element);return()=>observer.disconnect();},[!!graph]);
 useEffect(()=>{if(view.restoreTick&&view.viewport)void flow.setViewport(view.viewport)},[view.restoreTick]);
 const styled=useMemo(()=>graph?(view.inspection?{nodes:graph.nodes,edges:graph.edges}:highlightDiagram(graph,selectedId)):undefined,[graph,selectedId,view.inspection]);
 const nodes=(styled?.nodes??[]).map(n=>({...n,position:drag?.id===n.id?drag.position:n.position,selected:!n.data.boundary&&!n.data.localId&&n.data.moduleId===selectedId,data:{...n.data,inspectGroup:(groupId:string)=>changeView({viewport:flow.getViewport(),inspection:{kind:'boundary',role:n.data.role as 'consumer'|'producer',groupId}}),reviewStatus:reviews.find(r=>r.moduleId===n.data.moduleId)?.status??'DRAFT'}}));
 if(!graph)return <section className="canvas-shell"><div className="routing-status" role="status">{routeError||'正在后台准备框图；可先选择模块阅读详情。'}{routeError&&<button onClick={()=>void compute(true,true)}>重新绘图</button>}</div><div ref={container} className="canvas" data-testid="canvas"/></section>;
 const inspectionLabel=view.inspection?.kind==='array'?`检查元素 [${view.inspection.index}]` :view.inspection?.kind==='connection'?'检查信号':view.inspection?.kind==='local'?(view.inspection.purpose==='data'?'数据从哪里来':view.inspection.purpose==='control'?'什么时候更新':'检查内部驱动'):view.inspection?.kind==='boundary'?'检查层级接口':view.inspection?'检查相邻关系':'总览';
 return <section className="canvas-shell"><div className="canvas-toolbar"><span>{model.modules.filter(m=>m.parent===scope).length} 个子模块 · {graph.inspection.stored.length} 条已记录连接 · {inspectionLabel}</span><div className="actions"><label>阅读模式 <select aria-label="阅读模式" value={view.mode??'architecture'} onChange={e=>{const mode=e.target.value as ViewMode,current=view.mode??'architecture',modeViews={...view.modeViews,[current]:{positions:view.positions,viewport:flow.getViewport()}};changeView({mode,modeViews,positions:modeViews[mode]?.positions,viewport:modeViews[mode]?.viewport,restoreTick:modeViews[mode]?.viewport?(view.restoreTick??0)+1:view.restoreTick,inspection:undefined})}}>{Object.entries(viewNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><button data-testid="trace-module" onClick={()=>changeView({viewport:flow.getViewport(),inspection:{kind:'module',id:selectedId}})}>查看直接连接</button>{graph.stateCount>0&&<button data-testid="show-state" disabled={!!view.mode&&view.mode!=='architecture'} aria-pressed={view.showState!==false} onClick={()=>changeView({showState:view.showState===false})}>寄存状态 · {graph.stateCount}</button>}<button data-testid="show-auxiliary" disabled={view.mode==='signals'||view.inspection?.kind==='local'&&view.inspection.purpose==='control'} aria-pressed={!!view.showAuxiliary||view.mode==='signals'||view.inspection?.kind==='local'&&view.inspection.purpose==='control'} onClick={()=>changeView({showAuxiliary:!view.showAuxiliary})}>时钟 / 配置{graph.auxiliaryCount?` · 折叠 ${graph.auxiliaryCount} 条`:''}</button><button data-testid="show-locals" disabled={!!view.mode&&view.mode!=='architecture'} aria-pressed={!!view.showLocals} onClick={()=>changeView({showLocals:!view.showLocals})}>全部内部逻辑 · {graph.localCount}</button>{view.inspection&&<button data-testid="exit-inspection" onClick={()=>changeView({inspection:undefined})}>退出检查</button>}<button title="导出当前层级的矢量图，保留折叠状态和不完整标记" data-testid="export-diagram" disabled={routing} onClick={()=>{const url=URL.createObjectURL(new Blob([diagramSvg(model,scope,{...view,reading,showPortNames:flow.getViewport().zoom>=portDetailZoom},modelHash,graph)],{type:'image/svg+xml'}));const link=document.createElement('a');link.href=url;link.download=`${scope.replace(/[^a-zA-Z0-9_-]/g,'_')}-architecture.svg`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>导出图</button>{previousPositions&&<button onClick={()=>{changeView({positions:previousPositions});setPreviousPositions(undefined)}}>撤销布局</button>}{!readOnly&&<button onClick={()=>void saveLayout(scope,{positions:latest.current.view.positions??{},viewport:flow.getViewport(),...(reading?{reading}:{})}).then(()=>report('布局已保存；架构批准不变。')).catch(e=>report(String(e)))}>保存布局</button>}<button onClick={()=>{const data={schemaVersion:1,scopes:{[scope]:{positions:view.positions??{},viewport:flow.getViewport(),...(reading?{reading}:{})}}};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${scope}-${modelHash.slice(0,12)}-layout.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>下载布局</button><button onClick={()=>document.getElementById(`layout-file-${scope}`)?.click()}>导入布局</button><button title="放大当前模块或主通路起点；可沿连线平移，左下角可恢复全图" data-testid="reading-size" onClick={()=>{const node=graph.nodes.find(n=>!n.data.boundary&&n.id===selectedId)??graph.nodes.find(n=>n.id===reading?.mainPath[0])??graph.nodes.find(n=>!n.data.boundary);if(node)void flow.setCenter(node.position.x+node.data.geometry.width/2,node.position.y+node.data.geometry.height/2,{zoom:0.9})}}>阅读大小</button><button data-testid="auto-layout" disabled={layingOut} onClick={()=>void arrange()}>{layingOut?'布局中…':'自动布局'}</button></div></div>
 <input type="file" accept="application/json,.json" hidden id={`layout-file-${scope}`} data-testid="layout-file" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;void (async()=>{if(file.size>8*1024*1024)throw new Error('布局文件超过 8 MiB');const plan=layoutSchema.parse(JSON.parse(await file.text())).scopes[scope];if(!plan)throw new Error('布局文件没有当前层级');if(plan.reading&&plan.reading.modelHash!==modelHash)throw new Error('布局对应旧模型，请核对来源');changeView({reading:plan.reading,positions:plan.positions,viewport:plan.viewport});await flow.setViewport(plan.viewport);report(readOnly?'已载入候选展示布局；可下载布局供下次导入，候选架构不变。':'已载入本层展示布局；点击保存布局后持久化，架构批准不变。')})().catch(e=>report(String(e)))}}/>
 {view.viewport&&view.viewport.zoom<0.6&&<div className="graph-note">当前为全图缩略视图；点击“阅读大小”看清文字，再沿连线平移。</div>}
 {graph.edges.some(e=>e.data?.routingFallback)&&<div className="graph-note">部分连线无法绕开当前模块位置；可用自动布局重新排列。</div>}
 {graph.edges.some(e=>e.data?.labelHidden)&&<div className="graph-note">有线名未能排下：请调整模块间距或自动布局；悬停可核对完整名称。</div>}
 {routing&&<div className="routing-status" role="status">正在后台更新连线；保留上一份图，模块详情仍可查看。</div>}
 {routeError&&<div className="graph-note" role="alert">{routeError}<button onClick={()=>void compute(false,false)}>重试绘图</button></div>}
 {graph.edges.some(e=>e.data?.routingSimplified)&&<div className="graph-note">密集区域使用简化避障路径；连线未删减，拥挤处可逐层追踪。</div>}
 <div className="wire-legend">{graph.modeLabel} · RV：data/valid →，ready ← · 实心箭头为连接，空心箭头为依赖 · 输入集合未分角色，更新规则为声明；位置不表示周期</div>
 <details className="diagram-audit"><summary>框图检查 · 连接对应 {quality?.structuralFidelity.status==='passed'?'完整':'需修正'} · 语义 {quality?.semanticClarity.status==='no_detected_issue'?'未发现冲突':'待核对'} · 几何 {quality?.status==='passed'?'完整':'需修正'} · 阅读 {quality?.geometricReadability.status==='clear'?'未发现拥挤':'需留意'}</summary><p>这是图对模型的检查，不是 RTL 正确性或人工可读性证明。</p><p>交叉 {quality?.crossings} · 未排下线名 {quality?.hiddenLabels.length} · 有说明的折叠 {graph.omissions.length}</p>{graph.semantics.issues.slice(0,20).map((i,n)=><p key={n}><strong>{i.target}</strong>：{i.reason}</p>)}{graph.semantics.issues.length>20&&<p>另有 {graph.semantics.issues.length-20} 项；按层级或原始连接继续核对。</p>}</details>
 <div ref={container} className="canvas" data-testid="canvas"><ReactFlow<RtlNode> nodes={nodes} viewport={view.viewport} onViewportChange={viewport=>{const old=latest.current.view.viewport;if(!old||old.x!==viewport.x||old.y!==viewport.y||old.zoom!==viewport.zoom)latest.current.changeView({viewport})}} edges={styled!.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesConnectable={false} edgesReconnectable={false} nodesDraggable={!routing} zoomOnDoubleClick={false} minZoom={0.15} maxZoom={2} deleteKeyCode={null}
 onNodeClick={(event,node)=>{if(['frame','region'].includes(node.data.kind))return;if(node.data.kind==='rack'){changeView({viewport:flow.getViewport(),inspection:{kind:'boundary',role:node.data.role as 'consumer'|'producer'}});return;}if(node.data.localId){selectLocal(String(node.data.localId));return;}const portId=(event.target as Element).closest('[data-port-id]')?.getAttribute('data-port-id');if(portId){const ids=graph.edges.filter(e=>(e.source===node.id&&e.sourceHandle===portId)||(e.target===node.id&&e.targetHandle===portId)).flatMap(e=>(e.data?.connectionIds as string[])??[]);if(ids.length){changeView({viewport:flow.getViewport(),inspection:{kind:'connection',ids}});selectEdge(ids);return;}}select(node.data.moduleId)}}
 onNodeDoubleClick={(_event,node)=>{if(node.data.kind==='subsystem'&&!node.data.boundary)enter(node.id)}}
 onEdgeClick={(_event,edge)=>{if(edge.data?.localSignalId){selectLocal(String(edge.data.localSignalId),edge.data.dependencyEndpoints as Endpoint[]);return;}const ids=edge.data?.connectionIds as string[];if(ids){changeView({viewport:flow.getViewport(),inspection:{kind:'connection',ids}});selectEdge(ids)}}}
 onNodeDrag={(_event,node)=>setDrag({id:node.id,position:node.position})}
 onNodeDragStop={(_event,node)=>{setDrag(undefined);changeView({positions:{...latest.current.view.positions,[node.id]:node.position}})}}
 onMoveEnd={(_event,viewport)=>changeView({viewport})}>
 <MiniMap pannable zoomable onClick={(_event,position)=>void flow.setCenter(position.x,position.y,{zoom:flow.getZoom()})} position="bottom-right" style={{width:150,height:90}} nodeColor={n=>n.data.boundary?'transparent':n.data.kind==='state'?'#99b99a':n.data.kind==='memory'?'#d7c299':'#a1bdcc'} nodeStrokeWidth={1} ariaLabel="全图导航"/>
 <Controls showInteractive={false} fitViewOptions={{padding:0.12,maxZoom:1}}/>
 </ReactFlow></div>
 {(graph.foldedLocalCount>0||graph.foldedDependencyCount>0)&&<div className="graph-note">{graph.foldedLocalCount} 条连接、{graph.foldedDependencyCount} 条内部依赖暂未显示：按需展开内部逻辑或时钟 / 配置。<span>×N 为连接条数，N 项为内部输入依赖数量</span></div>}
 </section>;
}
