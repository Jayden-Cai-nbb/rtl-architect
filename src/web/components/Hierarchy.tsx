import { useState } from 'react';
import type { Model } from '../../core/schema';
import type { Snapshot } from '../../core/api';
import { childrenOf } from '../../core/engine';
export function Hierarchy({ model, scope, selected, reviews, select, enter }: { model: Model; scope: string; selected?: string; reviews: Snapshot['moduleReviews']; select: (id: string) => void; enter: (id: string) => void }) {
  const [search, setSearch] = useState(''), [collapsed, setCollapsed] = useState<string[]>(()=>model.modules.filter(m=>m.kind==='subsystem'&&m.id!==model.design.top).map(m=>m.id));
  function matches(id: string): boolean { const m = model.modules.find(m => m.id === id)!; return `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase()) || childrenOf(model, id).some(child => matches(child.id)); }
  const render = (id: string, depth = 0) => {
    const m = model.modules.find(m => m.id === id)!, children = childrenOf(model, id), isClosed = collapsed.includes(id) && !search;
    const status = reviews.find(r => r.moduleId === id)?.status ?? 'DRAFT';
    return matches(id) ? <div key={id}>
      <div className={`tree-row ${selected === id ? 'selected' : ''}`} style={{ paddingLeft: 12 + depth * 15 }}>
        <button className="tree-toggle" aria-label={`${isClosed ? '展开' : '折叠'} ${id}`} onClick={() => setCollapsed(ids => isClosed ? ids.filter(i => i !== id) : [...ids, id])}>{children.length ? isClosed ? '›' : '⌄' : '·'}</button>
        <button data-testid={`tree-${id}`} className="tree-item" title={`${m.id} · ${m.kind}`} onClick={() => select(id)} onDoubleClick={() => m.kind === 'subsystem' && enter(id)}><span>{m.kind === 'subsystem' ? '▣' : '▢'}</span><span>{m.name}{m.instances?` ×${m.instances.to-m.instances.from+1}`:''}</span><i className={`review-dot ${status}`} title={status} /></button>
      </div>
      {!isClosed && children.map(child => render(child.id, depth + 1))}
    </div> : null;
  };
  return <aside className="hierarchy"><div className="panel-heading"><h2>设计层级</h2><span>{model.modules.length}</span></div><div className="search-box"><input aria-label="搜索模块" placeholder="搜索名称或 ID…" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="tree-scroll">{render(model.design.top)}</div><div className="hierarchy-footer"><span className="review-dot APPROVED" /> 已确认 <span className="review-dot DRAFT" /> 待审阅<p>双击子系统进入内部</p></div></aside>;
}
export function Breadcrumbs({ model, scope, enter }: { model: Model; scope: string; enter: (id: string) => void }) {
  const ancestors = []; let m = model.modules.find(m => m.id === scope);
  while (m) { ancestors.unshift(m); m = model.modules.find(p => p.id === m!.parent); }
  return <nav aria-label="层级路径">{ancestors.map((m, i) => <span key={m.id}>{i > 0 && <span className="breadcrumb-separator">/</span>}<button data-testid={`breadcrumb-${m.id}`} className={m.id === scope ? 'current' : ''} onClick={() => enter(m.id)}>{m.name}</button></span>)}</nav>;
}
