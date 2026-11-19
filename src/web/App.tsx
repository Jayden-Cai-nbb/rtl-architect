import {WorkObjectContext} from './components/WorkObject';
import {makeWorkTarget,workSelection,workTargetState,type WorkTarget,type ObjectRequest} from '../core/workbench';
import {makeSelection,selectedInstance,selectionKey,selectionProblems,type SelectionRef,type SelectionTarget} from '../core/selection';
import {TransactionReplay} from './components/TransactionReplay';
import {WorkbenchPanel} from './components/WorkbenchPanel';
import {WorkDock} from './components/WorkDock';
import {version as frontendVersion} from '../../package.json';
import {DesignBrief} from './components/DesignBrief';
import {SelectionInspector} from './components/SelectionInspector';
import {SignalInspection} from './components/SignalInspection';
import {ModelIdentity} from './components/ModelIdentity';
import type {ScopeView} from './components/Canvas';
import type {Endpoint} from '../core/schema';
import type {Inspection} from '../core/inspection';
import { EvidenceContext, EvidenceDialog } from './components/Evidence';
import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { kindSchema, type Command, type Module } from '../core/schema';
import { useArchitecture } from './state/useArchitecture';
import { Canvas } from './components/Canvas';
import { Hierarchy, Breadcrumbs } from './components/Hierarchy';
import { Inspector } from './components/Inspector';
import { Changes } from './components/Changes';
import { SpecPanel, SpecificationEditor } from './components/Documents';
import { IssueList } from './components/Issues';
import { CoverageSummary } from './components/Provenance';
import { ReviewPanel } from './components/ReviewPanel';
type Panel = 'replay' | 'work' | 'spec' | 'changes' | 'problems' | 'review' | 'connections';
export default function App() {
  const a = useArchitecture();
  const [entry]=useState(()=>new URLSearchParams(window.location.search));
  const [panel,setPanel]=useState<Panel|null>(entry.get('panel')==='work'?'work':null),[candidate,setCandidate]=useState(false),[showInspector,setShowInspector]=useState(true),[showTree,setShowTree]=useState(true);
  const [replayLocations,setReplayLocations]=useState<{transaction:string;payload:string;state:{moduleId:string;localSignalId:string}}[]>([]);
  const [detailScope,setDetailScope]=useState<string>();
  const [selections,setSelections]=useState<Record<string,SelectionRef>>({});
  const [composeTick,setComposeTick]=useState(0);
  const [views,setViews]=useState<Record<string,ScopeView>>({});
  const [evidence, setEvidence] = useState<string>();
  const [add,setAdd]=useState(false),[newId,setNewId]=useState(''),[kind,setKind]=useState<Module['kind']>('module'),[editSpec,setEditSpec]=useState(false);
  useEffect(()=>{
    if(a.linkedProposal?.state==='READY'){
      setCandidate(true);
      if(entry.get('panel')!=='work')setPanel(null);
    }else if(a.linkedProposal?.state==='STALE'){
      setCandidate(false);
      if(entry.get('panel')!=='work')setPanel('changes');
    }
  },[a.linkedProposal,entry]);
  const readOnly=candidate&&!!a.preview;
  const model=readOnly?a.preview!.candidate:a.snapshot?.model;
  if(!a.snapshot||!a.layouts||!model)return <main className="loading-screen"><div className="brand-mark">R</div><h1>RTL Architect</h1><p role="status">{a.message||'加载当前设计…'}</p><button onClick={()=>void a.reload()}>重试连接</button></main>;
  const scope=model.modules.some(m=>m.id===a.scope&&m.kind==='subsystem')?a.scope:model.design.top;
  const hash=readOnly?a.preview!.candidateHash:a.snapshot.modelHash;
  const key=(id:string)=>`${hash}:${id}`;
  const isResume=entry.has('checkpoint')||entry.has('thread');
  const entryLink=!isResume?model.connections.find(l=>l.scope===scope&&l.id===entry.get('connection')):undefined;
  const entryModule=!isResume?model.modules.find(m=>m.parent===scope&&m.kind!=='subsystem'&&m.id===entry.get('module')):undefined;
  const make=(target:SelectionTarget,inScope=scope)=>makeSelection(model,hash,inScope,target);
  const selection=selections[key(scope)]??(entryLink?make({kind:'relationship',members:[{kind:'connection',id:entryLink.id}]}):make({kind:'module',id:entryModule?.id??scope}));
  const layoutFor=(id:string)=>readOnly?undefined:a.layouts!.layout.scopes[id];
  const scopeView=(id:string)=>({...layoutFor(id),...views[key(id)]});
  const view:ScopeView={...scopeView(scope),...(entryLink&&!views[key(scope)]?{task:null,showAuxiliary:true,showLocals:true,locateTick:1}:{})};
  const changeView=(patch:Partial<ScopeView>,id=scope)=>{
    setViews(current=>({...current,[key(id)]:{...(current[key(id)]??(id===scope?view:scopeView(id))),...patch}}));
  };
  const trace=(inspection?:Inspection)=>{
    if(inspection){
      const traceOrigin=view.traceOrigin??{task:view.task,positions:view.positions,viewport:view.viewport,showAuxiliary:view.showAuxiliary,showLocals:view.showLocals};
      changeView({inspection,traceOrigin,task:null,...(view.task!==null?{positions:undefined}: {})});
      setShowInspector(true);
    }else changeView({...view.traceOrigin,inspection:undefined,traceOrigin:undefined,restoreTick:(view.restoreTick??0)+1});
  };
  const graphTarget=selection.target;
  const selected=model.modules.find(m=>m.id===(graphTarget.kind==='module'?graphTarget.id:scope))!;
  const arrayIndex=graphTarget.kind==='module'?graphTarget.index:undefined;
  const issues=readOnly?a.preview!.issues:a.extraIssues.length?a.extraIssues:a.snapshot.issues;
  const reviews=readOnly?[]:a.snapshot.moduleReviews;
  const changePanel=(next:Panel)=>{if(next==='connections')setShowInspector(true);setPanel(p=>p===next?null:next);};
  const pick=(ref:SelectionRef)=>{
    if(ref.modelHash!==hash||selectionProblems(model,ref).length){a.setMessage('对象与当前模型或实例不匹配。');return false;}
    if(ref.scope!==scope){
      if(!a.enter(ref.scope))return false;
    }else if(selectionKey(ref)!==selectionKey(selection)&&!a.allowSwitch())return false;
    setSelections(current=>({...current,[key(ref.scope)]:ref}));
    setShowInspector(true);
    return true;
  };
  const pickTarget=(target:SelectionTarget,inScope=scope)=>pick(make(target,inScope));
  const select=(id:string,index?:number)=>pickTarget({kind:'module',id,...(index===undefined?{}:{index})});
  const enter=(id:string)=>{if(!a.enter(id))return false;return true;};
  const focus=(id:string)=>{
    const module=model.modules.find(m=>m.id===id);
    if(module)pickTarget({kind:'module',id},module.parent??module.id);
  };
  const reveal=(ref:SelectionRef)=>{
    if(!pick(ref))return false;
    const next=scopeView(ref.scope),target=ref.target;
    const position={locateTick:(next.locateTick??0)+1};
    if(target.kind==='local'&&model.localSignals?.some(l=>l.scope===ref.scope&&l.id===target.id&&l.driver.kind==='register')){
      if(next.task?.kind==='state'&&next.task.stateId===target.id)changeView(position,ref.scope);
      else changeView({...position,task:{kind:'state',stateId:target.id},stateChoice:target.id,positions:undefined,viewport:undefined,inspection:undefined,traceOrigin:undefined},ref.scope);
    }else if(target.kind==='relationship'||target.kind==='boundary'||target.kind==='local'){
      const change=next.task!==null||!next.showLocals||!next.showAuxiliary;
      changeView({...position,...(change?{task:null,showLocals:true,showAuxiliary:true,positions:undefined,viewport:undefined,inspection:undefined,traceOrigin:undefined}:{})},ref.scope);
    }else if(target.kind==='group'&&next.task?.kind!=='overview'){
      changeView({...position,task:{kind:'overview'},positions:undefined,viewport:undefined,inspection:undefined,traceOrigin:undefined},ref.scope);
    }else changeView(position,ref.scope);
    return true;
  };
  const navigateEndpoint=(endpoint:Endpoint)=>{
    const owner=model.modules.find(m=>m.id===scope)!;
    const next=endpoint.moduleId===scope?owner.parent:endpoint.moduleId;
    if(!next)return;
    const ids=model.connections.filter(l=>l.scope===next&&[l.from,l.to].some(e=>!e.local&&e.moduleId===endpoint.moduleId&&e.interfaceId===endpoint.interfaceId)).map(l=>l.id);
    if(ids.length){reveal(make({kind:'relationship',members:ids.map(id=>({kind:'connection',id}))},next));return;}
    const port=model.modules.find(m=>m.id===endpoint.moduleId)?.interfaces.find(p=>p.id===endpoint.interfaceId);
    if(port&&next===endpoint.moduleId)reveal(make({kind:'boundary',role:port.role,ports:[port.id]},next));
    else if(next)pickTarget({kind:'module',id:endpoint.moduleId},next);
  };
  const askSelection=()=>{setPanel('work');setComposeTick(t=>t+1);};
  const askObject=(request:ObjectRequest)=>{
    try{
      const m=model.modules.find(n=>n.id===request.scope)!;
      const inScope=m.kind==='subsystem'?m.id:m.parent??m.id;
      const index=selectedInstance(selection).moduleId===m.id?selectedInstance(selection).index:undefined;
      const ref=request.kind==='local_state'||request.kind==='update_branch'
        ?make({kind:'local',id:request.kind==='local_state'?request.id:request.stateId!,...(request.kind==='update_branch'?{branch:request.id}:{})},request.scope)
        :make({kind:request.kind,id:request.id,...(inScope===m.id?{}:{moduleId:m.id}),...(index===undefined?{}:{index})},inScope);
      if((ref.scope===scope?pick(ref):reveal(ref)))askSelection();
    }catch(e){a.setMessage(String(e));}
  };
  const navigateWork=(target:WorkTarget)=>{
    const state=workTargetState(model,hash,target);if(!state.canLocate){a.setMessage(state.reason);return;}
    const ref=workSelection(model,target);
    if(!ref){a.setMessage('原记录的连接分属多个层级，无法定位到一张图。');return;}
    if(reveal(ref))setPanel('work');
  };
  const navigateReview=(id:string)=>{const m=model.modules.find(m=>m.id===id);if(m&&pickTarget({kind:'module',id},m.kind==='subsystem'?id:m.parent??scope))setPanel('review');};
  const workTarget=makeWorkTarget(model,selection,readOnly&&a.linkedProposal?.candidateHash===hash?a.linkedProposal.id:undefined);
  const objectInspector=graphTarget.kind!=='module'||!!view.inspection&&!selected.instances||panel==='connections';
  const propose=(commands:Command[],reason:string)=>{setCandidate(false);a.propose(commands,reason);setPanel('changes')};
  const inspectCandidate=()=>{if(!a.allowSwitch())return;setCandidate(true);setPanel(null)};
  return <WorkObjectContext.Provider value={askObject}><EvidenceContext.Provider value={setEvidence}><div className={`app-shell ${panel==='work'?'with-work-dock':''}`}><header className="app-header"><div className="brand"><span className="brand-mark">R</span><strong>RTL Architect</strong><span className="version-label" data-testid="frontend-version" title="页面构建版本">{frontendVersion}</span></div><div className="design-name" title={a.service?.workspaceRoot}>{model.design.name}<small> · {a.service?.workspaceRoot.split('/').pop()}</small></div><div className="header-actions"><span className={`status ${readOnly?'DRAFT':a.snapshot.reviewStatus}`} data-testid="review-status" title={hash}>{readOnly?'候选 · 未保存':({DRAFT:'草稿',APPROVED:'已批准',STALE:'需重新确认'}[a.snapshot.reviewStatus])}</span><button data-testid="open-work" onClick={()=>setPanel('work')}>讨论与继续</button><button data-testid="reload" className="quiet" disabled={a.busy} onClick={()=>void a.reload()}>重新加载</button><button onClick={()=>{setCandidate(false);setPanel('changes')}}>导入 AI 提案</button><button className="primary" data-testid="open-review" onClick={()=>{if(readOnly)setPanel('changes');else setPanel('review')}}>{readOnly?'检查变更 · 保存草稿':'审阅与批准'}</button></div></header>
    <CoverageSummary model={model} inspect={()=>setPanel('problems')}/>
    <div className={`workbench ${showTree?'':'hide-tree'} ${showInspector?'':'hide-inspector'}`}>
      {showTree&&<Hierarchy key={hash} model={model} scope={scope} selected={selected.id} reviews={reviews} select={focus} enter={enter} />}
      <main className="graph-workspace"><div className="graph-topbar"><button className="icon-button" title="切换层级树" aria-label="切换层级树" onClick={()=>setShowTree(!showTree)}>☷</button><Breadcrumbs model={model} scope={scope} enter={enter}/><div className="actions"><button disabled={readOnly} onClick={()=>setAdd(true)}>＋ 模块</button><button className="quiet" aria-label="切换属性面板" onClick={()=>setShowInspector(!showInspector)}>详情 {showInspector?'›':'‹'}</button></div></div>
        <ReactFlowProvider key={`${hash}-${scope}-${a.reloadVersion}`}>
          <Canvas view={{...view,replayLocations}} changeView={changeView} trace={trace} selection={selection} pick={pick} model={model} modelHash={hash}
            scope={scope} layout={layoutFor(scope)} reviews={reviews} readOnly={readOnly} compact={panel==='work'} enter={enter} saveLayout={a.saveLayout} report={a.setMessage}/>
        </ReactFlowProvider>
        {model.modules.every(m=>m.parent!==scope)&&model.modules.find(m=>m.id===scope)?.interfaces.length===0&&<div className="canvas-empty"><h3>这个层级等待定义</h3><p>添加模块与接口，或导入 AI 架构提案。</p></div>}
      </main>
      {showInspector&&(objectInspector?<SelectionInspector model={model} selection={selection} tracking={view.inspection} trace={trace} pick={pickTarget} ask={askSelection} navigateEndpoint={navigateEndpoint}
        readOnly={readOnly} showEditor={panel==='connections'} saveConnection={(link,replace)=>{if(a.connect(link,replace))setPanel('changes')}} disconnect={id=>propose([{op:'disconnect',connectionId:id}],'断开逻辑连接')}/>:
        selected.id===scope&&detailScope!==scope?<DesignBrief model={model} scope={scope} issues={issues} select={select} enter={enter} ask={askSelection}
          openModule={()=>setDetailScope(scope)} openSpec={()=>setPanel('spec')} openProblems={()=>setPanel('problems')}/>:
        <Inspector modelHash={hash} key={`${selected.id}-${hash}-${a.formVersion}`} enter={()=>enter(selected.id)} ask={askSelection}
          overview={selected.id===scope?()=>{if(a.allowSwitch())setDetailScope(undefined)}:undefined}
          module={selected} model={model} initialIndex={arrayIndex} inspectIndex={index=>select(selected.id,index)}
          arrayConnections={selected.instances&&(arrayIndex!==undefined||view.inspection)?<SignalInspection model={model} selection={selection} tracking={view.inspection}
            trace={trace} arrayControlsId={selected.id} navigateEndpoint={navigateEndpoint} choose={(ids,element)=>pickTarget({kind:'relationship',members:ids.map(id=>({kind:'connection',id})),...(element?{element}:{})})}/>:undefined}
          readOnly={readOnly} reviews={reviews} preview={propose} dirty={a.markDirty} remove={id=>propose([{op:'delete_module',moduleId:id}],'删除模块及关联连接')}/>)}
    </div>
    <section className={`dock ${panel&&panel!=='connections'?'is-open':''}`}><div className="dock-tabs" role="tablist">{([['work','讨论与继续'],['replay','事务回放'],['spec','设计说明'],['changes',`变更${a.preview?` · ${a.preview.diff.length}`:''}`],['problems','待处理'],['review','审阅与批准'],['connections','连接']] as [Panel,string][]).map(([id,label])=><button role="tab" aria-selected={panel===id} key={id} className={panel===id?'active':''} data-testid={`tab-${id}`} onClick={()=>{if(id==='review')setCandidate(false);changePanel(id)}}>{label}</button>)}<div className="dock-spacer"/><small>{readOnly?'候选尚未保存':'当前已保存版本'}</small><button className="icon-button" aria-label={panel?'收起面板':'展开面板'} onClick={()=>setPanel(panel?null:'spec')}>{panel?'⌄':'⌃'}</button></div>
      {panel&&panel!=='connections'&&panel!=='work'&&<div className="dock-body">
        {panel==='spec'&&<SpecPanel model={model} moduleId={selected.id} index={arrayIndex} hash={hash} status={readOnly?'DRAFT':a.snapshot.reviewStatus} issues={issues} navigate={focus} edit={readOnly?undefined:()=>setEditSpec(true)}/>}
        {panel==='changes'&&<Changes baseHash={a.snapshot.modelHash} proposal={a.proposal} preview={a.preview} busy={a.busy} conflict={a.conflict} needsFormPreview={a.needsFormPreview} commit={()=>{setCandidate(false);void a.commit()}} repreview={()=>a.proposal&&void a.runPreview(a.proposal)} rebase={()=>a.proposal&&void a.runPreview({...a.proposal,baseHash:a.snapshot!.modelHash})} imported={text=>{setCandidate(false);a.imported(text)}} inspect={inspectCandidate} discard={()=>{a.discardProposal();setCandidate(false)}}/>}
        {panel==='replay'&&<TransactionReplay model={model} hash={hash} scope={scope} readOnly={readOnly} observe={setReplayLocations} evidence={setEvidence}
          locate={(scope,target,discuss)=>{if(reveal(make(target,scope))&&discuss)askSelection();}}/>}
        {panel==='problems'&&<section className="problems"><div className="section-title"><h2>需要处理的事项</h2><span>{issues.length} 项</span></div>{issues.length?<IssueList model={model} issues={issues} navigate={focus}/>:<p className="empty-state compact">结构检查无问题。该结果不代表 RTL 仿真或一致性验证。</p>}</section>}
        {panel==='review'&&<ReviewPanel snapshot={a.snapshot} selected={a.snapshot.model.modules.some(m=>m.id===selected.id)?selected.id:a.snapshot.model.design.top} reviewer={a.reviewer} setReviewer={a.setReviewer} busy={a.busy||a.dirty.current||!!a.proposal} review={id=>void a.review(id)} navigate={navigateReview} exportFile={kind=>void a.exportFile(kind)}/>}

      </div>}
      <WorkDock active={panel==='work'} report={a.setMessage}>
        <WorkbenchPanel currentHash={hash} active={panel==='work'} model={model} target={workTarget} composeTick={composeTick}
          proposal={readOnly?a.proposal:undefined} navigate={navigateWork}/>
      </WorkDock>
    </section>
    <footer className="statusbar"><span className={`status-light ${issues.length?'warning':''}`}/><span data-testid="message" role="status">{a.message||'点击模块了解职责，点击连接查看信号'}</span><ModelIdentity model={model} hash={hash} serviceVersion={a.service?.toolVersion} proposal={a.linkedProposal} candidate={readOnly} compare={()=>setPanel('changes')}/></footer>
    {add&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="新增模块"><h2>在 {scope} 新增模块</h2><label>实例 ID<input autoFocus aria-label="新实例 ID" value={newId} onChange={e=>setNewId(e.target.value)}/></label><label>模块类型<select aria-label="模块类型" value={kind} onChange={e=>setKind(e.target.value as Module['kind'])}>{kindSchema.options.map(k=><option key={k} value={k}>{k}</option>)}</select></label><p className="hint">通用模块的职责与接口需补充；fifo/add_const 保留初始示例限制。</p><footer><button onClick={()=>setAdd(false)}>取消</button><button className="primary" disabled={!newId.trim()} onClick={()=>{propose([{op:'create_module',id:newId,parent:scope,template:kind}],`在 ${scope} 新增 ${kind}`);setAdd(false);setNewId('')}}>预览新增</button></footer></section></div>}
    {editSpec&&<SpecificationEditor model={model} close={()=>setEditSpec(false)} submit={spec=>{propose([{op:'update_specification',specification:spec}],'更新设计需求与决策');setEditSpec(false)}}/>}
    {evidence&&<EvidenceDialog key={`${evidence}-${hash}`} id={evidence} hash={hash} proposal={readOnly?a.proposal:undefined} close={()=>setEvidence(undefined)}/>}
  </div></EvidenceContext.Provider></WorkObjectContext.Provider>;
}
