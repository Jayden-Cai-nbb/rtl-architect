import {useMemo} from 'react';
import {hardwareView} from '../../core/hardwareView';
import {inspectScope,type Inspection} from '../../core/inspection';
import {selectedConnections,selectionNodeName,type SelectionRef} from '../../core/selection';
import type {Endpoint,Model} from '../../core/schema';
import {endpointLabel,expandLink} from '../../core/signals';
import {PageList} from './Issues';
import {EvidenceDetails,RelatedEvidence} from './Evidence';

type Element={moduleId:string;index:number};
type Props={
 model:Model;selection:SelectionRef;tracking?:Inspection;arrayControlsId?:string;
 trace:(inspection?:Inspection)=>void;choose:(ids:string[],element?:Element)=>void;navigateEndpoint:(endpoint:Endpoint)=>void;
};

export function TraceControls({model,scope,seed,tracking,trace}:{model:Model;scope:string;seed:Inspection;tracking?:Inspection;trace:(inspection?:Inspection)=>void}){
 const detail=useMemo(()=>tracking?inspectScope(model,scope,tracking):undefined,[model,scope,tracking]);
 if(!tracking||!detail)return <button onClick={()=>trace(seed)}>查看关联范围</button>;
 const target=(value:Inspection)=>value.kind==='connection'?value.ids.join('、'):value.kind==='boundary'?value.groupId??value.role:value.id;
 return <div className="trace-controls">
  <p className="hint">当前追踪 {detail.depth} 层 · {target(tracking)}。{tracking.crossState?'已允许跨寄存器。':'遇到寄存状态停止。'}</p>
  <div className="actions">
   <button disabled={detail.depth>=8} onClick={()=>trace({...tracking,depth:detail.depth+1})}>再追一层</button>
   {!!detail.stateBoundaries.length&&<button disabled={detail.depth>=8} onClick={()=>trace({...tracking,crossState:true,depth:detail.depth+1})}>跨状态继续</button>}
   {(tracking.kind!==seed.kind||target(tracking)!==target(seed))&&<button onClick={()=>trace(seed)}>改为追踪当前对象</button>}
   <button onClick={()=>trace()}>退出追踪</button>
  </div>
  {tracking.kind==='local'&&tracking.purpose&&<p className="hint" data-testid="state-trace-purpose">{tracking.purpose==='data'?'突出当前状态的写入值及其来源。':'突出当前状态的更新条件与复位。'}</p>}
  {!!detail.stateBoundaries.length&&<p className="hint">状态边界 · {detail.stateBoundaries.join('、')}</p>}
  {!!detail.limited.length&&<p className="hint">{detail.limited.length} 项达到追踪上限。</p>}
 </div>;
}

