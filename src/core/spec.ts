import {stateDescription} from './stateUpdates';
import {coverageReport} from './coverage';
import {diagnosticGroups} from './diagnostics';
import { signalText, endpointLabel, expandLink } from './signals';
import { bindingText, parameterReport, parameterValue, instanceCount, physicalInstanceCount } from './parameters';
import type { Issue, Model, Module, ReviewStatus } from './schema';
import { resolveWidth } from './engine';
import { provenanceForModule } from './provenance';

export function timingDescription(model: Model, module: Module) {
  const reset = model.resets.find(r => r.id === module.reset), clock = model.clocks.find(c => c.id === module.clock);
  const kind = module.timing ?? 'sequential';
  const timing = { sequential: '时序', combinational: '纯组合', mixed: '混合', unknown: '待确认' }[kind];
  return `${timing} · 时钟：${clock ? `${clock.id}（${clock.edge === 'rising' ? '上升沿' : '下降沿'}）` : kind === 'unknown' ? '未知' : '无'} · 复位：${reset ? `${reset.id}（${reset.synchronous ? '同步' : '异步'}，${reset.activeLevel === 'low' ? '低' : '高'}有效${!reset.synchronous ? `，释放${reset.deassertion === 'synchronous' ? '同步' : reset.deassertion === 'asynchronous' ? '异步' : '待确认'}` : ''}）` : kind === 'unknown' ? '未知' : '无'}`;
}

