import {connectionFacts} from './connectivity';
import { commandSchema, modelSchema, type Command, type Endpoint, type Interface, type Issue, type Link, type Model, type Module } from './schema';
import { createTemplate } from './templates';
import { widthValue, parameterValue, instanceCount } from './parameters';
import { expandLink } from './signals';
import { provenanceIssues, attachIssueEvidence } from './provenance';
export class EngineError extends Error {
  constructor(public issues: Issue[]) { super(issues.filter(i=>i.blocks.includes('commit')).slice(0,5).map(i=>i.message).join('；')+`（共 ${issues.length} 项检查结果，详见 issues）`); }
}
const issue = (code: string, target: string, message: string, draft = false): Issue => ({ code, target, message, severity: draft ? 'warning' : 'error', blocks: draft ? ['review'] : ['commit', 'review'] });
export { childrenOf,resolveWidth,resolveEndpoint,scopeEndpoints } from './endpoints';
import { childrenOf,resolveWidth,resolveEndpoint,scopeEndpoints,endpointKey } from './endpoints';
export function validateModel(input: unknown): Issue[] {
  const parsed = modelSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map(i => issue('SCHEMA', i.path.join('.'), i.message));
  const model = parsed.data, issues: Issue[] = [];
  const add = (code: string, target: string, message: string, draft = false) => issues.push(issue(code, target, message, draft));
  function unique(items: { id: string }[], target: string) {
    const seen = new Set<string>();
    for (const item of items) { if (seen.has(item.id)) add('DUPLICATE_ID', target, `重复 ID: ${item.id}`); seen.add(item.id); }
  }
  unique(model.modules, 'modules'); unique(model.connections, 'connections'); unique(model.clocks, 'clocks'); unique(model.resets, 'resets');
  const byId = new Map(model.modules.map(m => [m.id, m]));
  const extended = model.modules.some(m=>m.contract.obligations!==undefined) || model.connections.some(l=>[l.from,l.to].some(e=>e.index!==undefined||e.local||e.slice||e.sliceMapping)) || !!model.provenance || !!model.localSignals || model.modules.some(m=>m.interfaceGroups||m.instances||m.parameterBindings||m.resetControlInputs||m.interfaces.some(i=>i.group||typeof i.width==='object'&&'expr' in i.width)) || model.modules.some(m => m.clock === null || m.reset === null || m.timing !== undefined) || model.clocks.some(c => c.edge !== 'rising') || model.resets.some(r => !r.synchronous || r.activeLevel !== 'low' || r.clock === null || r.deassertion !== undefined);
  if (extended && model.schemaVersion < 3) add('SCHEMA_VERSION', 'schemaVersion', '来源、扩展时钟/复位和时序分类需 schemaVersion 3');
  issues.push(...provenanceIssues(model));
  const roots = model.modules.filter(m => m.parent === null);
  if (roots.length !== 1 || roots[0]?.id !== model.design.top || roots[0]?.kind !== 'subsystem') add('ROOT', 'design.top', '顶层必须是唯一无 parent 的 subsystem');
  for (const r of model.resets) {
    if (r.clock !== null && !model.clocks.some(c => c.id === r.clock)) add('REFERENCE', r.id, '复位引用不存在的时钟');
    if (r.clock === null && r.synchronous) add('DOMAIN', r.id, '同步复位必须关联时钟');
    if (!r.synchronous && (!r.deassertion || r.deassertion === 'unknown')) add('RESET_RELEASE_UNKNOWN', 'provenance', `异步复位 ${r.id} 的释放方式待确认`, true);
  }
  for (const m of model.modules) {
    unique(m.interfaces, m.id);unique(m.interfaceGroups??[],m.id+'.interfaceGroups');
    if(m.instances){
      if(m.kind==='subsystem'||m.parent===null||instanceCount(m)<1||instanceCount(m)>4096)add('INSTANCE_ARRAY',m.id,'当前数组仅支持1..4096个叶模块实例');
      if(!m.instances.sourcePath.includes('{'+m.instances.indexVariable+'}'))add('INSTANCE_PATH',m.id,'数组源码路径需包含索引占位符');
      if(Object.hasOwn(m.parameters,m.instances.indexVariable))add('INSTANCE_INDEX',m.id,'索引变量不能与参数同名');
      for(const [index,overrides] of Object.entries(m.instances.overrides??{}))if(Number(index)<m.instances.from||Number(index)>m.instances.to||Object.keys(overrides).some(k=>!Object.hasOwn(m.parameters,k)))add('INSTANCE_OVERRIDE',m.id,'数组覆盖索引或参数不存在');
    }
    for(const key of Object.keys(m.parameterBindings??{}))if(!Object.hasOwn(m.parameters,key))add('PARAMETER_BINDING',m.id,'参数绑定必须有声明默认值');
    try{const indexes=m.instances&&instanceCount(m)>0&&instanceCount(m)<=4096?Array.from({length:instanceCount(m)},(_,i)=>m.instances!.from+i):[undefined];for(const index of indexes)for(const key of Object.keys(m.parameters))parameterValue(model,m,key,index)}catch(e){add('PARAMETER_BINDING',m.id,String(e))}
    for(const id of m.resetControlInputs??[])if(!m.interfaces.some(i=>i.id===id&&i.role==='consumer'&&i.protocol==='signal'))add('RESET_CONTROL_INPUT',m.id,'复位门控输入必须引用真实 signal 输入端口');

    unique(m.contract.obligations??[],m.id+'.contract.obligations');
    for(const obligation of m.contract.obligations??[]){
      const target=m.id+'.contract.obligations.'+obligation.id;
      for(const req of obligation.requirementIds??[])if(!model.specification?.requirements.some(r=>r.id===req&&(!r.moduleIds.length||r.moduleIds.includes(m.id))))add('OBLIGATION_REQUIREMENT',target,'验证义务需引用适用于本模块的真实需求');
      if(obligation.kind==='state_transition'){
        const local=model.localSignals?.find(l=>l.id===obligation.localSignalId&&l.scope===m.id);
        if(!local||local.driver.kind!=='register'||!local.driver.update)add('OBLIGATION_STATE',target,'状态更新义务须引用本作用域具有明确更新规则的寄存状态');
        const branches=local?.driver.kind==='register'?local.driver.update?.branches:undefined,pairs=new Set<string>();
        for(const p of obligation.priorityPairs??[]){
          const hi=branches?.findIndex(b=>b.id===p.higher)??-1,lo=branches?.findIndex(b=>b.id===p.lower)??-1,key=p.higher+'/'+p.lower;
          if(hi<0||lo<=hi||pairs.has(key))add('OBLIGATION_PRIORITY',target,'优先级覆盖需引用按声明顺序排列的两个不同分支，且不能重复');
          pairs.add(key);
        }
        if(!m.clock)add('OBLIGATION_DOMAIN',target,'状态更新义务需要明确时钟');
        continue;
      }
      const output=m.interfaces.find(p=>p.id===(obligation.kind==='fifo_ordering'?obligation.outputInterfaceId:obligation.interfaceId));
      if(!output||output.protocol!=='rv'||output.role!=='producer')add('OBLIGATION_INTERFACE',target,'这些行为模板要求模块的 ready/valid 输出接口');
      if(obligation.kind==='fifo_ordering'){
        const input=m.interfaces.find(p=>p.id===obligation.inputInterfaceId);
        if(!input||!output||input.protocol!=='rv'||input.role!=='consumer'||resolveWidth(m,input,model)!==resolveWidth(m,output!,model))add('OBLIGATION_INTERFACE',target,'FIFO 顺序义务要求同宽的 ready/valid 输入与输出');
        try{widthValue(model,m,obligation.capacity);}catch{add('OBLIGATION_CAPACITY',target,'容量必须能够按显式参数绑定求值');}
      }
      if(!m.clock||!m.reset)add('OBLIGATION_DOMAIN',target,'当前行为模板要求明确的时钟及复位域');
    }
    if (['fifo', 'add_const'].includes(m.kind) && (m.interfaces.length !== 2 || !['in', 'out'].every(id => m.interfaces.some(i => i.id === id)))) add('INTERFACES', m.id, 'MVP 接口固定为 in/out');
    if (m.parent !== null && (!byId.has(m.parent) || byId.get(m.parent)?.kind !== 'subsystem')) add('PARENT', m.id, 'parent 必须引用 subsystem');
    const seen = new Set<string>(); let current: Module | undefined = m;
    while (current && current.parent !== null) {
      if (seen.has(current.id)) { add('HIERARCHY_CYCLE', m.id, '层级存在环'); break; }
      seen.add(current.id); current = byId.get(current.parent);
    }
    if (!current || current.id !== model.design.top) add('UNREACHABLE', m.id, '实例无法从顶层到达');
    const reset = model.resets.find(r => r.id === m.reset);
    if ((m.clock !== null && !model.clocks.some(c => c.id === m.clock)) || (m.reset !== null && (!reset || (reset.clock !== null && reset.clock !== m.clock)))) add('DOMAIN', m.id, '时钟/复位声明或绑定不一致');
    if (m.clock === null && !m.timing) add('TIMING_REQUIRED', m.id, '无时钟模块需明确 combinational 或 unknown 等时序分类');
    if (m.timing === 'combinational' && (m.clock !== null || m.reset !== null)) add('DOMAIN', m.id, '纯组合模块不能绑定时钟或复位');
    if (m.timing === 'sequential' && m.clock === null) add('DOMAIN', m.id, '时序模块需绑定时钟');
    if (m.timing === 'unknown') add('TIMING_UNKNOWN', m.id, '模块时序/复位语义待确认', true);
    if (['fifo', 'add_const'].includes(m.kind) && (!m.clock || !reset || !reset.synchronous || reset.activeLevel !== 'low' || model.clocks.find(c => c.id === m.clock)?.edge !== 'rising')) add('TEMPLATE_DOMAIN', m.id, '示例模板要求上升沿时钟与同步低有效复位');
    if (['fifo', 'add_const'].includes(m.kind)) {
      if(m.instances||Object.keys(m.parameterBindings??{}).length)add('TEMPLATE_PARAMETER',m.id,'示例模板不支持数组/表达式绑定；通用 RTL 请用 module/compute/memory');
      const keys = m.kind === 'fifo' ? ['DATA_W', 'DEPTH'] : ['DATA_W', 'CONST'];
      if (Object.keys(m.parameters).length !== keys.length || keys.some(k => !Object.hasOwn(m.parameters, k))) add('PARAMETER', m.id, `示例叶模块参数必须为 ${keys.join(', ')}`);
      const w = m.parameters.DATA_W;
      if (typeof w !== 'number' || w < 1 || w > 32) add('PARAMETER', m.id, '示例叶模块 DATA_W 必须为 1..32');
      if (m.kind === 'fifo' && ![2, 4, 8, 16].includes(Number(m.parameters.DEPTH))) add('PARAMETER', m.id, 'DEPTH 必须为 2/4/8/16');
      if (m.kind === 'fifo' && typeof m.parameters.DEPTH !== 'number') add('PARAMETER', m.id, 'DEPTH 必须为整数');
      if (m.kind === 'add_const' && (typeof m.parameters.CONST !== 'number' || typeof w !== 'number' || !(m.parameters.CONST >= 0 && m.parameters.CONST < 2 ** w))) add('PARAMETER', m.id, 'CONST 超出 DATA_W 范围');
    }
    for (const i of m.interfaces) {
      const indexes=m.instances&&instanceCount(m)>0&&instanceCount(m)<=4096?Array.from({length:instanceCount(m)},(_,j)=>m.instances!.from+j):[undefined];
      if (indexes.some(index=>resolveWidth(m,i,model,index)===undefined)) add('WIDTH_REFERENCE', `${m.id}.${i.id}`, '接口宽度引用未知参数或超出 1..65536');
    }
    const c = m.contract;
    if ([c.responsibility, c.latencyCondition, c.backpressure, c.resetBehavior].some(s => !s.trim()) || [c.invariants, c.verificationPlan].some(a => !a.length || a.some(s => !s.trim()))) add('CONTRACT_INCOMPLETE', m.id, '合同缺少必要描述', true);
    if (c.openQuestions.length) add('OPEN_QUESTIONS', m.id, '合同仍有未解决问题', true);
  }
  if (model.specification) {
    const spec = model.specification;
    unique(spec.requirements, 'requirements'); unique(spec.decisions, 'decisions');
    for (const item of [...spec.requirements, ...spec.decisions]) {
      if (item.moduleIds.some(id => !byId.has(id))) add('SPEC_REFERENCE', item.id, '需求/决策引用不存在的模块');
    }
    if (!spec.summary.trim()) add('SPEC_INCOMPLETE', model.design.top, '设计概述未填写', true);
    for (const req of spec.requirements) if (!req.acceptance.trim()) for (const moduleId of req.moduleIds) add('ACCEPTANCE_MISSING', moduleId, `需求 ${req.id} 缺少验收条件`, true);
    if (spec.openQuestions.length) add('DESIGN_OPEN_QUESTIONS', model.design.top, '设计存在未决问题', true);
  }
  const facts=connectionFacts(model),pairs=new Set<string>();
  for(const e of facts.errors)add(e.kind==='array'?'ARRAY_CONNECTION':'LOCAL_DRIVER',e.id,e.message);
  for(const l of facts.links){
      const from = resolveEndpoint(model, l.scope, l.from), to = resolveEndpoint(model, l.scope, l.to);
      if (!from || !to) { add('SCOPE_REFERENCE', l.id, '端点/位域必须有效且属于当前 scope 或直属子模块；禁止跨层直连'); continue; }
      if([l.from,l.to].some(e=>model.modules.find(m=>m.id===e.moduleId)?.instances&&e.index===undefined))add('ARRAY_INDEX_REQUIRED',l.id,'数组连接需明确 index 或 all');
      if (from.direction !== 'source' || to.direction !== 'target') add('DIRECTION', l.id, '连接必须从 source 到 target（边界方向在 scope 内反转）');
      if (from.intf.protocol !== to.intf.protocol) add('PROTOCOL', l.id, '协议不匹配');
      if (from.width !== to.width) add('WIDTH_MISMATCH', l.id, '解析后接口位宽不匹配');
      if (from.intf.protocol === 'rv' ? from.module.clock !== to.module.clock || from.module.reset !== to.module.reset : from.module.clock !== null && to.module.clock !== null && from.module.clock !== to.module.clock) add('DOMAIN_MISMATCH', l.id, '端点时钟域不匹配（rv 还要求同一复位）；不支持 CDC');
      const pair = JSON.stringify([l.scope,l.from,l.to]);
      if (pairs.has(pair)) add('DUPLICATE_LINK', l.id, '重复连接'); pairs.add(pair);
  }
  unique(model.localSignals??[], 'localSignals');
  for(const local of model.localSignals??[]){
    const scope=byId.get(local.scope);
    if(!scope||scope.kind!=='subsystem'){add('LOCAL_SCOPE',local.id,'局部信号必须属于 subsystem');continue}
    if(local.driver.kind==='register'&&!scope.clock)add('LOCAL_CLOCK',local.id,'寄存驱动需要作用域时钟');
    if(local.evidenceIds.some(id=>!model.provenance?.evidence.some(e=>e.id===id)))add('EVIDENCE_REFERENCE',local.id,'局部信号证据不存在');
  }
  for(const port of facts.ports){
    const {endpoint:e,scope,overlap,missing,direction,intf}=port;
    const location={scope,moduleId:e.moduleId,interfaceId:e.interfaceId,...(typeof e.index==='number'?{index:e.index}:{})};
    if(overlap&&(direction==='target'||intf.protocol==='rv'))issues.push({...issue(direction==='source'?'FANOUT':'MULTI_DRIVER',port.key,'接收端位域不能重叠驱动；rv 发送端只允许一个接收端'),location});
    if(missing.length&&intf.required)issues.push({...issue('REQUIRED_UNCONNECTED',port.key,'模型尚未记录这些位域的连接；需核对导入范围',true),location:{...location,bits:missing}});
  }
  for (const scope of model.modules.filter(m => m.kind === 'subsystem')) {
    const adjacency = new Map(childrenOf(model, scope.id).map(m => [m.id, [] as string[]]));
    for (const l of facts.links.filter(l => l.scope === scope.id && resolveEndpoint(model, l.scope, l.from)?.intf.protocol === 'rv')) if (adjacency.has(l.from.moduleId) && adjacency.has(l.to.moduleId)) adjacency.get(l.from.moduleId)!.push(l.to.moduleId);
    const visiting = new Set<string>(), visited = new Set<string>();
    function cycle(id: string): boolean { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const next of adjacency.get(id) ?? []) if (cycle(next)) return true; visiting.delete(id); visited.add(id); return false; }
    if ([...adjacency.keys()].some(cycle)) add('MODULE_CYCLE', scope.id, '当前工具不支持 rv 事务环；这不是 RTL 组合环诊断');
  }
  return attachIssueEvidence(model,issues);
}
export function applyCommands(original: Model, inputs: Command[] | unknown): { model: Model; issues: Issue[] } {
  const parsed = commandSchema.array().safeParse(inputs);
  if (!parsed.success) throw new EngineError([issue('COMMAND_SCHEMA', 'commands', parsed.error.message)]);
  let model = structuredClone(original);
  const fail = (message: string): never => { throw new EngineError([issue('PRECONDITION', 'commands', message)]); };
  const get = (id: string) => model.modules.find(m => m.id === id) ?? fail(`实例不存在: ${id}`);
  for (const c of parsed.data) {
    switch (c.op) {
      case 'set_parameter': { const m = get(c.moduleId); if(m.parameterBindings?.[c.key])fail('参数由表达式绑定，需先修改/移除绑定'); if (['fifo', 'add_const'].includes(m.kind) && !Object.hasOwn(m.parameters, c.key)) fail(`未知示例参数: ${c.key}`); m.parameters[c.key] = c.value; break; }
      case 'set_parameter_binding': {const m=get(c.moduleId);if(!Object.hasOwn(m.parameters,c.key))fail('参数未声明');if(c.binding)(m.parameterBindings??={})[c.key]=structuredClone(c.binding);else if(m.parameterBindings)delete m.parameterBindings[c.key];model.schemaVersion=3;break;}
      case 'update_instance_array': {const m=get(c.moduleId);if(c.instances)m.instances=structuredClone(c.instances);else delete m.instances;model.schemaVersion=3;break;}
      case 'set_instance_parameter': {const m=get(c.moduleId);if(!m.instances||c.index<m.instances.from||c.index>m.instances.to||!Object.hasOwn(m.parameters,c.key))fail('数组索引或参数无效');const array=m.instances!;((array.overrides??={})[String(c.index)]??={})[c.key]=c.value;break;}
      case 'update_local_signals': model.localSignals=structuredClone(c.localSignals);model.schemaVersion=3;break;
      case 'replace_architecture': model = structuredClone(c.model); break;
      case 'update_specification': model.specification = structuredClone(c.specification); model.schemaVersion = Math.max(2, model.schemaVersion) as Model['schemaVersion']; break;
      case 'update_provenance': model.provenance = structuredClone(c.provenance); model.schemaVersion = 3; break;
      case 'update_domains': model.clocks = structuredClone(c.clocks); model.resets = structuredClone(c.resets); model.schemaVersion = 3; break;
      case 'update_module_timing': { const m = get(c.moduleId); m.clock = c.clock; m.reset = c.reset; m.timing = c.timing; model.schemaVersion = 3; break; }
      case 'update_interface_groups': get(c.moduleId).interfaceGroups=structuredClone(c.groups);model.schemaVersion=3;break;
      case 'update_interfaces': get(c.moduleId).interfaces = structuredClone(c.interfaces); if(c.interfaces.some(i=>i.group||typeof i.width==='object'&&'expr'in i.width))model.schemaVersion=3;break;
      case 'define_module': if (model.modules.some(m => m.id === c.module.id)) fail('实例 ID 已存在'); model.modules.push(structuredClone(c.module)); model.schemaVersion = Math.max(c.module.interfaceGroups || c.module.instances || c.module.parameterBindings || c.module.resetControlInputs || c.module.interfaces.some(i=>i.group||typeof i.width==='object'&&'expr'in i.width) || c.module.timing !== undefined || c.module.clock === null || c.module.reset === null ? 3 : 2, model.schemaVersion) as Model['schemaVersion']; break;
      case 'rename_module': get(c.moduleId).name = c.name; break;
      case 'update_contract': get(c.moduleId).contract = structuredClone(c.contract); break;
      case 'create_module': {
        if (model.modules.some(m => m.id === c.id)) fail(`实例已存在: ${c.id}`);
        const parent = get(c.parent); if (parent.kind !== 'subsystem') fail('只能在 subsystem 内新增叶模块');
        const m = createTemplate(c.id, c.parent, c.template); m.clock = parent.clock; m.reset = parent.reset; if (parent.clock === null) m.timing = parent.timing === 'combinational' ? 'combinational' : 'unknown'; model.modules.push(m); break;
      }
      case 'delete_module': {
        if (get(c.moduleId).parent === null || childrenOf(model, c.moduleId).length) fail('只能删除叶模块或空子系统；顶层不可删除');
        model.modules = model.modules.filter(m => m.id !== c.moduleId);
        model.connections = model.connections.filter(l => l.from.moduleId !== c.moduleId && l.to.moduleId !== c.moduleId); break;
      }
      case 'connect': if (model.connections.some(l => l.id === c.connection.id)) fail('连接 ID 已存在'); model.connections.push(structuredClone(c.connection));if([c.connection.from,c.connection.to].some(e=>e.index!==undefined||e.local||e.slice||e.sliceMapping))model.schemaVersion=3;break;
      case 'disconnect': if (!model.connections.some(l => l.id === c.connectionId)) fail('连接不存在'); model.connections = model.connections.filter(l => l.id !== c.connectionId); break;
    }
  }
  const issues = validateModel(model);
  if (issues.some(i => i.blocks.includes('commit'))) throw new EngineError(issues);
  return { model, issues };
}
export function connectionIssues(model: Model, connection: Link, replaceId?: string): Issue[] {
  try { applyCommands(model, [...(replaceId ? [{ op: 'disconnect' as const, connectionId: replaceId }] : []), { op: 'connect', connection }]); return []; }
  catch (error) { return error instanceof EngineError ? error.issues.filter(i => i.blocks.includes('commit')) : [issue('CONNECTION', connection.id, String(error))]; }
}
