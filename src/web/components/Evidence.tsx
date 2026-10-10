import { createContext, useContext, useEffect, useState } from 'react';
import type { Model, Proposal } from '../../core/schema';
import { api } from '../api';
export const EvidenceContext = createContext<(id: string) => void>(() => {});
export function EvidenceLinks({ ids }: { ids: string[] }) {
  const open = useContext(EvidenceContext);
  return <span className="evidence-links">{ids.map(id => <button className="text-button" key={id} onClick={()=>open(id)}>{id} ↗</button>)}</span>;
}
export function RelatedEvidence({ model, moduleId, itemId, kind }: { model: Model; moduleId?: string; itemId?: string; kind: string }) {
  const ids = model.provenance?.evidence.filter(e => e.targets?.some(t => t.kind === kind && t.moduleId === moduleId && (itemId === undefined || t.itemId === itemId))).map(e=>e.id) ?? [];
  return ids.length ? <span className="related-evidence">证据：<EvidenceLinks ids={ids}/></span> : null;
}
export function EvidenceDialog({ id, hash, proposal, close }: { id: string; hash: string; proposal?: Proposal; close:()=>void }) {
  const [result,setResult]=useState<{ evidence: { file: string; line?: number; fileHash: string }; actualHash: string; matches: boolean; startLine: number; text: string; lineExists: boolean }>();
  const [error,setError]=useState('');
  useEffect(()=>{let active=true;void api<NonNullable<typeof result>>('evidence',{id,modelHash:hash,...(proposal?{proposal}:{})}).then(r=>{if(active)setResult(r)}).catch(e=>{if(active)setError(String(e))});return()=>{active=false}},[id,hash,proposal]);
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-label="源码证据"><div className="section-title"><h2>{id} · 源码证据</h2><button onClick={close}>关闭</button></div>{error?<p role="alert">{error}</p>:result?<><p>{result.evidence.file}:{result.evidence.line??1}</p><p className={result.matches?'hint':'warning-box'}>{result.matches?'文件 SHA-256 与记录一致':'文件已变化：以下是当前内容，不再是记录中的证据；需重新审阅'}{!result.lineExists?'；记录行号超出当前文件':''}</p><details><summary>文件哈希</summary><p className="source-hash">记录：{result.evidence.fileHash}<br/>当前：{result.actualHash}</p><button onClick={()=>void navigator.clipboard.writeText(result.actualHash)}>复制当前哈希</button></details><pre className="source-code">{result.text.split('\n').map((line,i)=><span className={result.startLine+i===result.evidence.line?'source-highlight':''} key={i}><small>{result.startLine+i}</small> {line}{'\n'}</span>)}</pre></>:<p>读取证据…</p>}</section></div>;
}
