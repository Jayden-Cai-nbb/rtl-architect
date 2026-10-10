import {issueLocation} from './diagnostics';
import { physicalInstanceCount } from './parameters';
import type { Issue, Model } from './schema';

// Evidence is declared data, not a proof that source files or simulations match it.
export function provenanceIssues(model: Model): Issue[] {
  const p = model.provenance; if (!p) return [];
  const issues: Issue[] = [];
  const add = (code: string, message: string, error = false, target = 'provenance') => issues.push({ code, target, message, severity: error ? 'error' : 'warning', blocks: error ? ['commit', 'review'] : ['review'] });
  if (p.origin === 'as_built') add('AS_BUILT_READ_ONLY', '现状还原仅供审阅和保存草稿；转为实现设计须另提方案并审阅');
  if (p.fidelity === 'partial') add('PARTIAL_MODEL', '架构为不完整投影，不能批准或导出实现合同');
  const c = p.coverage;
  if (c.elaboratedInstances === null || c.representedInstances < c.elaboratedInstances || c.representedInstances !== physicalInstanceCount(model)) add('INCOMPLETE_COVERAGE', '实例覆盖未完整核对；请核对数组展开计数和未表示实例');
  if (c.elaboratedInstances !== null && c.representedInstances > c.elaboratedInstances) add('COVERAGE_INVALID', '已表示实例数大于展开实例数', true);
  for (const collection of [p.evidence, p.findings, p.unsupportedStructures]) {
    if (new Set(collection.map(e => e.id)).size !== collection.length) add('EVIDENCE_REFERENCE', '证据、发现或表达限制存在重复 ID', true);
  }
  const evidenceIds = new Set(p.evidence.map(e => e.id)), moduleIds = new Set(model.modules.map(m => m.id));
  for(const item of [...p.evidence,...p.unsupportedStructures])for(const target of item.targets??[]){
    const m=model.modules.find(m=>m.id===target.moduleId);
    const valid=target.kind==='connection'?!!model.connections.find(l=>l.id===target.itemId&&(!target.moduleId||l.scope===target.moduleId)):target.kind==='local'?!!model.localSignals?.find(l=>l.id===target.itemId&&(!target.moduleId||l.scope===target.moduleId)):!!m&&(target.kind==='module'||target.kind==='contract'||target.kind==='parameter'&&!!target.itemId&&Object.hasOwn(m.parameters,target.itemId)||target.kind==='interface'&&m.interfaces.some(i=>i.id===target.itemId));
    if(!valid)add('EVIDENCE_REFERENCE',`${item.id} 关联目标不存在`,true);
  }
  for(const [dimension,a] of Object.entries(p.coverage.assessments??{})){
    if(a.status!=='complete'||a.expected===null)add('COVERAGE_DIMENSION',`${dimension}: ${a.detail}`);
    if(a.evidenceIds.some(id=>!evidenceIds.has(id)))add('EVIDENCE_REFERENCE',`${dimension} 覆盖证据不存在`,true);
    if(a.status==='complete'&&!a.evidenceIds.length)add('EVIDENCE_MISSING',`${dimension} 声明已覆盖，但缺少依据`);
  }
  for(const item of p.unsupportedStructures)for(const rule of item.causes??[]){
    const m=model.modules.find(m=>m.id===rule.moduleId);
    if(!m||(rule.interfaceId&&!m.interfaces.some(i=>i.id===rule.interfaceId))||(rule.scope&&!model.modules.some(m=>m.id===rule.scope&&m.kind==='subsystem'))||(rule.indices&&(!m.instances||rule.indices.from<m.instances.from||rule.indices.to>m.instances.to||rule.indices.from>rule.indices.to))||(rule.bits&&rule.bits.lsb>rule.bits.msb))add('EVIDENCE_REFERENCE',`${item.id} 诊断归因范围无效`,true);
  }
  for (const e of p.evidence) if (e.endLine !== undefined && (e.line === undefined || e.endLine < e.line)) add('EVIDENCE_REFERENCE', `证据 ${e.id} 行范围无效`, true);
  for (const item of [...p.findings, ...p.unsupportedStructures, ...p.verification]) {
    if (item.evidenceIds.some(id => !evidenceIds.has(id)) || ('moduleIds' in item && item.moduleIds.some(id => !moduleIds.has(id)))) add('EVIDENCE_REFERENCE', '来源引用或关联模块不存在', true);
  }
  for (const item of p.findings) {
    if (['fact', 'conflict'].includes(item.classification) && !item.evidenceIds.length) add('EVIDENCE_MISSING', `发现 ${item.id} 缺少源码或结果证据`);
    if (['unknown', 'conflict'].includes(item.classification)) {
      for (const target of item.moduleIds.length ? item.moduleIds : ['provenance']) add('SOURCE_UNRESOLVED', `${item.id}: ${item.text}`, false, target);
    }
  }
  for (const item of p.unsupportedStructures) add('UNSUPPORTED_STRUCTURE', `${item.kind}: ${item.description}`);
  for (const v of p.verification) if (['passed', 'failed'].includes(v.status) && (!v.command.trim() || !v.evidenceIds.length)) add('VERIFICATION_EVIDENCE_MISSING', `${v.stage} 标记为 ${v.status}，但缺少执行命令或日志证据`);
  return issues;
}

