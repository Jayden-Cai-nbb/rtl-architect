import {WorkbenchPanel} from './components/WorkbenchPanel';
import {version as frontendVersion} from '../../package.json';
import {DesignBrief} from './components/DesignBrief';
import {ArrayExplorer} from './components/ArrayExplorer';
import {SignalInspection} from './components/SignalInspection';
import {ModelIdentity} from './components/ModelIdentity';
import type {ScopeView} from './components/Canvas';
import type {Endpoint} from '../core/schema';
import { endpointLabel } from '../core/signals';
import { LocalSignalDialog } from './components/LocalSignal';
import { EvidenceContext, EvidenceDialog, RelatedEvidence } from './components/Evidence';
import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { kindSchema, type Command, type Module } from '../core/schema';
import { useArchitecture } from './state/useArchitecture';
import { Canvas } from './components/Canvas';
import { Hierarchy, Breadcrumbs } from './components/Hierarchy';
import { Inspector } from './components/Inspector';
import { Changes } from './components/Changes';
import { ConnectionEditor } from './components/ConnectionEditor';
import { SpecPanel, SpecificationEditor } from './components/Documents';
import { IssueList } from './components/Issues';
import { CoverageSummary } from './components/Provenance';
import { ReviewPanel } from './components/ReviewPanel';
type Panel = 'work' | 'spec' | 'changes' | 'problems' | 'review' | 'connections';
export default function App() {
  const a = useArchitecture();
  const [panel,setPanel]=useState<Panel|null>(new URLSearchParams(window.location.search).get('panel')==='work'?'work':null),[candidate,setCandidate]=useState(false),[showInspector,setShowInspector]=useState(true),[showTree,setShowTree]=useState(true);
  const [detailScope,setDetailScope]=useState<string>();
  const [localSignal, setLocalSignal] = useState<{id:string;endpoints?:Endpoint[]}>();
  const [views,setViews]=useState<Record<string,ScopeView>>({});
  const [evidence, setEvidence] = useState<string>();
  const [add,setAdd]=useState(false),[newId,setNewId]=useState(''),[kind,setKind]=useState<Module['kind']>('module'),[editSpec,setEditSpec]=useState(false);
  useEffect(()=>{ if(a.linkedProposal?.state==='READY'){setCandidate(true);if(new URLSearchParams(window.location.search).get('panel')!=='work')setPanel(null)} else if(a.linkedProposal?.state==='STALE'){setCandidate(false);setPanel('changes')} },[a.linkedProposal]);
  const readOnly=candidate&&!!a.preview;
  const model=readOnly?a.preview!.candidate:a.snapshot?.model;
  if(!a.snapshot||!a.layouts||!model)return <main className="loading-screen"><div className="brand-mark">R</div><h1>RTL Architect</h1><p role="status">{a.message||'加载当前设计…'}</p><button onClick={()=>void a.reload()}>重试连接</button></main>;
  const scope=model.modules.some(m=>m.id===a.scope&&m.kind==='subsystem')?a.scope:model.design.top;
  const hash=readOnly?a.preview!.candidateHash:a.snapshot.modelHash;
  const viewKey=`${hash}:${scope}`,view={...(readOnly?{}:a.layouts.layout.scopes[scope]??{}),...views[viewKey]};
  const changeView=(patch:Partial<ScopeView>)=>{
    if(Object.hasOwn(patch,'inspection')&&!patch.inspection&&view.checkpoint?.selectedId)a.select(view.checkpoint.selectedId);
    setViews(current=>{const previous=current[viewKey]??view;let next={...previous,...patch};
      if(Object.hasOwn(patch,'inspection')){
        if(!patch.inspection&&previous.checkpoint)next={...previous,...previous.checkpoint,checkpoint:undefined,restoreTick:(previous.restoreTick??0)+1};
        else if(patch.inspection&&!previous.checkpoint)next.checkpoint={inspection:previous.inspection,viewport:patch.viewport??previous.viewport,selectedId:previous.selectedId,showAuxiliary:previous.showAuxiliary,showLocals:previous.showLocals};
      }return {...current,[viewKey]:next};
    });if(patch.inspection)setPanel('connections');else if(Object.hasOwn(patch,'inspection'))setPanel(null);
  };
  const selected=model.modules.find(m=>m.id===a.selected)??model.modules.find(m=>m.id===scope)!;
  const inspectedArray=view.inspection?.kind==='array'?{moduleId:view.inspection.id,index:view.inspection.index}:view.inspection?.kind==='connection'?view.inspection.index:undefined;
  const issues=readOnly?a.preview!.issues:a.extraIssues.length?a.extraIssues:a.snapshot.issues;
  const reviews=readOnly?[]:a.snapshot.moduleReviews;
  const confirmed=a.snapshot.moduleReviews.filter(r=>r.status==='APPROVED').length;
  const changePanel=(next:Panel)=>setPanel(p=>p===next?null:next);
  const select=(id:string,selectionScope=scope)=>{if(a.select(id)){setViews(current=>{const key=`${hash}:${selectionScope}`;return {...current,[key]:{...current[key],selectedId:id}}});setPanel(null);setShowInspector(true)}};
  const enter=(id:string)=>{if(!a.enter(id))return false;const next=views[`${hash}:${id}`];if(next?.selectedId)a.select(next.selectedId);if(panel==='connections')setPanel(next?.inspection&&next.inspection.kind!=='module'?'connections':null);return true};
  const navigateEndpoint=(endpoint:Endpoint)=>{const owner=model.modules.find(m=>m.id===scope)!;const next=endpoint.moduleId===scope?owner.parent:endpoint.moduleId;if(!next||!enter(next))return;const ids=model.connections.filter(l=>l.scope===next&&[l.from,l.to].some(e=>e.moduleId===endpoint.moduleId&&e.interfaceId===endpoint.interfaceId)).map(l=>l.id);setViews(current=>({...current,[`${hash}:${next}`]:{...current[`${hash}:${next}`],inspection:{kind:'connection',ids}}}));setPanel('connections')};
  const focus=(id:string)=>{const m=model.modules.find(m=>m.id===id);if(!m)return;const parent=m.parent??m.id;if(parent!==scope){if(!enter(parent))return;}select(id,parent)};
  const navigateReview=(id:string)=>{const m=model.modules.find(m=>m.id===id);if(!m)return;const target=m.kind==='subsystem'?id:m.parent??model.design.top;if(!enter(target))return;select(id,target);setPanel('review')};
  const propose=(commands:Command[],reason:string)=>{setCandidate(false);a.propose(commands,reason);setPanel('changes')};
  const inspectCandidate=()=>{if(!a.allowSwitch())return;setCandidate(true);setPanel(null)};
  return <EvidenceContext.Provider value={setEvidence}><div className="app-shell"><header className="app-header"><div className="brand"><span className="brand-mark">R</span><strong>RTL Architect</strong><span className="version-label" data-testid="frontend-version" title="页面构建版本">{frontendVersion}</span></div><div className="design-name" title={a.service?.workspaceRoot}>{model.design.name}<small> · {a.service?.workspaceRoot.split('/').pop()}</small></div><div className="header-actions"><span className={`status ${readOnly?'DRAFT':a.snapshot.reviewStatus}`} data-testid="review-status" title={hash}>{readOnly?'候选 · 未保存':({DRAFT:'草稿',APPROVED:'已批准',STALE:'需重新确认'}[a.snapshot.reviewStatus])}</span><button data-testid="open-work" onClick={()=>setPanel('work')}>讨论与继续</button><button data-testid="reload" className="quiet" disabled={a.busy} onClick={()=>void a.reload()}>重新加载</button><button onClick={()=>{setCandidate(false);setPanel('changes')}}>导入 AI 提案</button><button className="primary" data-testid="open-review" onClick={()=>{if(readOnly)setPanel('changes');else setPanel('review')}}>{readOnly?'检查变更 · 保存草稿':'审阅与批准'}</button></div></header>
    <CoverageSummary model={model} inspect={()=>setPanel('problems')}/>
    <div className={`workbench ${showTree?'':'hide-tree'} ${showInspector||panel==='connections'?'':'hide-inspector'}`}>
      {showTree&&<Hierarchy key={hash} model={model} scope={scope} selected={selected.id} reviews={reviews} select={focus} enter={enter} />}
      <main className="graph-workspace"><div className="graph-topbar"><button className="icon-button" title="切换层级树" aria-label="切换层级树" onClick={()=>setShowTree(!showTree)}>☷</button><Breadcrumbs model={model} scope={scope} enter={enter}/><div className="actions"><button disabled={readOnly} onClick={()=>setAdd(true)}>＋ 模块</button><button className="quiet" aria-label="切换属性面板" onClick={()=>setShowInspector(!showInspector)}>详情 {showInspector?'›':'‹'}</button></div></div>
        <ReactFlowProvider key={`${hash}-${scope}-${a.reloadVersion}`}><Canvas view={view} changeView={changeView} selectLocal={(id,endpoints)=>setLocalSignal({id,endpoints})} model={model} modelHash={hash} scope={scope} layout={readOnly?undefined:a.layouts.layout.scopes[scope]} layoutHash={a.layouts.layoutHash} selectedId={selected.id} reviews={reviews} readOnly={readOnly} select={select} enter={enter} connect={(link,replace)=>{if(a.connect(link,replace))setPanel('changes')}} selectEdge={ids=>{a.setSelectedEdge(ids[0]);setPanel('connections')}} saveLayout={a.saveLayout} report={a.setMessage}/></ReactFlowProvider>
        {model.modules.every(m=>m.parent!==scope)&&model.modules.find(m=>m.id===scope)?.interfaces.length===0&&<div className="canvas-empty"><h3>这个层级等待定义</h3><p>添加模块与接口，或导入 AI 架构提案。</p></div>}
      </main>
      {panel==='connections'?<aside className="inspector signal-sidebar"><div className="inspector-title"><h2>连接详情</h2></div><div className="inspector-scroll">{selected.instances&&<ArrayExplorer key={selected.id} model={model} module={selected} readOnly={readOnly} preview={propose} dirty={a.markDirty} initialIndex={inspectedArray?.moduleId===selected.id?inspectedArray.index:undefined} inspect={index=>changeView({inspection:index===undefined?undefined:{kind:'array',id:selected.id,index}})}/>}<SignalInspection arrayControlsId={selected.instances?selected.id:undefined} model={model} scope={scope} inspection={view.inspection} inspect={inspection=>changeView({inspection})} choose={a.setSelectedEdge} navigateEndpoint={navigateEndpoint}/>{!readOnly&&<ConnectionEditor key={`${scope}-${a.selectedEdge}`} model={model} scope={scope} selected={a.selectedEdge} submit={(link,replace)=>{if(a.connect(link,replace))setPanel('changes')}} disconnect={id=>propose([{op:'disconnect',connectionId:id}],'断开逻辑连接')}/>}</div></aside>:showInspector&&(selected.id===scope&&detailScope!==scope?<DesignBrief model={model} scope={scope} issues={issues} select={select} enter={enter} openModule={()=>setDetailScope(scope)} openSpec={()=>setPanel('spec')} openProblems={()=>setPanel('problems')}/>:<Inspector key={`${selected.id}-${hash}-${a.formVersion}`} enter={()=>enter(selected.id)} overview={selected.id===scope?()=>{if(a.allowSwitch())setDetailScope(undefined)}:undefined} module={selected} model={model} initialIndex={inspectedArray?.moduleId===selected.id?inspectedArray.index:undefined} inspectIndex={index=>changeView({inspection:index===undefined?undefined:{kind:'array',id:selected.id,index}})} readOnly={readOnly} reviews={reviews} preview={propose} dirty={a.markDirty} remove={id=>propose([{op:'delete_module',moduleId:id}],`删除 ${id} 及关联连接`)}/>)} 
    </div>
    <section className={`dock ${panel&&panel!=='connections'?'is-open':''}`}><div className="dock-tabs" role="tablist">{([['work','讨论与继续'],['spec','设计说明'],['changes',`变更${a.preview?` · ${a.preview.diff.length}`:''}`],['problems','待处理'],['review','审阅与批准'],['connections','连接']] as [Panel,string][]).map(([id,label])=><button role="tab" aria-selected={panel===id} key={id} className={panel===id?'active':''} data-testid={`tab-${id}`} onClick={()=>{if(id==='review')setCandidate(false);changePanel(id)}}>{label}</button>)}<div className="dock-spacer"/><small>{readOnly?'候选尚未保存':'当前已保存版本'}</small><button className="icon-button" aria-label={panel?'收起面板':'展开面板'} onClick={()=>setPanel(panel?null:'spec')}>{panel?'⌄':'⌃'}</button></div>
      {panel&&panel!=='connections'&&panel!=='work'&&<div className="dock-body">
        {panel==='spec'&&<SpecPanel model={model} moduleId={selected.id} index={inspectedArray?.moduleId===selected.id?inspectedArray.index:undefined} hash={hash} status={readOnly?'DRAFT':a.snapshot.reviewStatus} issues={issues} navigate={focus} edit={readOnly?undefined:()=>setEditSpec(true)}/>}
        {panel==='changes'&&<Changes proposal={a.proposal} preview={a.preview} busy={a.busy} conflict={a.conflict} needsFormPreview={a.needsFormPreview} commit={()=>{setCandidate(false);void a.commit()}} repreview={()=>a.proposal&&void a.runPreview(a.proposal)} rebase={()=>a.proposal&&void a.runPreview({...a.proposal,baseHash:a.snapshot!.modelHash})} imported={text=>{setCandidate(false);a.imported(text)}} inspect={inspectCandidate} discard={()=>{a.discardProposal();setCandidate(false)}}/>}
        {panel==='problems'&&<section className="problems"><div className="section-title"><h2>需要处理的事项</h2><span>{issues.length} 项</span></div>{issues.length?<IssueList model={model} issues={issues} navigate={focus}/>:<p className="empty-state compact">结构检查无问题。该结果不代表 RTL 仿真或一致性验证。</p>}</section>}
        {panel==='review'&&<ReviewPanel snapshot={a.snapshot} selected={a.snapshot.model.modules.some(m=>m.id===selected.id)?selected.id:a.snapshot.model.design.top} reviewer={a.reviewer} setReviewer={a.setReviewer} busy={a.busy||a.dirty.current||!!a.proposal} review={id=>void a.review(id)} navigate={navigateReview} exportFile={kind=>void a.exportFile(kind)}/>}

      </div>}
      <div hidden={panel!=='work'} className="dock-body work-dock"><WorkbenchPanel active={panel==='work'} model={model} target={{modelHash:hash,moduleId:selected.id,connectionIds:view.inspection?.kind==='connection'?view.inspection.ids:(a.selectedEdge?[a.selectedEdge]:[]),...(readOnly&&a.linkedProposal?.preview?.candidateHash===hash?{proposalId:a.linkedProposal.id}:{})}} proposal={readOnly?a.proposal:undefined} navigate={id=>{focus(id);setPanel('work');}}/></div>
    </section>
    <footer className="statusbar"><span className={`status-light ${issues.length?'warning':''}`}/><span data-testid="message" role="status">{a.message||'点击模块了解职责，点击连接查看信号'}</span><ModelIdentity model={model} hash={hash} serviceVersion={a.service?.toolVersion} proposal={a.linkedProposal} candidate={readOnly} compare={()=>setPanel('changes')}/></footer>
    {add&&<div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="新增模块"><h2>在 {scope} 新增模块</h2><label>实例 ID<input autoFocus aria-label="新实例 ID" value={newId} onChange={e=>setNewId(e.target.value)}/></label><label>模块类型<select aria-label="模块类型" value={kind} onChange={e=>setKind(e.target.value as Module['kind'])}>{kindSchema.options.map(k=><option key={k} value={k}>{k}</option>)}</select></label><p className="hint">通用模块的职责与接口需补充；fifo/add_const 保留初始示例限制。</p><footer><button onClick={()=>setAdd(false)}>取消</button><button className="primary" disabled={!newId.trim()} onClick={()=>{propose([{op:'create_module',id:newId,parent:scope,template:kind}],`在 ${scope} 新增 ${kind}`);setAdd(false);setNewId('')}}>预览新增</button></footer></section></div>}
    {editSpec&&<SpecificationEditor model={model} close={()=>setEditSpec(false)} submit={spec=>{propose([{op:'update_specification',specification:spec}],'更新设计需求与决策');setEditSpec(false)}}/>}
    {localSignal&&<LocalSignalDialog model={model} id={localSignal.id} endpoints={localSignal.endpoints} trace={()=>{changeView({inspection:{kind:'local',id:localSignal.id}});setLocalSignal(undefined)}} close={()=>setLocalSignal(undefined)}/>}
    {evidence&&<EvidenceDialog key={`${evidence}-${hash}`} id={evidence} hash={hash} proposal={readOnly?a.proposal:undefined} close={()=>setEvidence(undefined)}/>}
  </div></EvidenceContext.Provider>;
}
