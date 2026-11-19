import {AskObject} from './WorkObject';
import {ModelStateCone} from './StateCone';
import {stateDescription} from '../../core/stateUpdates';
import {signalText} from '../../core/signals';
import type {Model} from '../../core/schema';
import type {Inspection} from '../../core/inspection';
import {EvidenceDetails,EvidenceLinks} from './Evidence';
import {TraceControls} from './SignalInspection';

export function LocalSignalDetails({model,modelHash,scope,id,branch,tracking,trace}:{
 model:Model;modelHash:string;scope:string;id:string;branch?:string;tracking?:Inspection;trace:(inspection?:Inspection)=>void;
}){
 const item=model.localSignals?.find(n=>n.scope===scope&&n.id===id);
 if(!item)return null;
 const state=stateDescription(item),active=state?.rows.find(r=>r.id===branch);
 const seed={kind:'local' as const,id};
 const writeRules=state?.rows??[];
 const renderRule=(r:typeof writeRules[number],i:number)=>(
  <article key={r.id} className="state-rule" data-branch={r.id} aria-current={r.id===branch?'true':undefined}>
   <div className="state-rule-title"><strong>{i+1} · {r.role} · {r.id}</strong><AskObject object={{kind:'update_branch',scope,stateId:id,id:r.id}}/></div>
   <dl><dt>沿前</dt><dd><code>{r.condition}</code></dd><dt>沿后</dt><dd><code>{r.action}</code></dd></dl>
  </article>
 );
 return <section aria-label="局部信号" data-testid="local-signal-detail">
  {active&&renderRule(active,writeRules.indexOf(active))}
  <p className="prose">{item.description}</p>
  <p className="hint">{scope}/{id} · 位宽 {JSON.stringify(item.width)}</p>
  {state&&<section data-testid="state-update">
   <details open={!active}><summary>{state.pattern} · 更新优先级</summary>
    <p className="hint">{state.note}</p>
    {writeRules.map((row,i)=>row===active?null:renderRule(row,i))}
   </details>
   <div className="actions">
    <button onClick={()=>trace({...seed,purpose:'data',depth:2})}>数据从哪里来</button>
    <button onClick={()=>trace({...seed,purpose:'control',depth:2})}>什么时候更新</button>
   </div>
  </section>}
  <TraceControls model={model} scope={scope} seed={seed} tracking={tracking} trace={trace}/>
  {item.driver.kind==='register'&&<EvidenceDetails summary="模型下一状态逻辑">
   {()=><ModelStateCone key={modelHash+scope+id} model={model} scope={scope} id={id} modelHash={modelHash}/>}
  </EvidenceDetails>}
  <EvidenceDetails summary="驱动声明与来源">{()=>
   <><pre className="command-preview">{item.driver.kind==='comb'?signalText(item.driver.value):item.driver.sourceText}</pre><EvidenceLinks ids={item.evidenceIds}/></>
  }</EvidenceDetails>
 </section>;
}
