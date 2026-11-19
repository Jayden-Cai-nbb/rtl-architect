import {type ReadingTask} from '../../core/readingProjection';
import {ReadingEvidence} from './Assurance';
import {EvidenceDetails,EvidenceLinks} from './Evidence';
import {viewNames,type ViewMode} from '../../core/hardwareView';
import type {diagramQuality} from '../graph/quality';
import {useEffect,useMemo,useRef,useState} from 'react';
import {ReactFlow,Controls,MiniMap,getNodesBounds,getViewportForBounds,useReactFlow,type Edge,type Viewport} from '@xyflow/react';
import {layoutSchema,type Model,type ScopeLayout} from '../../core/schema';
import type {Snapshot} from '../../core/api';
import {interfaceGroup,type Inspection} from '../../core/inspection';
import {makeSelection,selectionKey,selectionNodeId,selectionProblems,type SelectionRef,type SelectionTarget} from '../../core/selection';
import {diagramSvg} from '../graph/exportSvg';
import {scopeDiagram,type ScopeDiagram,type Positions} from '../graph/scopeDiagram';
import {DiagramClient} from '../graph/diagramClient';
import {diagramSelection,highlightDiagram,originalEdgeMembers} from '../graph/selection';
import type {RtlNode} from '../graph/types';
import {portDetailZoom} from '../graph/ports';
import {ModuleNode} from './ModuleNode';
import {RelationshipEdge} from './RelationshipEdge';
const nodeTypes={rtlModule:ModuleNode},edgeTypes={relationship:RelationshipEdge};
const constraintLabels={applied:'已应用',internal_to_group:'集合内部',not_applicable:'当前范围不适用',unsupported:'投影不支持'};
type TraceOrigin={task?:ReadingTask|null;positions?:Positions;viewport?:Viewport;showAuxiliary?:boolean;showLocals?:boolean};
export type ScopeView={replayLocations?:{transaction:string;payload:string;state:{moduleId:string;localSignalId:string}}[];task?:ReadingTask|null;stateChoice?:string;mode?:ViewMode;modeViews?:Partial<Record<ViewMode,{positions?:Positions;viewport?:Viewport}>>;reading?:ScopeLayout['reading'];positions?:Positions;viewport?:Viewport;inspection?:Inspection;showAuxiliary?:boolean;showLocals?:boolean;showState?:boolean;traceOrigin?:TraceOrigin;restoreTick?:number;locateTick?:number};

function contextualNodes(graph:ScopeDiagram,ref:SelectionRef){
 const ids=new Set(diagramSelection(graph,ref));
 const edges=graph.edges.filter(e=>ids.has(e.id));
 if(edges.length){
  const ends=new Set(edges.flatMap(e=>[e.source,e.target]));
  return graph.nodes.filter(n=>ends.has(n.id));
 }
 const chosen=graph.nodes.filter(n=>ids.has(n.id)&&n.data.kind!=='frame');
 if(chosen.length!==1||chosen[0].data.boundary)return chosen;
 const root=chosen[0],neighbors=new Set(graph.edges.flatMap(e=>e.source===root.id?[e.target]:e.target===root.id?[e.source]:[]));
 const peer=graph.nodes.filter(n=>!n.data.boundary&&n!==root&&neighbors.has(n.id))
  .sort((a,b)=>Math.hypot(a.position.x-root.position.x,a.position.y-root.position.y)-Math.hypot(b.position.x-root.position.x,b.position.y-root.position.y))[0];
 return peer?[root,peer]:chosen;
}

function keepInView(nodes:RtlNode[],viewport:Viewport,width:number,height:number){
 if(!nodes.length)return viewport;
 const {x,y,width:w,height:h}=getNodesBounds(nodes);
 const margin=20,zoom=Math.min(viewport.zoom,Math.max(.15,Math.min((width-2*margin)/w,(height-2*margin)/h)));
 if(zoom<viewport.zoom)return {zoom,x:(width-w*zoom)/2-x*zoom,y:(height-h*zoom)/2-y*zoom};
 const clamp=(p:number,start:number,size:number,extent:number)=>Math.max(margin-start*zoom,Math.min(p,extent-margin-(start+size)*zoom));
 return {zoom,x:clamp(viewport.x,x,w,width),y:clamp(viewport.y,y,h,height)};
}