export function SignalInspection({model,selection,tracking,trace,choose,navigateEndpoint,arrayControlsId}:Props){
 const {scope,target}=selection;
 const links=useMemo(()=>selectedConnections(selection),[selection]);
 const boundary=target.kind==='boundary'?model.modules.find(m=>m.id===scope)!.interfaces.filter(p=>target.ports.includes(p.id)):[];
 const portConnections=(portId:string)=>model.connections.filter(l=>l.scope===scope&&[l.from,l.to].some(e=>e.moduleId===scope&&!e.local&&e.interfaceId===portId)).map(l=>l.id);
 const boundaryIds=boundary.flatMap(p=>portConnections(p.id));
 const element=target.kind==='relationship'?target.element:target.kind==='module'&&target.index!==undefined?{moduleId:target.id,index:target.index}:undefined;
 const seed:Inspection=target.kind==='module'?{kind:'module',id:target.id}:
  target.kind==='relationship'&&!links.length?{kind:'local',id:target.members.find(m=>m.kind==='dependency')!.localId}:
  {kind:'connection',ids:target.kind==='boundary'?boundaryIds:links,...(element?{index:element}:{})};
 const selectionInspection:Inspection=target.kind==='module'&&element?{kind:'array',id:element.moduleId,index:element.index}:seed;
 const detail=useMemo(()=>inspectScope(model,scope,selectionInspection),[model,selection]);
 const tracked=useMemo(()=>tracking?inspectScope(model,scope,tracking):undefined,[model,scope,tracking]);
 const scoped=target.kind==='module'&&tracked?tracked:detail;
 const relations=useMemo(()=>new Map(hardwareView(model,scope).relationships.map(r=>[r.id,r])),[model,scope]);
 const relatedArrays=model.modules.filter(m=>m.instances&&detail.links.some(l=>[l.from,l.to].some(e=>e.moduleId===m.id)));
 const dependencies=target.kind==='relationship'?target.members.filter(m=>m.kind==='dependency'):[];
 const display=(e:Endpoint)=>endpointLabel({...e,moduleId:model.modules.find(m=>m.id===e.moduleId)?.name??e.moduleId});
 return <section className="signal-inspection" data-testid="signal-inspection">
  <TraceControls model={model} scope={scope} seed={selectionInspection} tracking={tracking} trace={trace}/>
  {!!boundary.length&&<PageList items={boundary} render={p=>{
   const ids=portConnections(p.id);
   return <p key={p.id}><strong>{p.id}</strong> · {JSON.stringify(p.width)} 位 <button disabled={!ids.length} onClick={()=>choose(ids)}>查看连线</button></p>;
  }}/>}
  {!!dependencies.length&&<div className="dependency-detail"><p>{dependencies.length} 项原始依赖</p><PageList items={dependencies} render={(m,i)=><p key={i} className="signal-row"><code>{endpointLabel(m.endpoint)}</code> → {selectionNodeName(model,scope,`local:${scope}:${m.localId}`)}</p>}/></div>}
  {relatedArrays.filter(m=>m.id!==arrayControlsId).map(m=><label key={m.id}>{m.name} 索引<input aria-label={`检查 ${m.id} 索引`} type="number" min={m.instances!.from} max={m.instances!.to} value={element?.moduleId===m.id?element.index:''} placeholder="数组汇总" onChange={e=>{
   const index=Number(e.target.value);
   if(e.target.value===''||!Number.isSafeInteger(index)||index<m.instances!.from||index>m.instances!.to)return;
   const instance={moduleId:m.id,index};
   const ids=model.connections.filter(l=>links.includes(l.id)&&[l.from,l.to].some(e=>e.moduleId===m.id)&&expandLink(model,l,instance).length).map(l=>l.id);
   if(ids.length)choose(ids,instance);
  }}/></label>)}
  {scoped.array&&<div className={scoped.missing.length?'warning-box':'hint'} data-testid="element-coverage">
   元素 [{scoped.array.index}] · {scoped.links.length} 条连接
   {scoped.missing.length>0&&<EvidenceDetails summary={`${scoped.missing.length} 项模型缺口`}>{()=><PageList items={scoped.missing} render={item=><p key={item.interfaceId}>{item.interfaceId} · {item.bits.map(b=>`[${b.msb}:${b.lsb}]`).join(', ')}</p>}/>}</EvidenceDetails>}
  </div>}
  <PageList items={target.kind==='relationship'&&!links.length?[]:scoped.resolved} render={({link,width,group},i)=>{
   const relation=relations.get(link.id);
   return <article className="signal-row" data-connection-id={link.id} key={`${link.id}-${i}`}>
    <button className="text-button" title={`${endpointLabel(link.from)} → ${endpointLabel(link.to)}`} onClick={()=>choose([link.id],scoped.array)}>{display(link.from)} → {display(link.to)}</button>
    <p>{group.label} · {width??'待求值'} 位 · <code>{link.id}</code></p>
    {relation?.kind==='ready_valid'&&<p className="hint" data-testid="rv-members">data [{width??'?'}b] → · valid [1b] → · ready [1b] ←</p>}
    {relation?.classification==='conflict'&&<p className="hint">两端分组冲突，请核对用途。</p>}
    {relation&&<EvidenceDetails summary="连接来源与证据">{()=><><p>{relation.meaning}</p><p>模型连接 <code>{relation.id}</code></p><RelatedEvidence model={model} kind="connection" itemId={link.id}/></>}</EvidenceDetails>}
    {[link.from,link.to].filter(e=>!e.local&&model.modules.find(m=>m.id===e.moduleId)?.kind==='subsystem'&&(e.moduleId!==scope||model.modules.find(m=>m.id===scope)?.parent)).map((e,n)=><button key={n} onClick={()=>navigateEndpoint(e)}>{e.moduleId===scope?'到父层':'进入模块'} · {e.interfaceId}</button>)}
   </article>;
  }}/>
  {!scoped.links.length&&!dependencies.length&&<p className="hint">此范围没有已记录的连接。</p>}
 </section>;
}
