import {useEffect,useMemo,useRef,useState} from 'react';
import {ReactFlow,Controls,getNodesBounds,getViewportForBounds,useReactFlow,type Viewport} from '@xyflow/react';
import {layoutSchema,type Link,type Model,type ScopeLayout} from '../../core/schema';
import type {Snapshot} from '../../core/api';
import {inspectScope,type Inspection} from '../../core/inspection';
import {diagramSvg} from '../graph/exportSvg';
import {scopeDiagram,type Positions} from '../graph/scopeDiagram';
import {arrangeScope} from '../graph/readingLayout';
import type {RtlNode} from '../graph/types';
import {portDetailZoom} from '../graph/ports';
import {ModuleNode} from './ModuleNode';
import {RelationshipEdge} from './RelationshipEdge';
const nodeTypes={rtlModule:ModuleNode},edgeTypes={relationship:RelationshipEdge};
export type ScopeView={positions?:Positions;viewport?:Viewport;inspection?:Inspection;showAuxiliary?:boolean;showLocals?:boolean;selectedId?:string;checkpoint?:{inspection?:Inspection;viewport?:Viewport;selectedId?:string;showAuxiliary?:boolean;showLocals?:boolean};restoreTick?:number};
export function Canvas({view,changeView,selectLocal,model,modelHash,scope,select,enter,selectEdge,report,selectedId,reviews,readOnly,layout,saveLayout}: {
 view:ScopeView;changeView:(patch:Partial<ScopeView>)=>void;selectLocal:(id:string)=>void;selectedId:string;reviews:Snapshot['moduleReviews'];readOnly:boolean;
 model:Model;modelHash:string;scope:string;layout?:ScopeLayout;layoutHash:string;
 select:(id:string)=>void;enter:(id:string)=>void;connect:(link:Link,replaceId?:string)=>void;
 selectEdge:(ids:string[])=>void;saveLayout:(scope:string,layout:ScopeLayout)=>Promise<void>;report:(text:string)=>void;
}){
 const flow=useReactFlow<RtlNode>(),container=useRef<HTMLDivElement>(null),[layingOut,setLayingOut]=useState(false),[previousPositions,setPreviousPositions]=useState<Positions>(),[reading,setReading]=useState(layout?.reading);
 const latest=useRef({view,changeView,model,scope});latest.current={view,changeView,model,scope};
 const inspection=useMemo(()=>inspectScope(model,scope,view.inspection),[model,scope,view.inspection]);
 const graph=useMemo(()=>scopeDiagram(model,scope,view,inspection),[model,scope,view.positions,view.showAuxiliary,view.showLocals,inspection]);
 async function arrange(){
  setLayingOut(true);const {model,scope,view}=latest.current;
  try{
   const positions=await arrangeScope(model,scope,modelHash,reading);
   setPreviousPositions(view.positions);
   if(latest.current.scope!==scope||latest.current.model!==model)return;
   const placed=scopeDiagram(model,scope,{...view,positions}),bounds=getNodesBounds(placed.nodes);
   const viewport=getViewportForBounds(bounds,container.current?.clientWidth??900,container.current?.clientHeight??600,0.15,1,0.1);
   latest.current.changeView({positions});await flow.setViewport(viewport);latest.current.changeView({viewport});
  }catch(e){report(String(e))}finally{setLayingOut(false)}
 }
 useEffect(()=>{
  if(view.positions&&model.modules.filter(m=>m.parent===scope).every(m=>view.positions?.[m.id])){if(view.viewport)void flow.setViewport(view.viewport)}else void arrange();
  // The provider is mounted per scope. Inspection changes never arrange or fit the graph.
 },[]);
 // Keep the same graph center and zoom when docks/sidebar resize the canvas. No relayout.
 useEffect(()=>{const element=container.current;if(!element)return;let previous:{width:number;height:number}|undefined;const observer=new ResizeObserver(()=>{const width=element.clientWidth,height=element.clientHeight;if(width<1||height<1)return;const old=previous;previous={width,height};if(!old||Math.abs(width-old.width)+Math.abs(height-old.height)<2)return;const before=flow.getViewport(),viewport={...before,x:before.x+(width-old.width)/2,y:before.y+(height-old.height)/2};void flow.setViewport(viewport);latest.current.changeView({viewport});});observer.observe(element);return()=>observer.disconnect();},[]);
 useEffect(()=>{if(view.restoreTick&&view.viewport)void flow.setViewport(view.viewport)},[view.restoreTick]);
 const nodes=graph.nodes.map(n=>({...n,selected:!n.data.boundary&&!n.data.localId&&n.data.moduleId===selectedId,data:{...n.data,inspectGroup:(groupId:string)=>changeView({viewport:flow.getViewport(),inspection:{kind:'boundary',role:n.data.role as 'consumer'|'producer',groupId}}),reviewStatus:reviews.find(r=>r.moduleId===n.data.moduleId)?.status??'DRAFT'}}));
 const inspectionLabel=view.inspection?.kind==='array'?`检查元素 [${view.inspection.index}]` :view.inspection?.kind==='connection'?'检查信号':view.inspection?.kind==='local'?'检查内部驱动':view.inspection?.kind==='boundary'?'检查层级接口':view.inspection?'检查相邻关系':'总览';
 return <section className="canvas-shell"><div className="canvas-toolbar"><span>{model.modules.filter(m=>m.parent===scope).length} 个子模块 · {graph.inspection.stored.length} 条已记录连接 · {inspectionLabel}</span><div className="actions"><button data-testid="show-auxiliary" aria-pressed={!!view.showAuxiliary} onClick={()=>changeView({showAuxiliary:!view.showAuxiliary})}>时钟 / 配置{graph.auxiliaryCount?` · 折叠 ${graph.auxiliaryCount} 条`:''}</button><button data-testid="show-locals" aria-pressed={!!view.showLocals} onClick={()=>changeView({showLocals:!view.showLocals})}>内部逻辑 · {graph.localCount}</button>{view.inspection&&<button data-testid="exit-inspection" onClick={()=>changeView({inspection:undefined})}>退出检查</button>}<button title="导出当前层级的矢量图，保留折叠状态和不完整标记" data-testid="export-diagram" onClick={()=>{const url=URL.createObjectURL(new Blob([diagramSvg(model,scope,{...view,showPortNames:flow.getViewport().zoom>=portDetailZoom},modelHash)],{type:'image/svg+xml'}));const link=document.createElement('a');link.href=url;link.download=`${scope.replace(/[^a-zA-Z0-9_-]/g,'_')}-architecture.svg`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>导出图</button>{previousPositions&&<button onClick={()=>{changeView({positions:previousPositions});setPreviousPositions(undefined)}}>撤销布局</button>}{!readOnly&&<button onClick={()=>void saveLayout(scope,{positions:latest.current.view.positions??{},viewport:flow.getViewport(),...(reading?{reading}:{})}).then(()=>report('布局已保存；架构批准不变。')).catch(e=>report(String(e)))}>保存布局</button>}<button onClick={()=>document.getElementById(`layout-file-${scope}`)?.click()}>导入布局</button><button title="放大当前模块或主通路起点；可沿连线平移，左下角可恢复全图" data-testid="reading-size" onClick={()=>{const node=graph.nodes.find(n=>!n.data.boundary&&n.id===selectedId)??graph.nodes.find(n=>n.id===reading?.mainPath[0])??graph.nodes.find(n=>!n.data.boundary);if(node)void flow.setCenter(node.position.x+node.data.geometry.width/2,node.position.y+node.data.geometry.height/2,{zoom:0.9,duration:180})}}>阅读大小</button><button data-testid="auto-layout" disabled={layingOut} onClick={()=>void arrange()}>{layingOut?'布局中…':'自动布局'}</button></div></div>
 <input type="file" accept="application/json,.json" hidden id={`layout-file-${scope}`} data-testid="layout-file" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;void (async()=>{if(file.size>8*1024*1024)throw new Error('布局文件超过 8 MiB');const plan=layoutSchema.parse(JSON.parse(await file.text())).scopes[scope];if(!plan)throw new Error('布局文件没有当前层级');const generated=await arrangeScope(model,scope,modelHash,plan.reading);if(latest.current.model!==model||latest.current.scope!==scope)return;const complete=model.modules.filter(m=>m.parent===scope).every(m=>plan.positions[m.id]);setReading(plan.reading);changeView({positions:complete?plan.positions:generated,viewport:plan.viewport});await flow.setViewport(plan.viewport);report('已载入本层展示布局；点击保存布局后持久化，架构批准不变。')})().catch(e=>report(String(e)))}}/>
 {view.viewport&&view.viewport.zoom<0.6&&<div className="graph-note">当前为全图缩略视图；点击“阅读大小”看清文字，再沿连线平移。</div>}
 {graph.edges.some(e=>e.data?.routingFallback)&&<div className="graph-note">部分连线无法绕开当前模块位置；可用自动布局重新排列。</div>}
 {graph.edges.some(e=>e.data?.labelHidden)&&<div className="graph-note">有线名未能排下：请调整模块间距或自动布局；悬停可核对完整名称。</div>}
 <div className="wire-legend">实心点：同源分叉，可共用线名　·　留白交叉：不相连　·　箭头：传递方向　·　放大后显示模块接口名</div>
 <div ref={container} className="canvas" data-testid="canvas"><ReactFlow<RtlNode> nodes={nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesConnectable={false} edgesReconnectable={false} nodesDraggable={!readOnly} zoomOnDoubleClick={false} minZoom={0.15} maxZoom={2} deleteKeyCode={null}
 onNodeClick={(event,node)=>{if(node.data.kind==='frame')return;if(node.data.kind==='rack'){changeView({viewport:flow.getViewport(),inspection:{kind:'boundary',role:node.data.role as 'consumer'|'producer'}});return;}if(node.data.localId){changeView({viewport:flow.getViewport(),inspection:{kind:'local',id:String(node.data.localId)}});selectLocal(String(node.data.localId));return;}const portId=(event.target as Element).closest('[data-port-id]')?.getAttribute('data-port-id');if(portId){const ids=graph.edges.filter(e=>(e.source===node.id&&e.sourceHandle===portId)||(e.target===node.id&&e.targetHandle===portId)).flatMap(e=>(e.data?.connectionIds as string[])??[]);if(ids.length){changeView({viewport:flow.getViewport(),inspection:{kind:'connection',ids}});selectEdge(ids);return;}}select(node.data.moduleId);changeView({viewport:flow.getViewport(),inspection:{kind:'module',id:node.data.moduleId},selectedId:node.data.moduleId})}}
 onNodeDoubleClick={(_event,node)=>{if(node.data.kind==='subsystem'&&!node.data.boundary)enter(node.id)}}
 onEdgeClick={(_event,edge)=>{if(edge.data?.localSignalId){changeView({viewport:flow.getViewport(),inspection:{kind:'local',id:String(edge.data.localSignalId)}});selectLocal(String(edge.data.localSignalId));return;}const ids=edge.data?.connectionIds as string[];if(ids){changeView({viewport:flow.getViewport(),inspection:{kind:'connection',ids}});selectEdge(ids)}}}
 onNodeDrag={(_event,node)=>changeView({positions:{...latest.current.view.positions,[node.id]:node.position}})}
 onMoveEnd={(_event,viewport)=>changeView({viewport})}>
 <Controls showInteractive={false} fitViewOptions={{padding:0.12,maxZoom:1}}/>
 </ReactFlow></div>
 {graph.foldedLocalCount>0&&<div className="graph-note">{graph.foldedLocalCount} 条连接暂未显示：展开“内部逻辑”查看。<span>线上的数字为连接条数</span></div>}
 </section>;
}
