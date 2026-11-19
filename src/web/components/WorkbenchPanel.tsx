import {DecisionEditor} from './DecisionEditor';
import {useEffect,useRef,useState} from 'react';
import {api} from '../api';
import type {Repository} from '../../workspace/repository';
import {workObjectLabel,workSelection,workTargetState,type WorkAction,type WorkTarget,type WorkbenchSnapshot} from '../../core/workbench';
import {selectionKey,selectionLabel} from '../../core/selection';
import type {Model,Proposal} from '../../core/schema';
import {BudgetEditor} from './BudgetEditor';
type Resume=Awaited<ReturnType<Repository['getResume']>>;
type Props={active:boolean;model:Model;currentHash:string;target:WorkTarget;composeTick:number;proposal?:Proposal;navigate:(target:WorkTarget)=>void};
const status={open:'等待答复',addressed:'已答复 · 待你核对',resolved:'已解决'};
function reviewLink(proposalId?:string,moduleId?:string,threadId?:string,checkpoint=false){const u=new URL(window.location.href);u.search='';const workspace=new URLSearchParams(window.location.search).get('workspace');if(workspace)u.searchParams.set('workspace',workspace);if(proposalId)u.searchParams.set('proposal',proposalId);if(moduleId)u.searchParams.set('module',moduleId);if(threadId)u.searchParams.set('thread',threadId);if(checkpoint)u.searchParams.set('checkpoint','1');u.searchParams.set('panel','work');return u.toString();}
export function WorkbenchPanel({active,model,currentHash,target,composeTick,proposal,navigate}:Props){
 const [data,setData]=useState<Resume>(),[tab,setTab]=useState<'discussion'|'resume'|'budget'|'runs'|'decisions'>('discussion'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const [questions,setQuestions]=useState<Record<string,string>>({}),[replies,setReplies]=useState<Record<string,string>>({}),[intent,setIntent]=useState(''),[nextStep,setNextStep]=useState(''),[showResolved,setShowResolved]=useState(false),[all,setAll]=useState(false);
 const input=useRef<HTMLTextAreaElement>(null),compose=useRef(0);
 const ref=workSelection(model,target),slot=ref?selectionKey(ref):JSON.stringify(target);
 const question=questions[slot]??'';
 const setQuestion=(text:string)=>setQuestions(old=>({...old,[slot]:text}));
 useEffect(()=>{
  if(!active||!data||compose.current===composeTick)return;
  if(tab!=='discussion'){setTab('discussion');return;}
  compose.current=composeTick;input.current?.focus();
 },[active,!!data,composeTick,tab]);
 const sequence=useRef(0),latest=useRef(data);latest.current=data;
 async function reload(){const ticket=++sequence.current;try{const result=await api<Resume>('resume');if(ticket===sequence.current)setData(result);}catch(e){if(ticket===sequence.current)setMessage(String(e));}}
 useEffect(()=>{if(!active)return;void reload();const timer=window.setInterval(()=>void reload(),10000);return()=>{window.clearInterval(timer);++sequence.current;};},[active,target.modelHash]);
 async function save(action:WorkAction['action'],done?:()=>void){
  if(!latest.current)return;setBusy(true);setMessage('');++sequence.current;
  try{await api<WorkbenchSnapshot>('workbench',{baseHash:latest.current.workbenchHash,action});done?.();await reload();setMessage('已保存。');}catch(e){setMessage(e instanceof Error?e.message:String(e));await reload();}finally{setBusy(false);}
 }
 async function bindTarget(){if(!proposal||target.proposalId||target.modelHash===data?.modelHash)return target;const registered=await api<{id:string}>('proposals',proposal);return {...target,proposalId:registered.id};}
 async function anchored(kind:'ask'|'checkpoint'){
  setBusy(true);try{const bound=await bindTarget();await save(kind==='ask'?{kind,title:question.trim().split('\n')[0].slice(0,240),text:question,target:bound}:{kind,intent,nextStep,target:bound},kind==='ask'?()=>setQuestion(''):undefined);}catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 const restored=useRef(false);
 useEffect(()=>{
  if(restored.current||!data||!active)return;
  const params=new URLSearchParams(window.location.search),thread=data.workbench.threads.find(t=>t.id===params.get('thread'));
  const saved=params.has('checkpoint')?data.workbench.checkpoint?.target:thread?.target;
  const state=params.has('checkpoint')?data.checkpointState:data.threadStates.find(t=>t.id===thread?.id);
  if(!saved||!state?.canLocate||saved.modelHash!==currentHash)return;
  restored.current=true;
  if(thread?.status==='resolved')setShowResolved(true);
  setTab('discussion');navigate(saved);
 },[data,active,currentHash]);
 const currentTarget=workTargetState(model,currentHash,target);
 const name=(t:WorkTarget)=>t.selection?selectionLabel(model,t.selection):t.object?workObjectLabel(t.object):t.connectionIds.length?t.connectionIds.join('、'):model.modules.find(m=>m.id===t.moduleId)?.name??'整体设计';
 const openedThread=new URLSearchParams(window.location.search).get('thread');
 const relevant=data?.workbench.threads.filter(t=>{
  if(t.id===openedThread)return true;
  if(!showResolved&&t.status==='resolved')return false;
  if(all)return true;
  if(t.target.modelHash!==target.modelHash||t.target.proposalId&&target.proposalId&&t.target.proposalId!==target.proposalId)return false;
  const old=workSelection(model,t.target);
  if(!old||!ref)return false;
  if(old.target.kind==='module'&&ref.target.kind==='module')return selectionKey({...old,scope:ref.scope})===slot;
  return selectionKey(old)===slot;
 })??[];
 const ordered=[...relevant].reverse().sort((a,b)=>Number(b.id===openedThread)-Number(a.id===openedThread));
 return <section className="collaboration-panel" aria-label="讨论与继续" data-mode={tab}>
 <div className="collaboration-tabs">
  {([['discussion','讨论'],['resume','继续工作'],['budget','方案预算'],['decisions','决策记录'],['runs','验证记录']] as const).map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}
  <button className="quiet refresh-work" onClick={()=>void reload()} disabled={busy}>刷新记录</button>
 </div>
 {message&&<p role="status" className="collaboration-notice">{message}</p>}
 {!data?<p>正在读取工作记录…</p>:<>
 <div hidden={tab!=='discussion'} className="collaboration-columns discussion-columns">
  <div className="work-compose">
   <h3 data-testid="discussion-target" title={name(target)}>关于 {name(target)}</h3>
   {!currentTarget.canLocate&&<p role="alert">{currentTarget.reason}</p>}
   <label>你的问题<textarea ref={input} aria-label="你的问题" rows={2} value={question} onChange={e=>setQuestion(e.target.value)} maxLength={12000}/></label>
   <button className="primary" disabled={busy||!question.trim()||!currentTarget.canLocate} onClick={()=>void anchored('ask')}>保存问题</button>
  </div>
  <div className="thread-list" aria-label="当前对象的讨论">
   <div className="thread-filters">
    <label className="work-check"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>查看全部对象</label>
    <label className="work-check"><input type="checkbox" checked={showResolved} onChange={e=>setShowResolved(e.target.checked)}/>包含已解决问题</label>
   </div>
   {!ordered.length&&<p className="empty-state compact">此对象还没有待处理的问题。</p>}
   {ordered.map(t=>{
    const state=data.threadStates.find(s=>s.id===t.id);
    return <article className="work-thread" key={t.id} data-thread-id={t.id}>
     <div className="thread-heading"><strong>{t.title}</strong><span>{status[t.status]}</span></div>
     <small title={name(t.target)}>{name(t.target)} · {new Date(t.updatedAt).toLocaleString()}</small>
     {state?.versionChanged&&<p className="collaboration-notice">提问后设计版本已变化，请核对原问题与当前实现。</p>}
     {!!state?.missingTargets.length&&<p>需要核对的原对象 · {state.missingTargets.join('、')}</p>}
     <div className="actions">
      <button disabled={!state?.canLocate||t.target.modelHash!==target.modelHash} onClick={()=>navigate(t.target)}>定位对象</button>
      {!state?.canLocate&&<span>{state?.reason}</span>}
      <a href={reviewLink(t.target.proposalId,t.target.moduleId,t.id)}>{t.target.proposalId?`查看该候选 · ${state?.proposalState??'不可用'}`:'打开讨论'}</a>
     </div>
     {t.messages.map(m=><div className={`work-message author-${m.author}`} key={m.id}><small>{m.author==='agent'?'Codex 答复':'你的记录'} · {new Date(m.createdAt).toLocaleString()}</small><p>{m.text}</p>{m.proposalId&&<a href={reviewLink(m.proposalId,t.target.moduleId)}>检查关联候选</a>}</div>)}
     {t.status!=='resolved'&&<label>补充问题<textarea aria-label={`补充 ${t.title}`} rows={2} value={replies[t.id]??''} onChange={e=>setReplies(old=>({...old,[t.id]:e.target.value}))}/></label>}
     <div className="actions">
      {t.status!=='resolved'&&<button disabled={busy||!replies[t.id]?.trim()} onClick={()=>void save({kind:'reply',author:'user',threadId:t.id,modelHash:data.modelHash,text:replies[t.id]},()=>setReplies(old=>({...old,[t.id]:''})))}>发送补充</button>}
      <button disabled={busy} onClick={()=>void save({kind:t.status==='resolved'?'reopen':'resolve',threadId:t.id,modelHash:data.modelHash})}>{t.status==='resolved'?'重新讨论':'我已理解，标记解决'}</button>
     </div>
    </article>;
   })}
  </div>
 </div>
 <div hidden={tab!=='resume'} className="collaboration-columns"><div><h3>记录下一步</h3><label>这次要解决什么<textarea aria-label="工作目标" rows={2} value={intent} onChange={e=>setIntent(e.target.value)} placeholder={data.workbench.checkpoint?.intent??'例如：判断共享运算单元能否满足吞吐目标'}/></label><label>下次从哪里继续<textarea aria-label="下一步" rows={2} value={nextStep} onChange={e=>setNextStep(e.target.value)} placeholder={data.workbench.checkpoint?.nextStep??'写下要验证的假设或待决定的问题'}/></label><p className="hint">同时记录当前对象和候选版本；不会覆盖图的布局。</p><button disabled={busy||!intent.trim()||!nextStep.trim()} onClick={()=>void anchored('checkpoint')}>保存继续位置</button></div><div><h3>上次的目标</h3>{data.workbench.checkpoint?<><p className="work-text">{data.workbench.checkpoint.intent}</p><p className="work-text">下一步：{data.workbench.checkpoint.nextStep}</p><p>{data.checkpointState?.reason}</p><button disabled={!data.checkpointState?.canLocate||data.workbench.checkpoint.target.modelHash!==target.modelHash} onClick={()=>{navigate(data.workbench.checkpoint!.target);setTab('discussion')}}>定位继续对象</button><a href={reviewLink(data.workbench.checkpoint.target.proposalId,data.workbench.checkpoint.target.moduleId,undefined,true)}>打开记录的对象</a>{data.workbench.checkpoint.target.modelHash!==data.modelHash&&<p className="hint">记录来自其他版本或候选；打开时核对版本状态。</p>}</>:<p>尚未记录。</p>}<h3>当前待办</h3><ul>{data.nextActions.map((text,i)=><li key={i}>{text}</li>)}</ul><p>{data.reviewNeeded.length} 个模块待审阅或复核。</p><details><summary>候选历史 · {data.proposals.length}</summary>{data.proposals.map(p=><p key={p.id}><a href={reviewLink(p.id)}>{p.reason}</a> · {({READY:'待审阅',STALE:'已过期',APPLIED:'已保存'})[p.state]}</p>)}</details><p className="hint">终端运行 rtlarch open --workspace 项目目录，会打开当前工作区并恢复可用的继续位置。</p></div></div>
 <div hidden={tab!=='budget'}><BudgetEditor modelHash={data.modelHash} moduleId={target.moduleId??model.design.top} candidate={target.modelHash!==data.modelHash} studies={data.workbench.studies} candidates={data.proposals} studyStates={data.studyStates} busy={busy} save={study=>save({kind:'study',study})}/></div>
 <div hidden={tab!=='decisions'}><DecisionEditor data={data} busy={busy} save={save}/></div>
 <div hidden={tab!=='runs'}><p className="prose">由 Codex 或终端显式运行验证清单，保存命令、工具版本、输入摘要和独立报告。页面只展示结果；关联的通过记录也不等于预算中的性能数值已实测。</p><code>rtlarch verify profile.json --workspace 项目目录 --json</code>{!data.runs.length&&<p className="empty-state compact">尚无本工作区的实际运行记录。</p>}<div className="run-list">{data.runs.map(r=><article className="work-thread" key={r.id}><strong>{r.name}</strong><p>{r.status==='passed'?'本次检查通过':`未通过：${r.status}`} · {r.fresh?'声明输入与模型仍匹配':'已变化或无法核对，请重新运行'}</p>{'inputClosure' in r&&<p className="hint">输入范围：{r.inputClosure==='declared_complete'?'作者声明完整（未自动发现依赖）':r.inputClosure==='partial'?'已知不完整':'尚未声明完整性'}；工具版本：{r.toolVersionsKnown?'已记录':'信息不足'}。</p>}{'stage' in r&&<small>{r.stage} · {r.durationMs} ms · {r.finishedAt}</small>}{'changedFiles' in r&&!!r.changedFiles?.length&&<p>变化：{r.changedFiles.join('、')}</p>}{'record' in r&&<code>{r.record}</code>}{'error' in r&&<p>{r.error}</p>}</article>)}</div></div>
 </>}
 </section>;
}
