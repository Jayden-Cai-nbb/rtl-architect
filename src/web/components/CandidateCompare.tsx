import { useState } from 'react';
import { modelSchema, type Model } from '../../core/schema';
import { semanticDiff } from '../../core/diff';
export function CandidateCompare(){
 const [files,setFiles]=useState<{before?:{name:string;model:Model};after?:{name:string;model:Model}}>({}),[error,setError]=useState('');
 const diff=files.before&&files.after?semanticDiff(files.before.model,files.after.model):undefined;
 return <details className="candidate-compare"><summary>比较两个候选模型（只读）</summary><p className="hint">只比较完整 Model JSON；不更改当前提案或提交基线。</p><div className="actions">{(['before','after'] as const).map(side=><label className="button-label" key={side}>{side==='before'?'候选 A':'候选 B'}{files[side]?` · ${files[side]!.name}`:''}<input aria-label={side==='before'?'候选 A':'候选 B'} type="file" accept=".json" onChange={e=>{const file=e.target.files?.[0];if(file)void file.text().then(text=>{const model=modelSchema.parse(JSON.parse(text));setFiles(current=>({...current,[side]:{name:file.name,model}}));setError('')}).catch(e=>setError(String(e)));e.target.value=''}}/></label>)}</div>{error&&<p role="alert">{error}</p>}{diff&&<><p>{diff.length} 项语义差异 · 提交仍以当前工作区版本为基线</p>{diff.map((d,i)=><details key={i}><summary>{d.kind} · {d.target}</summary><div className="diff-values"><pre>{JSON.stringify(d.before,null,2)??'∅'}</pre><span>→</span><pre>{JSON.stringify(d.after,null,2)??'∅'}</pre></div></details>)}</>}
 </details>;
}
