import {CoveragePanel} from './Coverage';
import { EvidenceLinks } from './Evidence';
import type { Model } from '../../core/schema';
import { provenanceForModule } from '../../core/provenance';

export function CoverageSummary({ model, inspect }: { model: Model; inspect: () => void }) {
  const p = model.provenance; if (!p) return null;
  return <div className="coverage-summary" data-testid="coverage-summary"><strong>{p.origin === 'as_built' ? '现有 RTL 还原' : '设计方案'}</strong><span>{p.fidelity==='partial'?'连接和行为尚未记录完整，当前用于理解与核对。':'覆盖情况需结合源码核对。'}</span><button className="text-button" onClick={inspect}>查看缺口与依据 ↗</button></div>;
}
export function ProvenancePanel({ model, moduleId }: { model: Model; moduleId?: string }) {
  const p = moduleId ? provenanceForModule(model, moduleId) : model.provenance; if (!p) return null;
  return <section className="provenance-panel" data-testid="provenance-panel"><CoveragePanel model={model}/><h3>来源与证据</h3><p>{p.scope}</p><p className="hint">配置：{p.configuration} · 完整性声明：{p.fidelity}（非工具证明）</p><p className="hint">现状还原或不完整投影可保存草稿，不能批准或导出实现合同。实例比例不等于行为或连线覆盖率。</p>
    <details><summary>输入摘要与源码证据 · {p.evidence.length}</summary><p className="source-hash">输入摘要：{p.sourceDigest}</p>{p.evidence.map(e => <article className="requirement" key={e.id}><strong><EvidenceLinks ids={[e.id]}/> · {e.sourceKind}</strong><p>{e.file}{e.line ? `:${e.line}${e.endLine ? `–${e.endLine}` : ''}` : ''}{e.symbol ? ` · ${e.symbol}` : ''}</p><small className="source-hash">{e.fileHash}</small></article>)}</details>
    {p.unsupportedStructures.length > 0 && <details open><summary>未表达结构 · {p.unsupportedStructures.length}</summary>{p.unsupportedStructures.map(i => <p key={i.id}><strong>{i.kind}</strong> · {i.description}<small> · <EvidenceLinks ids={i.evidenceIds}/></small></p>)}</details>}
    {p.findings.length > 0 && <details><summary>事实、推断与冲突 · {p.findings.length}</summary>{p.findings.map(i => <article className="requirement" key={i.id}><strong>{i.classification} · {i.id}</strong><p>{i.text}</p><small>证据：{i.evidenceIds.length?<EvidenceLinks ids={i.evidenceIds}/>:'尚无'}</small></article>)}</details>}
    <details><summary>验证记录 · {p.verification.length}（记录复用不代表本轮执行）</summary>{p.verification.length ? p.verification.map((v,i)=><details key={i} className="verification-record"><summary>{v.target??'未标注目标'} · {v.stage} · {v.status} · {v.executedAt??'执行时间未记录'}</summary><p>{v.detail}</p><p className="hint">批次：{v.batchId??'未记录'} · 工具：{v.tool?`${v.tool.name} ${v.tool.version}`:'未记录'}</p><p className="source-hash">输入摘要：{v.sourceDigest??'未记录'}{v.sourceDigest&&v.sourceDigest!==p.sourceDigest?' · 与当前建模输入不同':''}</p><pre className="command-preview">{v.command||'没有执行命令'}</pre>{v.command&&<button onClick={()=>void navigator.clipboard.writeText(v.command)}>复制命令</button>}<EvidenceLinks ids={v.evidenceIds}/></details>) : <p className="hint">没有记录已执行验证。</p>}</details>
  </section>;
}
