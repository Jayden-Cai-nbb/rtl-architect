import { diagramReader } from './diagramReader';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Snapshot } from '../core/api';
import type { Layout, Model } from '../core/schema';
import { contractData, hashValue, modelHash, specText } from '../core/export';
import { validateModel } from '../core/engine';
import { scopeDiagram, type Positions } from '../web/graph/scopeDiagram';
import { diagramSvg } from '../web/graph/exportSvg';
import { diagramQuality } from '../web/graph/quality';
import { arrangeScope } from '../web/graph/readingLayout';
import { evidenceFreshness } from './freshness';
import { toolRoot, toolVersion, ToolError } from './environment';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const html = (value: unknown) => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
async function canonicalDestination(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return join(await canonicalDestination(dirname(path)), basename(path)); }
}
/** A standalone, read-only projection. It never exports into the authoritative contract directory. */
export async function exportBundle(workspace: string, destination: string, model: Model, snapshot?: Snapshot, layout?: Layout) {
  const root = await realpath(workspace), output = await canonicalDestination(resolve(destination));
  for (const base of [root, await realpath(toolRoot)]) {
    const path = relative(base, output);
    if (!path || /^(architecture|generated|\.rtlarch)(\/|$)/.test(path)) throw new ToolError('OUTPUT_PROTECTED', '成果包必须使用 architecture/generated/.rtlarch 之外的新目录');
  }
  const hash = modelHash(model), status = snapshot?.reviewStatus ?? 'DRAFT', issues = snapshot?.issues ?? validateModel(model);
  if (issues.some(i => i.blocks.includes('commit'))) throw new ToolError('MODEL_INVALID', '结构不合法的模型不能导出成果包', issues);
  const freshness = await evidenceFreshness(root, model), files: Record<string, string> = {};
  const scopes = model.modules.filter(m => m.kind === 'subsystem');
  // Include a leaf top as a valid design even if it has no child diagram.
  if (!scopes.length) scopes.push(model.modules.find(m => m.id === model.design.top)!);
  const diagrams = [], graphs:ReturnType<typeof scopeDiagram>[]=[];
  const resolvedLayout: Record<string, { positions: Positions; reading?: Layout['scopes'][string]['reading'] }> = {};
  for (const owner of scopes) {
    const saved = layout?.scopes[owner.id], children = model.modules.filter(m => m.parent === owner.id);
    if (saved?.reading && saved.reading.modelHash !== hash) throw new ToolError('LAYOUT_OUTDATED', `层级 ${owner.id} 的阅读约束对应旧模型`);
    const positions = saved && children.every(m => saved.positions[m.id]) ? saved.positions : await arrangeScope(model, owner.id, hash, saved?.reading);
    resolvedLayout[owner.id] = { positions, ...(saved?.reading ? { reading: saved.reading } : {}) };
    const graph = scopeDiagram(model, owner.id, { positions,reading:saved?.reading }), quality = diagramQuality(graph);
    const file = `${owner.id}.svg`, qualityFile = `${owner.id}.quality.json`;
    files[file] = diagramSvg(model, owner.id, { positions, reading:saved?.reading, showPortNames:true }, hash,graph);
    files[qualityFile] = json({ modelHash: hash, scope: owner.id, layoutHash: hashValue(resolvedLayout[owner.id]), ...quality });
    graphs.push(graph);
    diagrams.push({ scope: owner.id, name: owner.name, file, qualityFile, quality });
  }
  const declared = model.provenance?.verification ?? [];
  const states = {
    architecture: { status: snapshot ? status : 'CANDIDATE', modelHash: hash },
    evidence: { status: freshness.status, checkedAt: freshness.checkedAt },
    implementation: { status: 'not_checked', declaredRecords: declared.filter(v => ['lint','simulation','formal'].includes(v.stage)), note: '以下为模型声明的历史记录；本次未执行 RTL 检查，未自动接入外部运行记录。' },
    physical: { status: 'not_checked', declaredRecords: declared.filter(v => ['synthesis','timing'].includes(v.stage)), note: '本次未执行器件验收；历史综合或 timing 字段不自动证明完整 STA。' },
  };
  files['model.json'] = json(model); files['contract.json'] = json(contractData(model));
  files['spec.md'] = specText(model, status, issues); files['evidence.json'] = json(freshness);
  files['connections.json'] = json({ modelHash: hash, connections: model.connections, localSignals: model.localSignals ?? [] });
  files['layout.json'] = json({ schemaVersion: 1, scopes: Object.fromEntries(Object.entries(resolvedLayout).map(([id, value]) => [id, {...value, viewport: {x:0,y:0,zoom:1}}])) }); files['status.json'] = json(states);
  const approvalLabel = snapshot ? ({DRAFT:'草稿，待审阅', APPROVED:'当前版本已批准', STALE:'版本变化，需重新确认'}[status]) : '候选，尚未批准';
  const evidenceLabel = freshness.status === 'fresh' ? '声明文件全部匹配' : freshness.status === 'unknown' ? '尚无声明来源' : `${freshness.files.filter(f => f.state !== 'matched').length} 项来源需核对`;
  const links = diagrams.map(d => `<li><a href="${d.file}">${html(d.name)}结构图</a> · <a href="#scope-${d.scope}">连接索引</a> · <a href="${d.qualityFile}">几何检查：${d.quality.status === 'passed' ? '通过' : '需修正'}</a></li>`).join('');
  const requirements = model.specification?.requirements ?? [], decisions = model.specification?.decisions ?? [];
  const questions = [...(model.specification?.openQuestions ?? []), ...model.modules.flatMap(m => m.contract.openQuestions.map(q => `${m.name}：${q}`))];
  const table = (head: string[], rows: unknown[][]) => `<div class="scroll"><table><thead><tr>${head.map(c=>`<th>${html(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${html(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const endpoint = (e: Model['connections'][number]['from']) => `${e.moduleId}${e.index !== undefined ? `[${e.index}]` : ''}.${e.interfaceId}${e.slice ? `[${e.slice.msb}:${e.slice.lsb}]` : ''}${e.sliceMapping ? ` ${JSON.stringify(e.sliceMapping)}` : ''}${e.local ? ' (局部驱动)' : ''}`;
  files['index.html'] = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(model.design.name)} · 当前成果快照</title>
<style>body{font:16px/1.65 system-ui,sans-serif;color:#203849;background:#f5f8fa;margin:0}main{max-width:1720px;margin:auto;padding:28px}h1{font-size:28px}h2{margin-top:32px}a{color:#17658b}section,details{background:white;border:1px solid #d5e0e7;border-radius:8px;padding:18px;margin:14px 0}summary{cursor:pointer;font-weight:600}.states{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.states section{margin:0}table{border-collapse:collapse;width:100%}td,th{padding:9px;border-bottom:1px solid #dbe5ea;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3f7}.scroll{overflow:auto}p,td{white-space:pre-wrap}code{overflow-wrap:anywhere}img{width:100%;height:auto}.diagram-scroll{overflow:auto}.diagram-scroll img{width:auto;max-width:none}.muted{color:#5b6e7b}li{margin:5px 0}
.diagram-reader{padding:0;overflow:hidden}.diagram-bar{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 18px;background:#f8fafc;border-bottom:1px solid #e3e9ee}.scope-tabs,.diagram-actions{display:flex;gap:6px;flex-wrap:wrap}button{font:inherit;font-size:13px;padding:6px 12px;cursor:pointer;color:#38566b;background:#fff;border:1px solid #d3dfe6;border-radius:4px}button[aria-selected=true],button[aria-pressed=true]{background:#eaf2f7;border-color:#6f94aa;color:#174761}.reader-hint{font-size:13px;color:#647b8b;margin:10px 20px}.diagram-stage{overflow:auto;background:#fff;height:68vh;min-height:340px;overscroll-behavior:contain;scrollbar-gutter:stable}.diagram-stage svg{display:block;width:100%;height:100%;max-height:none}.diagram-stage.native svg{width:auto;max-width:none;height:auto;max-height:none}.diagram-stage [data-node-id]{user-select:none}.diagram-stage [role=button],.diagram-stage [data-wire-label]{cursor:pointer}.diagram-stage [data-edge-id]{pointer-events:stroke;stroke-width:2}.diagram-stage [data-edge-id].traced{stroke-width:2.7}.diagram-stage [role=button]:focus{outline:2px solid #bd883d}.diagram-caption{font-size:12px;margin:6px 20px}.diagram-reader.focus{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;margin:0;border-radius:0}.diagram-reader.focus .diagram-panel:not([hidden]){display:flex;flex:1;min-height:0;flex-direction:column}.diagram-reader.focus .diagram-stage{flex:1;min-height:0}.diagram-reader.focus .diagram-stage svg{height:100%;max-height:none}.diagram-reader.focus .diagram-stage.native svg{height:auto}.diagram-reader.focus #diagram-trace{flex:0 0 130px;max-height:130px}#diagram-zoom{font-size:12px;min-width:42px;align-self:center;text-align:center}#diagram-trace{border-top:1px solid #e4ebf0;background:#f8fafc;padding:14px 20px;font-size:13px;max-height:240px;overflow:auto}#diagram-trace p{margin:4px 0}#diagram-trace ul{font-family:ui-monospace,monospace;font-size:12px;padding-left:18px;overflow-wrap:anywhere}.states{font-size:13px}.states section{padding:10px 14px}.states p{margin:3px 0}h1{margin:0 0 8px;font-size:24px}.design-purpose{padding:0;border:0;background:transparent;margin:6px 0;font-size:14px}.design-purpose summary{font-weight:400}.design-purpose p{max-width:1200px}.muted{font-size:12px;margin:8px 0}main>p{max-width:1200px}@media(max-width:800px){main{padding:12px}.diagram-bar{align-items:flex-start;flex-direction:column}}
</style><main>
<h1>${html(model.design.name)}</h1><details class="design-purpose"><summary>设计用途与说明</summary><p>${html(model.specification?.summary || model.modules.find(m=>m.id===model.design.top)?.contract.responsibility || '用途尚待补充')}</p></details>
<p class="muted">${snapshot ? '当前工作区快照' : '候选快照 · 未借用工作区批准'} · ${hash.slice(0,12)} · 工具 ${html(toolVersion)}</p>
<div class="states"><section><strong>架构批准</strong><p>${html(approvalLabel)}</p></section><section><strong>来源新鲜度</strong><p>${html(evidenceLabel)} · 共 ${freshness.files.length} 项</p></section><section><strong>实现验证</strong><p>本次未核验</p></section><section><strong>器件验收</strong><p>本次未核验</p></section></div>
${diagramReader(model,diagrams,files,graphs)}
<section><h2>文档与依据</h2><ul>${links}<li><a href="spec.md">完整 Spec</a> · <a href="contract.json">合同副本</a> · <a href="evidence.json">来源核验</a> · <a href="manifest.json">版本与产物摘要</a></li></ul><p>先沿输入追踪状态保存与输出，再核对阻塞、复位和完成条件。图中位置不表示周期；合同副本不取代正式 handoff。</p></section>
<h2>现在需要处理什么</h2>${questions.length ? `<ul>${questions.map(q=>`<li>${html(q)}</li>`).join('')}</ul>` : '<p>模型没有记录待定设计问题；请继续核对验证及集成义务。</p>'}
${freshness.status !== 'fresh' ? '<p>来源需核对：查看 evidence.json 中的具体文件和关联对象，分析影响后再决定是否重审或重跑。</p>' : ''}
${issues.length ? table(['对象','检查','影响'],issues.map(i=>[i.target,i.message,i.blocks.join(', ') || '提示'])) : ''}
<h2>为什么这样设计</h2>${decisions.length ? decisions.map(d=>`<details><summary>${html(d.text)}</summary><p>${html(d.rationale || '未记录理由')}</p><p class="muted">${html(d.moduleIds.join(', '))}</p></details>`).join('') : '<p>尚未记录设计取舍。</p>'}
<h2>目标与验收办法</h2>${table(['目标','验收条件','负责模块'],requirements.map(r=>[r.text,r.acceptance,r.moduleIds.join(', ')]))}
<h2>已有验证声明</h2><p>保留原始时态与条件。本次只生成交付快照，没有重新运行或独立核验以下验证。</p>${table(['阶段','声明状态','目标 / 时间','范围与依据'],declared.map(v=>[v.stage,v.status,[v.target,v.executedAt].filter(Boolean).join(' / '),v.detail]))}
${diagrams.map(d=>`<section id="scope-${d.scope}"><h2>${html(d.name)}</h2><p>${html(model.modules.find(m=>m.id===d.scope)?.contract.responsibility)}</p><p><a href="${d.file}">完整矢量图</a> · <a href="${d.qualityFile}">几何与标签检查</a>。几何检查${d.quality.status === 'passed' ? '通过' : '需修正'}；未排下线名 ${d.quality.hiddenLabels.length}。视觉可读性仍需实际审阅。</p>${table(['模块','职责'],model.modules.filter(m=>m.parent===d.scope).map(m=>[`${m.name} (${m.id})`,m.contract.responsibility]))}<details><summary>完整连接索引（含折叠项）</summary>${table(['ID','来源','去向'],model.connections.filter(l=>l.scope===d.scope).map(l=>[l.id,endpoint(l.from),endpoint(l.to)]))}</details></section>`).join('')}
<footer><p>完整模型版本：<code>${hash}</code></p><p>离线快照不会自动追随项目变化。模型/Spec/合同来自同一输入；图形和批准不构成 RTL 验证。</p></footer></main></html>`;
  files['README.md'] = `# ${model.design.name}\n\n打开 [index.html](index.html) 查看用途、取舍、图和完整连接索引。\n\n- 版本：${hash}\n- 架构：${approvalLabel}\n- 来源：${evidenceLabel}\n- 实现验证：本次未核验\n- 器件验收：本次未核验\n\n${diagrams.map(d=>`- [${d.name}](${d.file})：几何检查 ${d.quality.status}`).join('\n')}\n\n[Spec](spec.md) · [合同副本](contract.json) · [证据](evidence.json) · [产物摘要](manifest.json)\n\n副本不代替 handoff；历史验证声明见 status.json。\n`;
  const manifest = { schemaVersion: 1, toolVersion, modelHash: hash, createdAt: new Date().toISOString(), source: snapshot ? 'workspace' : 'candidate',
    reviewStatus: states.architecture.status, layoutHash: hashValue(resolvedLayout), states, diagrams: diagrams.map(({quality,...d})=>({...d,status:quality.status})),
    files: Object.entries(files).map(([file, text])=>({file,sha256:sha(text),bytes:Buffer.byteLength(text)})) };
  files['manifest.json'] = json(manifest);
  // Refuse existing destinations, including symlinks. Never overwrite a previous delivery.
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  for (const [file, content] of Object.entries(files)) await writeFile(join(output,file),content,{flag:'wx'});
  return { directory: output, entry: join(output,'index.html'), modelHash: hash, reviewStatus: states.architecture.status, evidenceStatus: freshness.status,
    geometryPassed: diagrams.every(d=>d.quality.status==='passed'), diagrams: manifest.diagrams, readOnlySource: true };
}