export function attachIssueEvidence(model:Model,issues:Issue[]):Issue[]{
 const p=model.provenance;if(!p)return issues;
 return issues.map(issue=>{
  const location=issueLocation(issue),moduleId=location.moduleId;
  const matches=(t:NonNullable<Model['provenance']>['evidence'][number]['targets'] extends (infer T)[]|undefined?T:never)=>{
    if(t.kind==='module'||t.kind==='contract')return t.moduleId===moduleId;
    if(t.kind==='interface')return t.moduleId===moduleId&&(issue.target===`${moduleId}.${t.itemId}`||issue.target.split('/')[2]?.replace(/\[.*$/,'')===t.itemId);
    if(t.kind==='parameter')return t.moduleId===moduleId&&issue.code.includes('PARAMETER');
    return t.itemId===issue.target;
  };
  const causes=p.unsupportedStructures.filter(u=>issue.code==='UNSUPPORTED_STRUCTURE'?issue.message===`${u.kind}: ${u.description}`:u.causes?.some(rule=>rule.issueCodes.includes(issue.code)&&rule.moduleId===moduleId&&(!rule.interfaceId||rule.interfaceId===location.interfaceId)&&(!rule.scope||rule.scope===location.scope)&&(!rule.indices||location.index!==undefined&&location.index>=rule.indices.from&&location.index<=rule.indices.to)&&(!rule.bits||!!location.bits?.length&&location.bits.every(b=>b.lsb>=rule.bits!.lsb&&b.msb<=rule.bits!.msb))));
  const evidenceIds=[...new Set([...causes.flatMap(u=>u.evidenceIds),...p.evidence.filter(e=>e.targets?.some(matches)).map(e=>e.id)])];
  return {...issue,...(causes.length?{causeIds:causes.map(u=>u.id)}:{}),...(evidenceIds.length?{evidenceIds}:{})};
 });
}

export function provenanceForModule(model: Model, moduleId: string) {
  const p = model.provenance; if (!p) return undefined;
  const related = (item: { moduleIds: string[] }) => !item.moduleIds.length || item.moduleIds.includes(moduleId);
  const findings = p.findings.filter(related), unsupportedStructures = p.unsupportedStructures.filter(related);
  const ids = new Set([...findings, ...unsupportedStructures, ...p.verification].flatMap(item => item.evidenceIds));
  return { ...p, findings, unsupportedStructures, evidence: p.evidence.filter(e => ids.has(e.id)||e.targets?.some(t=>t.moduleId===moduleId||t.kind==='connection'&&model.connections.some(l=>l.id===t.itemId&&(l.from.moduleId===moduleId||l.to.moduleId===moduleId)))) };
}
