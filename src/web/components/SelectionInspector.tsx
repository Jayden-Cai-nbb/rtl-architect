import {selectedConnections,selectionLabel,selectionNodeId,selectionNodeName,type SelectionRef,type SelectionTarget} from '../../core/selection';
import type {Endpoint,Link,Model} from '../../core/schema';
import type {Inspection} from '../../core/inspection';
import {ConnectionEditor} from './ConnectionEditor';
import {SignalInspection} from './SignalInspection';
import {LocalSignalDetails} from './LocalSignal';
import {PageList} from './Issues';

export function SelectionInspector({model,selection,tracking,trace,pick,ask,navigateEndpoint,readOnly,showEditor,saveConnection,disconnect}:{
 model:Model;selection:SelectionRef;tracking?:Inspection;trace:(inspection?:Inspection)=>void;
 pick:(target:SelectionTarget)=>void;ask:()=>void;navigateEndpoint:(endpoint:Endpoint)=>void;
 readOnly:boolean;showEditor:boolean;saveConnection:(link:Link,replace?:string)=>void;disconnect:(id:string)=>void;
}){
 const {scope,target,modelHash}=selection;
 const label=selectionLabel(model,selection);
 const local=target.kind==='local'?model.localSignals?.find(l=>l.scope===scope&&l.id===target.id):undefined;
 const record=target.kind==='requirement'?model.specification?.requirements.find(r=>r.id===target.id):
  target.kind==='obligation'?model.modules.find(m=>m.id===(target.moduleId??scope))?.contract.obligations?.find(o=>o.id===target.id):undefined;
 const ids=selectedConnections(selection);
 const editorLink=ids.length===1?ids[0]:undefined;
 const title=target.kind==='relationship'?ids.length?'连接详情':'依赖详情':target.kind==='local'?selectionNodeName(model,scope,selectionNodeId(scope,target.id)):
  target.kind==='group'?'集合成员':target.kind==='boundary'?'层级接口':record?'讨论对象':'连接详情';
 return <aside className="inspector signal-sidebar selected-object" data-testid="selection-inspector" aria-label={title}>
  <div className="inspector-title">
   <h2>{title}</h2>
   <div className="selected-object-heading"><span data-testid="current-object" title={label}>{label}</span><button onClick={ask}>对此提问</button></div>
  </div>
  <div className="inspector-scroll" key={label}>
   {target.kind==='local'&&local?<LocalSignalDetails model={model} modelHash={modelHash} scope={scope} id={target.id} branch={target.branch} tracking={tracking} trace={trace}/>:
    target.kind==='group'?<PageList items={target.members} render={id=><p className="signal-row" key={id}><button className="text-button" onClick={()=>pick(id.startsWith('local:')?{kind:'local',id:id.split(':')[2]}:{kind:'module',id})}>{selectionNodeName(model,scope,id)}</button><br/><code>{id}</code></p>}/>:
    record?<div className="prose">{'text' in record?<><p>{record.text}</p><p>{record.acceptance}</p></>:<p>{record.description}</p>}</div>:
    <SignalInspection model={model} selection={selection} tracking={tracking} trace={trace} navigateEndpoint={navigateEndpoint}
     choose={(ids,element)=>pick({kind:'relationship',members:ids.map(id=>({kind:'connection',id})),...(element?{element}:{})})}/>}
   {!readOnly&&(showEditor||target.kind==='relationship'&&ids.length>0)&&<ConnectionEditor key={editorLink??'new'} model={model} scope={scope} selected={editorLink} submit={saveConnection} disconnect={disconnect}/>}
  </div>
 </aside>;
}
