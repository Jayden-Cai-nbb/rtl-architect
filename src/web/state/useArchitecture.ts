import { useEffect, useRef, useState } from 'react';
import { proposalSchema, type Command, type Link, type Proposal, type ScopeLayout } from '../../core/schema';
import type { LayoutSnapshot, Preview, RegisteredProposal, Snapshot } from '../../core/api';
import type { ServiceInfo } from '../../core/service';
import { connectionIssues } from '../../core/engine';
import { api, bindWorkspace, HttpError } from '../api';
export function useArchitecture() {
  const [snapshot, setSnapshot] = useState<Snapshot>(), [layouts, setLayouts] = useState<LayoutSnapshot>();
  const [service, setService] = useState<ServiceInfo>(), [linkedProposal, setLinkedProposal] = useState<RegisteredProposal>();
  const [scope, setScope] = useState('top'), [selected, setSelected] = useState<string>(), [selectedEdge, setSelectedEdge] = useState<string>();
  const [proposal, setProposal] = useState<Proposal>(), [preview, setPreview] = useState<Preview>(), [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState(''), [extraIssues, setExtraIssues] = useState<Snapshot['issues']>([]), [busy, setBusy] = useState(false), [reviewer, setReviewer] = useState('');
  const [formVersion, setFormVersion] = useState(0), [reloadVersion, setReloadVersion] = useState(0), [needsFormPreview, setNeedsFormPreview] = useState(false);
  const dirty = useRef(false), layoutRef = useRef<LayoutSnapshot | undefined>(undefined), snapshotRef = useRef(snapshot), layoutQueue = useRef(Promise.resolve()), previewSequence = useRef(0);
  snapshotRef.current = snapshot;
  function fail(error: unknown) { setMessage(error instanceof Error ? error.message : String(error)); if (error instanceof HttpError) { setExtraIssues(error.issues); if (error.status === 409) { setConflict(true); setPreview(undefined); } } }
  async function load() { setService(await bindWorkspace()); const [state, layout] = await Promise.all([api<Snapshot>('model'), api<LayoutSnapshot>('layout')]); if (!Array.isArray(state.moduleReviews)) throw new Error('后台仍是旧版本，请停止旧服务并重新运行 ./start-demo.sh，然后刷新页面。'); setSnapshot(state); setLayouts(layout); layoutRef.current = layout; setScope(s => state.model.modules.some(m => m.id === s && m.kind === 'subsystem') ? s : state.model.design.top); return state; }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded=await load();
      const focusTarget=(model:Snapshot['model'])=>{const params=new URLSearchParams(window.location.search),id=params.get('module'),m=model.modules.find(m=>m.id===id);if(m){setSelected(m.id);setScope(m.kind==='subsystem'?m.id:m.parent??model.design.top);}const edge=params.get('connection');if(edge&&model.connections.some(l=>l.id===edge))setSelectedEdge(edge);};
      focusTarget(loaded.model);
      const id = new URLSearchParams(window.location.search).get('proposal');
      if (!id || cancelled) return;
      const saved = await api<RegisteredProposal>(`proposals/${encodeURIComponent(id)}`);
      if (cancelled) return;
      setLinkedProposal(saved);if(saved.preview)focusTarget(saved.preview.candidate);
      if (saved.state === 'APPLIED') { setMessage('当前模型已与该提案的候选版本一致；人工确认状态仍需单独检查。'); return; }
      setProposal(saved.proposal);
      if (saved.state === 'READY' && saved.preview) { setPreview(saved.preview); setMessage('已加载 AI 提案，可探索候选框图；尚未写入模型或批准。'); }
      else { setConflict(true); setPreview(undefined); setMessage('已登记提案的版本过期；原提案保留，请显式基于当前版本重新预览。'); }
    })().catch(fail);
    return () => { cancelled = true; };
  }, []);
  function allowSwitch() { if (!dirty.current) return true; if (!window.confirm('表单有未提交修改。确定丢弃并切换？取消可保留当前表单。')) return false; dirty.current = false; setFormVersion(v => v + 1); return true; }
  function select(id: string) { if (id !== selected && !allowSwitch()) return false; setSelected(id); setSelectedEdge(undefined); return true; }
  function enter(id: string) { if (!allowSwitch()) return false; setScope(id); setSelected(id); setSelectedEdge(undefined); return true; }
  async function runPreview(p: Proposal) {
    const sequence = ++previewSequence.current; setBusy(true); setProposal(p); setPreview(undefined); setConflict(false); setExtraIssues([]); setNeedsFormPreview(false);
    try { const result = await api<Preview>('preview', p); if (sequence !== previewSequence.current) return; setPreview(result); setMessage('预览完成；尚未写入模型。'); }
    catch (e) { if (sequence === previewSequence.current) fail(e); }
    finally { if (sequence === previewSequence.current) setBusy(false); }
  }
  function propose(commands: Command[], reason: string) {
    if (!snapshot) return;
    if (!commands.length) { setMessage('没有属性变化。'); return; }
    if (proposal && !window.confirm('替换当前尚未提交的提案？取消可保留提案。')) return;
    void runPreview({ baseHash: snapshot.modelHash, reason, commands });
  }
  function connect(link: Link, replaceId?: string) {
    if (!snapshot) return false; const issues = connectionIssues(snapshot.model, link, replaceId);
    if (issues.length) { setExtraIssues(issues); setMessage(`非法连接：${issues.slice(0,3).map(i => i.message).join('；')}${issues.length>3?`；共 ${issues.length} 项，详见问题面板`:''}`); return false; }
    propose([...(replaceId ? [{ op: 'disconnect' as const, connectionId: replaceId }] : []), { op: 'connect', connection: link }], replaceId ? '重新连接端点' : '新增连接');
    return true;
  }
  async function commit() {
    if (!proposal || !preview) return; setBusy(true);
    try { const state = await api<Snapshot>('commit', { proposal, candidateHash: preview.candidateHash }); setSnapshot(state); setScope(s => state.model.modules.some(m => m.id === s && m.kind === 'subsystem') ? s : state.model.design.top); setSelected(id => state.model.modules.some(m => m.id === id) ? id : state.model.design.top); setProposal(undefined); setPreview(undefined); setExtraIssues([]); setConflict(false); dirty.current = false; setFormVersion(v => v + 1); setMessage('草稿已写入 architecture/model.json；提交不等于人工确认。'); setLinkedProposal(undefined); const url = new URL(window.location.href); url.searchParams.delete('proposal'); window.history.replaceState(null, '', url); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }
  function saveLayout(scopeId: string, scopeLayout: ScopeLayout): Promise<void> {
    const task = layoutQueue.current.then(async () => {
      const current = layoutRef.current, state = snapshotRef.current; if (!current || !state) return;
      const layout = structuredClone(current.layout); layout.scopes[scopeId] = scopeLayout;
      for (const [id, saved] of Object.entries(layout.scopes)) {
        const owner = state.model.modules.find(m => m.id === id && m.kind === 'subsystem');
        if (!owner) { delete layout.scopes[id]; continue; }
        const allowed = new Set([...(state.model.localSignals?.filter(n=>n.scope===id).map(n=>`local:${id}:${n.id}`)??[]), ...state.model.modules.filter(m => m.parent === id).map(m => m.id), ...owner.interfaces.map(i => `boundary:${id}:${i.id}`)]);
        saved.positions = Object.fromEntries(Object.entries(saved.positions).filter(([node]) => allowed.has(node)));
      }
      try { const saved = await api<LayoutSnapshot>('layout', { baseLayoutHash: current.layoutHash, layout }, 'PUT'); layoutRef.current = saved; setLayouts(saved);  }
      catch (e) { setMessage(`布局未保存：${e instanceof Error ? e.message : String(e)}。请重新加载，避免覆盖新布局。`); throw e; }
    });
    layoutQueue.current = task.catch(() => undefined); return task;
  }
  async function reload() { if (!allowSwitch()) return; try { await layoutQueue.current; const current = await load(); if (proposal && proposal.baseHash !== current.modelHash) { setConflict(true); setPreview(undefined); } setReloadVersion(v => v + 1); setMessage('已重新加载；未提交提案仍保留。'); } catch (e) { fail(e); } }
  async function review(moduleId?: string) { if (!snapshot) return; setBusy(true); try { setSnapshot(await api<Snapshot>(moduleId ? 'review/module' : 'review', { modelHash: snapshot.modelHash, reviewer, ...(moduleId ? { moduleId } : {}) })); setMessage(moduleId ? `已确认 ${moduleId}，可继续下一个模块。` : '架构已批准，可导出正式合同。'); } catch (e) { fail(e); } finally { setBusy(false); } }
  async function exportFile(kind: 'spec' | 'contract') { if (!snapshot) return; setBusy(true); try { const result = await api<{ file: string }>('export', { modelHash: snapshot.modelHash, kind }); setMessage(`已写入 ${result.file}`); } catch (e) { fail(e); } finally { setBusy(false); } }
  function imported(text: string) { if (!allowSwitch()) return; try { const p = proposalSchema.parse(JSON.parse(text)); if (proposal && !window.confirm('替换当前尚未提交的提案？')) return; void runPreview(p); } catch (e) { fail(e); } }
  function markDirty(value: boolean) {
    dirty.current = value;
    if (value && (preview || proposal)) { ++previewSequence.current; setBusy(false); setPreview(undefined); setNeedsFormPreview(true); setMessage('表单已修改，请从属性面板重新预览。'); }
  }
  function discardProposal() { ++previewSequence.current; setProposal(undefined); setPreview(undefined); setConflict(false); setExtraIssues([]); setBusy(false); }
  return { snapshot, layouts, service, linkedProposal, scope, selected, selectedEdge, proposal, preview, conflict, message, extraIssues, busy, reviewer, setReviewer,
    formVersion, reloadVersion, needsFormPreview, select, enter, setSelectedEdge, runPreview, propose, connect, commit, saveLayout, reload, review,
    exportFile, imported, setMessage, markDirty, discardProposal, allowSwitch, dirty, fail };
}