export function Canvas({view,changeView,trace,model,modelHash,scope,pick,enter,report,selection,reviews,readOnly,compact,layout,saveLayout}: {
 view:ScopeView;changeView:(patch:Partial<ScopeView>)=>void;trace:(inspection?:Inspection)=>void;selection:SelectionRef;reviews:Snapshot['moduleReviews'];readOnly:boolean;compact:boolean;
 model:Model;modelHash:string;scope:string;layout?:ScopeLayout;
 pick:(selection:SelectionRef)=>void;enter:(id:string)=>void;
 saveLayout:(scope:string,layout:ScopeLayout)=>Promise<void>;report:(text:string)=>void;
}){
 const flow=useReactFlow<RtlNode>(),container=useRef<HTMLDivElement>(null),[layingOut,setLayingOut]=useState(false),[previousPositions,setPreviousPositions]=useState<Positions>();
 const task=view.task===null?undefined:view.task??{kind:'overview' as const};
 const states=(model.localSignals??[]).filter(n=>n.scope===scope&&n.driver.kind==='register');
 const stateChoice=task?.kind==='state'?task.stateId:states.find(s=>s.id===view.stateChoice)?.id??states[0]?.id;
 const switchTask=(next:ReadingTask|null)=>changeView({task:next,...(next?.kind==='state'?{stateChoice:next.stateId}:{}),positions:undefined,viewport:undefined,inspection:undefined,traceOrigin:undefined});
 const reading=Object.hasOwn(view,'reading')?view.reading:layout?.reading;
 const client=useRef<DiagramClient|null>(null);if(!client.current)client.current=new DiagramClient();
 const [graph,setGraph]=useState<ScopeDiagram>(),[routing,setRouting]=useState(false),[routeError,setRouteError]=useState(''),[drag,setDrag]=useState<{id:string;position:{x:number;y:number}}>();
 const latest=useRef({view,changeView,graph,selection});latest.current={view,changeView,graph,selection};
 const options=useMemo(()=>({task,mode:view.mode,positions:view.positions,inspection:view.inspection,showAuxiliary:view.showAuxiliary,showLocals:view.showLocals,showState:view.showState,reading}),[view.task,view.mode,view.positions,view.inspection,view.showAuxiliary,view.showLocals,view.showState,reading]);
 const [quality,setQuality]=useState<ReturnType<typeof diagramQuality>>();
 const previousMode=useRef(view.mode);
 const previousTask=useRef(view.task);
 const generation=useRef(0);
 async function compute(arrange:boolean,fit:boolean){
  const ticket=++generation.current;setRouting(true);setRouteError('');
  try{
   const result=await client.current!.run(model,scope,modelHash,options,arrange);
   if(ticket!==generation.current)return;
   setGraph(result.graph);setQuality(result.quality);
   if(fit){
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));if(ticket!==generation.current)return;
    const width=container.current?.clientWidth??900,height=container.current?.clientHeight??600;
    const context=contextualNodes(result.graph,latest.current.selection);
    const viewport=getViewportForBounds(getNodesBounds(context.length?context:result.graph.nodes),width,height,.15,context.length?.9:1,.13);
    if(!context.length&&viewport.zoom<.65){
     const first=result.graph.nodes.find(n=>n.id===result.graph.reading?.mainPath[0])??result.graph.nodes.filter(n=>!n.data.boundary).sort((a,b)=>a.position.x-b.position.x)[0];
     if(first){
      viewport.zoom=.65;
      const input=result.graph.nodes.find(n=>n.id===`rack:${scope}:consumer`);
      viewport.x=Math.min(32-Math.min(first.position.x,input?.position.x??first.position.x)*.65,width-32-(first.position.x+first.data.geometry.width)*.65);
      viewport.y=height/2-(first.position.y+first.data.geometry.height/2)*.65;
     }
    }
    await flow.setViewport(viewport);latest.current.changeView({viewport});
   }
   else if(!graph&&view.viewport)void flow.setViewport(view.viewport);
   if(arrange){setPreviousPositions(view.positions);latest.current.changeView({positions:result.positions});}
  }catch(e){if(ticket===generation.current&&String(e)!=='Error: DIAGRAM_CANCELLED')setRouteError(String(e));}
  finally{if(ticket===generation.current){setRouting(false);setLayingOut(false)}}
 }
 async function arrange(){setLayingOut(true);await compute(true,true)}
 useEffect(()=>{
  const required=scopeDiagram(model,scope,{...options,measureOnly:true}).nodes.filter(n=>!n.data.boundary).map(n=>n.id);
  const missing=!view.positions||required.some(id=>!view.positions?.[id]);
  const changedMode=previousMode.current!==view.mode||previousTask.current!==view.task;previousMode.current=view.mode;previousTask.current=view.task;
  void compute(missing,(!graph||changedMode)&&(!view.viewport||missing));
  return()=>{generation.current++;client.current?.cancel()};
 },[model,modelHash,scope,options]);
 useEffect(()=>()=>client.current?.dispose(),[]);
 // Dock resizing adjusts the viewport around the same object and established routes.
 useEffect(()=>{
  const element=container.current;if(!element)return;
  let previous:{width:number;height:number}|undefined;
  const observer=new ResizeObserver(()=>{
   const width=element.clientWidth,height=element.clientHeight;if(width<1||height<1)return;
   const old=previous;previous={width,height};
   if(!old||Math.abs(width-old.width)+Math.abs(height-old.height)<2)return;
   const before=flow.getViewport(),centered={...before,x:before.x+(width-old.width)/2,y:before.y+(height-old.height)/2};
   const {graph,selection,changeView}=latest.current;
   const viewport=graph?keepInView(contextualNodes(graph,selection),centered,width,height):centered;
   void flow.setViewport(viewport);changeView({viewport});
  });
  observer.observe(element);return()=>observer.disconnect();
 },[!!graph]);
 useEffect(()=>{if(view.restoreTick&&view.viewport)void flow.setViewport(view.viewport)},[view.restoreTick]);
 const located=useRef<number>(0);
 useEffect(()=>{
  const tick=view.locateTick??0,element=container.current;
  if(!graph||routing||!element||tick<=located.current)return;
  const focus=contextualNodes(graph,latest.current.selection);
  if(!focus.length)return;
  located.current=tick;
  const viewport=getViewportForBounds(getNodesBounds(focus),element.clientWidth,element.clientHeight,.15,.9,.12);
  void flow.setViewport(viewport);latest.current.changeView({viewport});
 },[graph,routing,view.locateTick]);
 const selectionId=selectionKey(selection);
 const selectedIds=useMemo(()=>graph?diagramSelection(graph,selection):[],[graph,selectionId]);
 const styled=useMemo(()=>graph?highlightDiagram(graph,selectedIds,!!view.inspection):undefined,[graph,selectedIds,view.inspection]);
 const choose=(target:SelectionTarget)=>pick(makeSelection(model,modelHash,scope,target));
 const chooseEdges=(edges:Edge[])=>{
  const members=edges.flatMap(originalEdgeMembers);if(!members.length)return;
  const current=selection.target;
  const element=current.kind==='module'&&current.index!==undefined?{moduleId:current.id,index:current.index}:current.kind==='relationship'?current.element:undefined;
  const ref=makeSelection(model,modelHash,scope,{kind:'relationship',members,...(element?{element}:{})});
  pick(element&&selectionProblems(model,ref).length?makeSelection(model,modelHash,scope,{kind:'relationship',members}):ref);
 };
 const chooseEdge=(id:string)=>{const edge=graph?.edges.find(e=>e.id===id);if(edge)chooseEdges([edge]);};
 const chooseNode=(node:RtlNode,groupId?:string)=>{
  const {kind,localId,moduleId,role,memberIds}=node.data;
  if(kind==='rack'){
   const ports=model.modules.find(m=>m.id===scope)!.interfaces.filter(p=>p.role===role&&(!groupId||interfaceGroup(model,{moduleId:scope,interfaceId:p.id}).id===groupId)).map(p=>p.id);
   if(ports.length)choose({kind:'boundary',role:role==='consumer'?'consumer':'producer',ports});
  }else if(kind==='aggregate')choose({kind:'group',members:memberIds as string[]});
  else if(localId)choose({kind:'local',id:String(localId)});
  else if(!node.data.boundary)choose({kind:'module',id:moduleId,...(selection.target.kind==='module'&&selection.target.id===moduleId&&selection.target.index!==undefined?{index:selection.target.index}:{})});
 };
 const current=selection.target;
 const selectedModule=current.kind==='module'?current.id:scope;
 const element=current.kind==='module'&&current.index!==undefined?{moduleId:current.id,index:current.index}:current.kind==='relationship'?current.element:undefined;
 const showState=(id:string)=>{
  if(selection.target.kind!=='local'||selection.target.id!==id)choose({kind:'local',id});
  switchTask({kind:'state',stateId:id});
 };
 const nodes=(styled?.nodes??[]).map(n=>({...n,position:drag?.id===n.id?drag.position:n.position,data:{...n.data,
  arrayIndex:element?.moduleId===n.id?element.index:n.data.arrayIndex,
  replayLabel:view.replayLocations?.filter(l=>l.state.moduleId===n.data.moduleId&&(!n.data.localId||l.state.localSignalId===n.data.localId)).map(l=>`${l.transaction}=${l.payload}`).join(' · '),
  inspectGroup:(groupId:string)=>chooseNode(n,groupId),reviewStatus:reviews.find(r=>r.moduleId===n.data.moduleId)?.status??'DRAFT'}}));
 if(!graph)return <section className="canvas-shell"><div className="routing-status" role="status">{routeError||'正在后台准备框图；可先选择模块阅读详情。'}{routeError&&<button onClick={()=>void compute(true,true)}>重新绘图</button>}</div><div ref={container} className="canvas" data-testid="canvas"/></section>;
 const inspectionLabel=view.inspection?.kind==='array'?`检查元素 [${view.inspection.index}]` :view.inspection?.kind==='connection'?'检查信号':view.inspection?.kind==='local'?(view.inspection.purpose==='data'?'数据从哪里来':view.inspection.purpose==='control'?'什么时候更新':'检查内部驱动'):view.inspection?.kind==='boundary'?'检查层级接口':view.inspection?'检查相邻关系':'总览';
 const projectionNote=graph.projection?.task.kind==='state'?'沿声明依赖查看局部，上游状态停止；范围外保留清单。':'未声明用途的状态只收为清单，不推断功能或握手。';
 const zoomHint=view.viewport&&view.viewport.zoom<0.6?'当前为全图缩略视图；点击“阅读大小”看清文字，再沿连线平移。':undefined;
 const legend=<>{graph.modeLabel}{graph.semantics.relationships.some(r=>r.kind==='ready_valid')&&' · RV 的 data/valid 正向，ready 反向'} · 实心箭头为连接，空心箭头为依赖 · 输入集合未分角色，更新规则为声明；位置不表示周期</>;
 return <section className="canvas-shell" data-state-id={graph.projection?.task.kind==='state'?graph.projection.task.stateId:undefined}><div className="canvas-toolbar"><span>{model.modules.filter(m=>m.parent===scope).length} 个子模块 · {graph.inspection.stored.length} 条已记录连接 · {inspectionLabel}</span><div className="actions"><label>阅读任务 <select aria-label="阅读任务" value={task?.kind??'full'} onChange={e=>{const kind=e.target.value;if(kind==='full')switchTask(null);else if(kind==='overview')switchTask({kind});else if(stateChoice)showState(stateChoice)}}><option value="overview">主事务总览</option><option value="state" disabled={!states.length}>选中状态的局部范围</option><option value="full">完整硬件视图</option></select></label>{states.length>0&&<><select aria-label="状态范围" value={stateChoice} onChange={e=>{const id=e.target.value;if(task?.kind==='state')showState(id);else changeView({stateChoice:id})}}>{states.map(n=><option key={n.id} value={n.id}>{n.name}</option>)}</select><button onClick={()=>stateChoice&&showState(stateChoice)}>查看状态范围</button></>}<button title="放大当前模块或主通路起点；可沿连线平移，左下角可恢复全图" data-testid="reading-size" onClick={()=>{const node=graph.nodes.find(n=>!n.data.boundary&&selectedIds.includes(n.id))??graph.nodes.find(n=>n.id===graph.reading?.mainPath[0])??graph.nodes.find(n=>!n.data.boundary);if(node)void flow.setCenter(node.position.x+node.data.geometry.width/2,node.position.y+node.data.geometry.height/2,{zoom:0.9})}}>阅读大小</button><details className="canvas-menu"><summary>更多操作</summary><div className="actions"><label>阅读模式 <select aria-label="阅读模式" value={view.mode??'architecture'} onChange={e=>{const mode=e.target.value as ViewMode,current=view.mode??'architecture',modeViews={...view.modeViews,[current]:{positions:view.positions,viewport:flow.getViewport()}};changeView({task:null,mode,modeViews,positions:modeViews[mode]?.positions,viewport:modeViews[mode]?.viewport,restoreTick:modeViews[mode]?.viewport?(view.restoreTick??0)+1:view.restoreTick,inspection:undefined,traceOrigin:undefined})}}>{Object.entries(viewNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><button data-testid="trace-module" onClick={()=>trace({kind:'module',id:selectedModule})}>查看直接连接</button>{graph.stateCount>0&&<button data-testid="show-state" disabled={!!view.mode&&view.mode!=='architecture'} aria-pressed={view.showState!==false} onClick={()=>changeView({showState:view.showState===false})}>寄存状态 · {graph.stateCount}</button>}<button data-testid="show-auxiliary" disabled={view.mode==='signals'||view.inspection?.kind==='local'&&view.inspection.purpose==='control'} aria-pressed={!!view.showAuxiliary||view.mode==='signals'||view.inspection?.kind==='local'&&view.inspection.purpose==='control'} onClick={()=>changeView({showAuxiliary:!view.showAuxiliary})}>时钟 / 配置{graph.auxiliaryCount?` · 折叠 ${graph.auxiliaryCount} 条`:''}</button><button data-testid="show-locals" disabled={!!view.mode&&view.mode!=='architecture'} aria-pressed={!!view.showLocals} onClick={()=>changeView({showLocals:!view.showLocals})}>全部内部逻辑 · {graph.localCount}</button>{view.inspection&&<button data-testid="exit-inspection" onClick={()=>trace()}>退出检查</button>}<button title="导出当前层级的矢量图，保留折叠状态和不完整标记" data-testid="export-diagram" disabled={routing} onClick={()=>{const url=URL.createObjectURL(new Blob([diagramSvg(model,scope,{...view,task,reading,showPortNames:flow.getViewport().zoom>=portDetailZoom},modelHash,graph)],{type:'image/svg+xml'}));const link=document.createElement('a');link.href=url;link.download=`${scope.replace(/[^a-zA-Z0-9_-]/g,'_')}-architecture.svg`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>导出图</button>{previousPositions&&<button onClick={()=>{changeView({positions:previousPositions});setPreviousPositions(undefined)}}>撤销布局</button>}{!readOnly&&!task&&<button onClick={()=>void saveLayout(scope,{positions:latest.current.view.positions??{},viewport:flow.getViewport(),...(reading?{reading}:{})}).then(()=>report('布局已保存；架构批准不变。')).catch(e=>report(String(e)))}>保存布局</button>}<button onClick={()=>{const data={schemaVersion:1,scopes:{[scope]:{positions:(task?layout?.positions:view.positions)??{},viewport:flow.getViewport(),...(reading?{reading}:{})}}};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${scope}-${modelHash.slice(0,12)}-layout.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>下载布局</button><button onClick={()=>document.getElementById(`layout-file-${scope}`)?.click()}>导入布局</button><button disabled={routing||!quality} onClick={()=>{const data={modelHash,scope,modelSource:readOnly?'candidate':'saved_model',task:graph.projection?.task??{kind:'full'},mode:graph.mode,reading,projectedReading:graph.projection?graph.reading:undefined,positions:Object.fromEntries(graph.nodes.filter(n=>!n.data.boundary).map(n=>[n.id,n.position])),quality,exportedAt:new Date().toISOString()};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${scope}-${modelHash.slice(0,12)}-quality.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>下载本图检查</button><button data-testid="auto-layout" disabled={layingOut} onClick={()=>void arrange()}>{layingOut?'布局中…':'自动布局'}</button></div></details></div></div>
 <input type="file" accept="application/json,.json" hidden id={`layout-file-${scope}`} data-testid="layout-file" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;void (async()=>{if(file.size>8*1024*1024)throw new Error('布局文件超过 8 MiB');const plan=layoutSchema.parse(JSON.parse(await file.text())).scopes[scope];if(!plan)throw new Error('布局文件没有当前层级');if(plan.reading&&plan.reading.modelHash!==modelHash)throw new Error('布局对应旧模型，请核对来源');changeView({task:null,reading:plan.reading,positions:plan.positions,viewport:plan.viewport});await flow.setViewport(plan.viewport);report(readOnly?'已载入候选展示布局；可下载布局供下次导入，候选架构不变。':'已载入本层展示布局；点击保存布局后持久化，架构批准不变。')})().catch(e=>report(String(e)))}}/>
 {!!graph.taskEvidence.tasks.length&&<details className="reading-task-evidence" data-testid="reading-task-evidence">
  <summary>阅读路径 · {graph.taskEvidence.status==='ready'?'步骤可定位':'有步骤需核对'}</summary>
  {graph.taskEvidence.tasks.map(task=><section key={task.id}>
   <strong>{task.label}</strong><ol>{task.steps.map(step=><li key={step.id}>
    {step.selection&&step.nodeId?<button onClick={()=>choose(step.selection!)}>{step.label}</button>:<span>{step.label}</span>}
    {step.status==='gap'&&<span> · 表达缺口。{step.gap}</span>}
    {step.status==='outside_view'&&<span> · 当前范围未显示所需对象或关系</span>}
    <EvidenceLinks ids={step.sources.map(source=>source.id)}/>
   </li>)}</ol>
  </section>)}
 </details>}
 {graph.projection&&<div className="reading-projection" data-testid="reading-projection">
 <strong>{graph.modeLabel}</strong> · {graph.projection.members.length} 个原始成员 · {graph.edges.length} 条可见关系 · {graph.semantics.issues.length} 项语义待核对
 {!compact&&<span> · {projectionNote}</span>}
 <details><summary>成员、原始连接与展开入口</summary>{graph.projection.groups.map(g=><div key={g.id}><strong>{g.label} · {g.members.length} 项</strong><button onClick={()=>switchTask({...task!,expanded:g.expanded?(task?.expanded??[]).filter(id=>id!==g.id):[...task?.expanded??[],g.id]})}>{g.expanded?'收起':'展开'} {g.label}</button><details><summary>成员 ID 与内部关系 {graph.projection!.internal[g.id]?.length??0}</summary><ul>{g.members.map(id=><li key={id}><code>{id}</code>{id.startsWith('local:')&&<button onClick={()=>choose({kind:'local',id:id.split(':')[2]})}>查看声明</button>}</li>)}</ul><pre>{JSON.stringify(graph.projection!.internal[g.id]??[],null,2)}</pre></details></div>)}<details><summary>全部可见关系及辅助折叠成员</summary><pre>{JSON.stringify({visible:graph.edges.map(e=>({id:e.id,members:e.data?.relationMembers})),auxiliary:graph.projection.auxiliary},null,2)}</pre></details></details>
 <EvidenceDetails summary="核验记录与语义缺口">{()=><>
  <p>聚合只用于阅读，保留原 RTL 实例。</p>
  {compact&&<p>{projectionNote}</p>}
  {graph.semantics.issues.map((issue,i)=><p key={i}>{issue.code} · {issue.target} · {issue.reason}</p>)}
  <ReadingEvidence key={modelHash+String(readOnly)} modelHash={modelHash} candidate={readOnly}/>
 </>}</EvidenceDetails></div>}
 {!compact&&zoomHint&&<div className="graph-note">{zoomHint}</div>}
 {graph.edges.some(e=>e.data?.routingFallback)&&<div className="graph-note">部分连线无法绕开当前模块位置；可用自动布局重新排列。</div>}
 {graph.edges.some(e=>e.data?.labelHidden)&&<div className="graph-note">有线名未能排下：请调整模块间距或自动布局；悬停可核对完整名称。</div>}
 {routing&&<div className="routing-status" role="status">正在后台更新连线；保留上一份图，模块详情仍可查看。</div>}
 {routeError&&<div className="graph-note" role="alert">{routeError}<button onClick={()=>void compute(false,false)}>重试绘图</button></div>}
 {graph.edges.some(e=>e.data?.routingSimplified)&&<div className="graph-note">密集区域使用简化避障路径；连线未删减，拥挤处可逐层追踪。</div>}
 {!compact&&<div className="wire-legend">{legend}</div>}
 <details className="diagram-audit"><summary>框图检查 · 连接对应 {quality?.structuralFidelity.status==='passed'?'完整':'需修正'} · 语义 {quality?.semanticClarity.status==='no_detected_issue'?'未发现冲突':'待核对'} · 几何 {quality?.status==='passed'?'完整':'需修正'} · 布局约束 {quality?.readingConstraints.status==='not_requested'?'未指定':quality?.readingConstraints.status==='satisfied'?'已核对':'需调整'} · 阅读 {quality?.geometricReadability.status==='clear'?'未发现拥挤':'需留意'}</summary>{compact&&<p>{legend}</p>}{compact&&zoomHint&&<p>{zoomHint}</p>}<p>这是图对模型的检查，不是 RTL 正确性或人工可读性证明。</p><p>交叉 {quality?.crossings} · 未排下线名 {quality?.hiddenLabels.length} · 有说明的折叠 {graph.omissions.length}</p><p>总线长 {Math.round(quality?.wireLength??0)} · 最长关系 {Math.round(quality?.maxRouteLength??0)} 图单位；位置与长度不表示时钟周期或 STA。</p>
 <details data-testid="route-review"><summary>定位长线与隐藏线名</summary><p>先核对当前任务、成员与分组，再考虑间距或外侧返回；点选仅高亮，不重新布局。</p><ol>{quality?.routeReview.routes.filter(r=>quality.routeReview.longest.includes(r.id)).map(r=><li key={r.id}><button onClick={()=>chooseEdge(r.id)}>{r.label||r.id}</button> · 长 {Math.round(r.length)} · 绕行 {Math.round(r.detour)}{quality.routeReview.detours.includes(r.id)?' · 建议核对绕行':''}<small> {r.source} → {r.target}</small></li>)}</ol>{!!quality?.hiddenLabels.length&&<p>未排下线名：{quality.hiddenLabels.map(id=><button key={id} onClick={()=>chooseEdge(id)}>{String(graph.edges.find(e=>e.id===id)?.label??id)}</button>)}</p>}<p>{quality?.routeReview.note}</p></details>{quality?.readingConstraints.issues.map((i,n)=><p key={`constraint-${n}`}><strong>{i.targets.join(' → ')}</strong>：{i.reason}</p>)}{!!quality?.readingConstraints.constraints.length&&<details data-testid="reading-constraints"><summary>原约束及当前图处理结果</summary><ul>{quality.readingConstraints.constraints.map(c=><li key={c.kind+':'+c.index} data-status={c.status}><strong>{c.kind} · {constraintLabels[c.status]}</strong> · {c.original.join(' → ')}{c.projected.some((id,i)=>id!==c.original[i])&&<> · 当前对象 {c.projected.join(' → ')}</>}{c.reason&&<> · {c.reason}</>}{c.edges?.length&&<button onClick={()=>chooseEdge(c.edges![0])}>定位返回线</button>}</li>)}</ul></details>}{graph.semantics.issues.slice(0,20).map((i,n)=><p key={n}><strong>{i.target}</strong>：{i.reason}</p>)}{graph.semantics.issues.length>20&&<p>另有 {graph.semantics.issues.length-20} 项；按层级或原始连接继续核对。</p>}</details>
 <div ref={container} className="canvas" data-testid="canvas"><ReactFlow<RtlNode> nodes={nodes} viewport={view.viewport} onViewportChange={viewport=>{const old=latest.current.view.viewport;if(!old||old.x!==viewport.x||old.y!==viewport.y||old.zoom!==viewport.zoom)latest.current.changeView({viewport})}} edges={styled!.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesConnectable={false} edgesReconnectable={false} nodesDraggable={!routing} zoomOnDoubleClick={false} minZoom={0.15} maxZoom={2} deleteKeyCode={null}
 onNodeClick={(event,node)=>{
  const portId=(event.target as Element).closest('[data-port-id]')?.getAttribute('data-port-id');
  const edges=portId?graph.edges.filter(e=>e.source===node.id&&e.sourceHandle===portId||e.target===node.id&&e.targetHandle===portId):[];
  if(edges.length)chooseEdges(edges);else chooseNode(node);
 }}
 onNodeDoubleClick={(_event,node)=>{if(node.data.kind==='subsystem'&&!node.data.boundary)enter(node.id)}}
 onEdgeClick={(_event,edge)=>chooseEdges([edge])}
 onNodeDrag={(_event,node)=>setDrag({id:node.id,position:node.position})}
 onNodeDragStop={(_event,node)=>{setDrag(undefined);changeView({positions:{...latest.current.view.positions,[node.id]:node.position}})}}
 onMoveEnd={(_event,viewport)=>changeView({viewport})}>
 <MiniMap pannable zoomable onClick={(_event,position)=>void flow.setCenter(position.x,position.y,{zoom:flow.getZoom()})} position="bottom-right" style={{width:150,height:90}} nodeColor={n=>n.data.boundary?'transparent':n.data.kind==='state'?'#99b99a':n.data.kind==='memory'?'#d7c299':'#a1bdcc'} nodeStrokeWidth={1} ariaLabel="全图导航"/>
 <Controls showInteractive={false} fitViewOptions={{padding:0.12,maxZoom:1}}/>
 </ReactFlow></div>
 {(graph.foldedLocalCount>0||graph.foldedDependencyCount>0)&&<div className="graph-note">{graph.foldedLocalCount} 条连接、{graph.foldedDependencyCount} 条内部依赖暂未显示：按需展开内部逻辑或时钟 / 配置。<span>×N 为连接条数，N 项为内部输入依赖数量</span></div>}
 </section>;
}