export function moduleIssues(model: Model, issues: Issue[], moduleId: string): Issue[] {
  return issues.filter(issue => {
    if (issue.target === 'provenance') return true;
    if (issue.target === moduleId || issue.target.startsWith(`${moduleId}.`)) return true;
    if (issue.target.split('/')[1] === moduleId) return true;
    const link = model.connections.find(link => link.id === issue.target);
    return !!link && (link.from.moduleId === moduleId || link.to.moduleId === moduleId);
  });
}
export function hierarchyOrder(model: Model): Module[] {
  const result: Module[] = [];
  const visit = (id: string) => {
    const module = model.modules.find(item => item.id === id);
    if (!module) return;
    result.push(module);
    model.modules.filter(item => item.parent === id).sort((a, b) => a.id.localeCompare(b.id)).forEach(item => visit(item.id));
  };
  visit(model.design.top);
  return result;
}
export function moduleDocument(model: Model, moduleId: string, index?:number) {
  const module = model.modules.find(item => item.id === moduleId);
  if (!module) throw new Error(`模块不存在：${moduleId}`);
  if(index!==undefined&&(!module.instances||index<module.instances.from||index>module.instances.to||!Number.isInteger(index)))throw new Error('数组索引超出范围');
  const selected=index??module.instances?.from;
  return {
    module,
    ...(module.instances?{instance:{index:selected!,count:instanceCount(module),sourcePath:module.instances.sourcePath.replaceAll('{'+module.instances.indexVariable+'}',String(selected)),parameters:Object.fromEntries(Object.keys(module.parameters).map(k=>[k,parameterValue(model,module,k,selected)]))}}:{}),
    parameterReport:parameterReport(model,module,selected),
    localSignals:model.localSignals?.filter(n=>n.scope===moduleId)??[],
    interfaces: module.interfaces.map(intf => ({ ...intf, resolvedWidth: resolveWidth(module, intf, model, selected) })),
    children: model.modules.filter(item => item.parent === moduleId),
    connections: model.connections.filter(link => link.scope === moduleId || link.from.moduleId === moduleId || link.to.moduleId === moduleId).flatMap(link=>index===undefined?[link]:expandLink(model,link,{moduleId,index})),
    requirements: model.specification?.requirements.filter(item => item.moduleIds.includes(moduleId)) ?? [],
    decisions: model.specification?.decisions.filter(item => item.moduleIds.includes(moduleId)) ?? [],
    ...(model.provenance ? { provenance: provenanceForModule(model, moduleId) } : {}),
  };
}
const cell = (value: unknown) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', '<br>');
const table = (head: string[], rows: unknown[][]) => [head.map(cell).join(' | '), head.map(() => '---').join(' | '), ...rows.map(row => row.map(cell).join(' | '))].join('\n');
export function provenanceMarkdown(model: Model, moduleId?: string): string {
  const p = moduleId ? provenanceForModule(model, moduleId) : model.provenance; if (!p) return '';
  return ['## 来源与覆盖', '', `${p.origin==='as_built'?'根据现有 RTL 还原':'设计方案'} · ${p.fidelity==='partial'?'尚未完整':'声明已完整，仍需核对依据'}`, `范围：${p.scope}`, `配置：${p.configuration}`, `输入摘要：\`${p.sourceDigest}\``, `展开实例：${p.coverage.elaboratedInstances ?? '未核对'} · 已表示实例：${p.coverage.representedInstances} · 展开模型实例：${physicalInstanceCount(model)} · 定义节点：${model.modules.length} · 连接：${model.connections.length}`, '', '> 实例数量吻合不代表连线和行为已经核对完整。下列缺口会阻止实现交接。', '', '### 未表达结构', table(['ID', '类型', '关联模块', '限制', '证据'], p.unsupportedStructures.map(i => [i.id, i.kind, i.moduleIds.join(', '), i.description, i.evidenceIds.join(', ')])), '', '### 事实、推断与冲突', table(['ID', '分类', '发现', '证据'], p.findings.map(i => [i.id, i.classification, i.text, i.evidenceIds.join(', ')])), '', '### 实际验证记录', table(['目标 / 批次', '阶段', '结果', '执行时间', '输入摘要 / 工具', '命令', '说明', '证据'], p.verification.map(v => [`${v.target??'未记录'} / ${v.batchId??'未记录'}`,v.stage,v.status,v.executedAt??'未记录',`${v.sourceDigest??'未记录'} / ${v.tool?`${v.tool.name} ${v.tool.version}`:'未记录'}`,v.command,v.detail,v.evidenceIds.join(', ')])), '', '### 源码与结果证据', table(['ID', '来源', '位置 / 符号', 'SHA-256'], p.evidence.map(e => [e.id, e.sourceKind, `${e.file}${e.line ? `:${e.line}${e.endLine ? `-${e.endLine}` : ''}` : ''}${e.symbol ? ` · ${e.symbol}` : ''}`, e.fileHash])), ''].join('\n');
}
export function specMarkdown(model: Model, hash: string, status: ReviewStatus, issues: Issue[], moduleId?: string, index?:number): string {
  const modules = moduleId ? [moduleDocument(model, moduleId,index).module] : hierarchyOrder(model);
  const lines = [`# ${model.design.name}${moduleId ? ` / ${moduleId}` : ''}`, '', `模型版本：\`${hash}\` · ${{DRAFT:'草稿',APPROVED:'已批准',STALE:'修改后需复核'}[status]}`, '', model.specification?.summary || model.modules.find(m => m.id === model.design.top)!.contract.responsibility, '', '> 本文与框图由同一 IR 生成；布局不参与合同。结构检查不构成 RTL 一致性、CDC/RDC 或形式证明。', '', '## 设计需求', '', table(['ID', '需求', '关联模块', '验收条件'], (model.specification?.requirements ?? []).filter(r => !moduleId || r.moduleIds.includes(moduleId)).map(r => [r.id, r.text, r.moduleIds.join(', '), r.acceptance])), '', '## 设计决策', '', ...(model.specification?.decisions ?? []).filter(d => !moduleId || d.moduleIds.includes(moduleId)).flatMap(d => [`### ${d.id} — ${d.text}`, d.rationale, `关联：${d.moduleIds.join(', ')}`, ''])];
  if (model.provenance) {
    const coverage=coverageReport(model);
    lines.push('## 这份模型覆盖到哪里', '', `实例路径：模型表示 ${coverage.instances.represented}，源码记录 ${coverage.instances.expected??'未知'}。`, `连线：当前模型已记录 ${coverage.portBits.covered} / ${coverage.portBits.declared} 个端口位的连接，仍有 ${coverage.portBits.missingRequiredPorts} 个必连端口待补；源码端口位总数${coverage.portBits.expected??'未知'}。`, `局部驱动 ${coverage.localDrivers.modeled} 项；显式参数绑定 ${coverage.parameterBindings.modeled} 项；行为证据 ${coverage.behavior.evidence} 项。数量只描述已记录内容，不表示已经覆盖全部 RTL。`, '');

  }
  for (const module of modules) {
    const doc = moduleDocument(model, module.id,moduleId?index:undefined), c = module.contract;
    lines.push(`## ${module.name} · ${module.id}`, '');
    if(doc.instance&&index!==undefined)lines.push(`当前元素：${doc.instance.sourcePath} · ${JSON.stringify(doc.instance.parameters)}`);
    if(module.instances)lines.push(`数组 ${module.id}: ${module.instances.indexVariable}=${module.instances.from}..${module.instances.to}，${instanceCount(module)} 实例，共享合同；路径 ${module.instances.sourcePath}。`);
    if(module.parameterBindings)lines.push('参数求值：',table(['参数','声明默认值','表达式/作用域','当前值','传播到'],doc.parameterReport.map(p=>[p.key,p.declared,p.binding?bindingText(p.binding):'—',p.error??p.value,p.propagatesTo.join(', ')])));
    if(module.resetControlInputs?.length)lines.push(`复位作为控制输入（不代表状态复位）：${module.resetControlInputs.join(', ')}`);
    if(doc.localSignals.length)lines.push('局部信号（非 RTL 子模块）：',table(['ID','位宽','驱动','说明'],doc.localSignals.map(n=>[n.id,JSON.stringify(n.width),n.driver.kind==='comb'?signalText(n.driver.value):n.driver.sourceText,n.description])));
    for(const local of doc.localSignals){const state=stateDescription(local);if(state)lines.push(`状态 ${local.name} · ${state.pattern}`,state.note,table(['优先级','条件（沿前）','写入值（沿后）'],state.rows.map((r,i)=>[i+1,r.condition,r.action])));}
    lines.push(`类型：${module.kind} · 父层级：${module.parent ?? '顶层'} · RTL：${module.rtlModule}`, timingDescription(model, module), '', '### 职责', c.responsibility, '', '### 行为合同', `最小延迟：${c.latencyMinCycles} 周期。${c.latencyCondition}`, `背压：${c.backpressure}`, `复位：${c.resetBehavior}`, '', '不变量：', ...c.invariants.map(s => `- ${s}`), '', '验证计划：', ...c.verificationPlan.map(s => `- ${s}`), ...(c.obligations?.length?['','可执行验证义务（声明不等于通过）：',...c.obligations.map(o=>`- ${o.id} · ${o.description}（${o.kind}）`)]:[]), '', '未决问题：', ...(c.openQuestions.length ? c.openQuestions.map(s => `- ${s}`) : ['无']), '', '### 参数', table(['参数', '值'], Object.entries(module.parameters)), '', '### 逻辑接口', table(['接口', '角色', '协议', '解析宽度', '必连'], doc.interfaces.map(i => [i.id, i.role, i.protocol, i.resolvedWidth, i.required ? '是' : '否'])), '', '### 邻接及内部连接', table(['ID', 'scope', '来源', '目标'], doc.connections.map(l => [l.id, l.scope, endpointLabel(l.from), endpointLabel(l.to)])), '');
  }
  lines.push('## 设计未决问题', ...(model.specification?.openQuestions ?? []).map(q => `- ${q}`), '', '## 校验问题', ...(issues.length ? diagnosticGroups(model,issues).flatMap(group=>[`- ${group.label}：${group.count} 项`,...group.items.map(item=>`  - ${item.moduleId}${item.interfaceId?'.'+item.interfaceId:''}${item.indexLabel?'，索引 '+item.indexLabel:''}：${item.issues.length} 项（${[...new Set(item.issues.map(i=>i.code))].join(', ')}）`)]) : ['无结构校验问题。']), '');
  if(model.provenance)lines.push(provenanceMarkdown(model,moduleId));
  return lines.join('\n');
}
