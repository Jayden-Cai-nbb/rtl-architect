import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashValue } from '../src/core/export';
import { validateModel } from '../src/core/engine';
import { modelSchema, type Endpoint, type Model, type SignalValue, type StateUpdate, type StreamTransactionPath } from '../src/core/schema';
import { driverReads, stateUpdateReads } from '../src/core/signals';
import { stateInventory, type Definition } from '../src/core/stateObservation';
import { netlistSchema } from '../src/workspace/importYosys';

export type Configuration = {
  id: string;
  parameters: Record<string, number> & Record<'REG_TYPE' | 'DATA_WIDTH' | 'KEEP_ENABLE' | 'KEEP_WIDTH' | 'LAST_ENABLE' |
    'ID_ENABLE' | 'ID_WIDTH' | 'DEST_ENABLE' | 'DEST_WIDTH' | 'USER_ENABLE' | 'USER_WIDTH', number>;
};
type FrozenBenchmark = {
  repository: string;
  commit: string;
  top: string;
  files: Record<string, string>;
  seed: number;
  pytestFile: string;
  configurations: Configuration[];
  acceptance: { denominator: number; ports: number; registerVectors: number[]; readingTasks: string[]; requirements: Record<string, string> };
  fault: {
    case: string; file: string; line: number; before: string; after: string; assertion: string; test: string;
    requirement: string; moduleId: string; state: string; interface: string; bit: number;
  };
};
// Load an optional example only when running its benchmark. The isolated tool build need not copy it.
export const benchmarkRoot = fileURLToPath(new URL('../examples/external-axis/benchmark/', import.meta.url));
export const baseline = JSON.parse(readFileSync(join(benchmarkRoot, 'baseline.json'), 'utf8')) as FrozenBenchmark;
type Local = NonNullable<Model['localSignals']>[number];
const top = 'top';
const rtl = 'rtl/axis_register.v';
const payload = ['tdata', 'tkeep', 'tlast', 'tid', 'tdest', 'tuser'] as const;
const branchRange = [[261, 274], [197, 260], [91, 196]] as const;
const port = (interfaceId: string): Endpoint => ({ moduleId: top, interfaceId });
const local = (interfaceId: string): Endpoint => ({ ...port(interfaceId), local: true });
const read = (interfaceId: string, state = false): SignalValue => ({ kind: 'endpoint', endpoint: state ? local(interfaceId) : port(interfaceId) });
const constant = (width: number, value: number): SignalValue => ({ kind: 'constant', width, value: String(value) });
type Operator = Extract<SignalValue, { kind: 'operator' }>['operator'];
const op = (operator: Operator, ...operands: SignalValue[]): SignalValue => ({ kind: 'operator', operator, operands });
const unique = (endpoints: Endpoint[]) => [...new Map(endpoints.map(e => [e.interfaceId, e])).values()];

export function axisModel(config: Configuration, sourceHash: string, faultAsBuilt = false): Model {
  const p = config.parameters;
  const type = p.REG_TYPE;
  const description = [
    '组合旁路。负载和 valid 正向传递，ready 反向返回。',
    '单槽简单寄存器。输入就绪也被寄存，持续输入时两次接收之间有空拍。',
    '输出槽和临时槽构成 skid buffer。已给出 ready 时，受阻的新输入可进入临时槽。',
  ][type];
  const widths = {
    tdata: p.DATA_WIDTH, tkeep: p.KEEP_WIDTH, tlast: 1, tid: p.ID_WIDTH,
    tdest: p.DEST_WIDTH, tuser: p.USER_WIDTH, tvalid: 1, tready: 1,
  };
  const disabled = new Map<typeof payload[number], string>();
  if (!p.KEEP_ENABLE) disabled.set('tkeep', ((1n << BigInt(p.KEEP_WIDTH)) - 1n).toString());
  if (!p.LAST_ENABLE) disabled.set('tlast', '1');
  for (const [field, enabled] of [['tid', p.ID_ENABLE], ['tdest', p.DEST_ENABLE], ['tuser', p.USER_ENABLE]] as const) {
    if (!enabled) disabled.set(field, '0');
  }
  const interfaces: Model['modules'][number]['interfaces'] = [];
  const addPort = (id: string, width: number, input: boolean, group: string) => {
    interfaces.push({ id, width, protocol: 'signal', role: input ? 'consumer' : 'producer', required: true, group });
  };
  addPort('clk', 1, true, 'clock_reset');
  addPort('rst', 1, true, 'clock_reset');
  for (const [field, width] of Object.entries(widths)) {
    const control = field === 'tvalid' || field === 'tready';
    addPort(`s_axis_${field}`, width, field !== 'tready', control ? 'handshake' : 'ingress');
    addPort(`m_axis_${field}`, width, field === 'tready', control ? 'handshake' : 'egress');
  }
  const signals: Local[] = [];
  const connections: Model['connections'] = [];
  const connect = (output: string, signal: string) => {
    connections.push({ id: `drive_${output}`, scope: top, from: local(signal), to: port(output) });
  };
  const drive = (output: string, value: SignalValue, description: string) => {
    const id = `source_${output}`;
    signals.push({ id, scope: top, name: output + ' 来源', width: interfaces.find(i => i.id === output)!.width,
      description, driver: { kind: 'comb', value }, evidenceIds: ['rtl_branch'] });
    connect(output, id);
  };
  const reset: StateUpdate['reset'] = { signal: port('rst'), activeLevel: 'high', value: constant(1, 0) };
  const branch = (id: string, condition: SignalValue, value: SignalValue) => ({ id, condition, value });
  const register = (id: string, width: number, description: string, branches: StateUpdate['branches'], clear = false) => {
    const update: StateUpdate = { reset: clear ? reset : null, branches, otherwise: 'hold' };
    signals.push({
      id, scope: top, name: id, width, description, evidenceIds: ['rtl_branch'],
      driver: { kind: 'register', inputs: unique(stateUpdateReads(update)), update, sourceText: description },
    });
  };

  if (type === 0) {
    for (const field of [...payload, 'tvalid'] as const) {
      if (field !== 'tvalid' && disabled.has(field)) continue;
      drive(`m_axis_${field}`, read(`s_axis_${field}`), `${field} 由输入直接传至输出。`);
    }
    drive('s_axis_tready', read('m_axis_tready'), '下游 ready 直接返回输入端。');
  } else {
    const ready = read('s_axis_tready_reg', true);
    const sinkReady = read('m_axis_tready');
    const sourceValid = read('s_axis_tvalid');
    const outputValid = read('m_axis_tvalid_reg', true);
    const tempValid = read('temp_m_axis_tvalid_reg', true);
    const noOutput = op('!', outputValid);
    const toOutput = type === 1 ? ready : op('&&', ready, op('||', sinkReady, noOutput));
    const drain = op('&&', op('!', ready), sinkReady);
    const toTemp = op('&&', ready, op('&&', op('!', sinkReady), outputValid));
    const readyNext = type === 1
      ? op('!', op('mux', ready, sourceValid, op('mux', sinkReady, constant(1, 0), outputValid)))
      : op('||', sinkReady, op('&&', op('!', tempValid), op('||', noOutput, op('!', sourceValid))));
    register('s_axis_tready_reg', 1, type === 1 ? '下一拍仅在输出槽将为空时接收。' : '按下游 ready、槽位有效状态和当前输入 valid 提前计算 ready。',
      [branch('next_ready', constant(1, 1), readyNext)], true);
    register('m_axis_tvalid_reg', 1, '记录输出槽是否有有效数据。',
      [branch('load', toOutput, sourceValid), branch('drain', drain, type === 2 ? tempValid : constant(1, 0))], true);
    connect('s_axis_tready', 's_axis_tready_reg');
    connect('m_axis_tvalid', 'm_axis_tvalid_reg');
    if (type === 2) {
      register('temp_m_axis_tvalid_reg', 1, '临时槽接收已握手但暂不能进输出槽的数据。',
        [branch('load', toTemp, sourceValid), branch('drain', drain, constant(1, 0))], true);
    }
    for (const field of payload) {
      const width = widths[field];
      const source = read(`s_axis_${field}`);
      const id = `m_axis_${field}_reg`;
      const temp = `temp_${id}`;
      const fromInput = faultAsBuilt && id === baseline.fault.state ? op('^', source, constant(width, 1)) : source;
      const branches = [branch('load', toOutput, fromInput)];
      if (type === 2) branches.push(branch('move_temp', drain, read(temp, true)));
      register(id, width, `输出槽保存 ${field}。`, branches);
      if (type === 2) register(temp, width, `临时槽保存 ${field}。`, [branch('load', toTemp, source)]);
      if (!disabled.has(field)) connect(`m_axis_${field}`, id);
    }
  }
  for (const [field, value] of disabled) drive(`m_axis_${field}`, { kind: 'constant', width: widths[field], value }, `${field} 已禁用，输出固定为 ${value}。`);

  const fields = payload.map(pin => ({ id: pin.slice(1), width: widths[pin], input: `s_axis_${pin}`, output: `m_axis_${pin}`,
    ...(disabled.has(pin) ? { constant: disabled.get(pin) } : {}) }));
  const slot = (prefix: string) => ({ validState: `${prefix}m_axis_tvalid_reg`, loadInputBranch: 'load',
    fields: Object.fromEntries(fields.filter(f => f.constant === undefined).map(f => [f.id, `${prefix}${f.output}_reg`])) });
  const outputSlot = slot('');
  const pathBase = {
    schemaVersion: 2, id: 'stream', description, sampling: 'pre_edge_handshake_post_edge_settled', clock: { id: 'clk', edge: 'rising' },
    reset: { interfaceId: 'rst', activeLevel: 'high' }, ingress: { valid: 's_axis_tvalid', ready: 's_axis_tready' },
    egress: { valid: 'm_axis_tvalid', ready: 'm_axis_tready' }, fields, connectionIds: connections.map(c => c.id), evidenceIds: Array.of('rtl_branch'),
  } as const;
  const path: StreamTransactionPath = type === 0 ? { ...pathBase, semantics: 'combinational_bypass', resetPolicy: 'transparent' }
    : type === 1 ? { ...pathBase, semantics: 'registered_single_slot', resetPolicy: 'cancel_all', readyState: 's_axis_tready_reg', output: outputSlot }
      : { ...pathBase, semantics: 'registered_skid', resetPolicy: 'cancel_all', readyState: 's_axis_tready_reg',
        output: { ...outputSlot, loadTemporaryBranch: 'move_temp' }, temporary: slot('temp_') };

  const [line, endLine] = branchRange[type];
  const model = modelSchema.parse({
    schemaVersion: 3,
    design: { id: `axis_${p.DATA_WIDTH}_${type}`, name: `AXI Stream 寄存器 · ${p.DATA_WIDTH} 位 · REG_TYPE=${type}`, top },
    clocks: type ? [{ id: 'clk', edge: 'rising' }] : [],
    resets: type ? [{ id: 'rst', clock: 'clk', activeLevel: 'high', synchronous: true, deassertion: 'unknown' }] : [],
    modules: [{
      id: top, name: ['组合旁路', '单槽寄存', '双槽 skid buffer'][type], parent: null, kind: 'subsystem', rtlModule: baseline.top,
      clock: type ? 'clk' : null, reset: type ? 'rst' : null, timing: type ? 'sequential' : 'combinational',
      parameters: p, interfaces, resetControlInputs: type ? ['rst'] : [],
      interfaceGroups: [
        { id: 'clock_reset', label: '时钟复位', category: 'clock_reset', description: type ? 'clk 上升沿采样，rst 同步高有效。' : '物理端口保留，旁路分支不使用。' },
        { id: 'handshake', label: '握手', category: 'control', description: 'valid 正向，ready 反向。' },
        { id: 'ingress', label: '输入负载', category: 'data', description: '入口的 data、keep、last、ID、dest 和 user。' },
        { id: 'egress', label: '输出负载', category: 'data', description: '出口的 data、keep、last、ID、dest 和 user。' },
      ],
      contract: {
        responsibility: description, latencyMinCycles: type ? 1 : 0,
        latencyCondition: '下游持续就绪、空载且无复位，以输入接受沿和输出消费沿计拍。',
        backpressure: ['ready 由下游组合返回，等待期间由发送方保持负载。', '输出槽在下游未 ready 时保留有效负载。', '输出被阻塞时可暂存一个已获准的输入，恢复时临时槽移入输出槽。'][type],
        resetBehavior: type ? '复位清除 ready 和各槽的 valid，负载寄存器保留自身写入条件。' : 'clk 和 rst 不参与旁路传输。',
        invariants: [], verificationPlan: ['对照固定提交的上游原版 cocotb 用例及波形。'],
        openQuestions: ['完整四态、初值和任意事务序列尚无证明。'],
        transactionPaths: [path],
      },
    }],
    connections,
    localSignals: signals,
    specification: {
      summary: description,
      requirements: Object.entries(baseline.acceptance.requirements).map(([id, text]) => ({
        id, text, moduleIds: [top], acceptance: '固定提交、配置和 seed 的原版 cocotb 测试均通过。',
      })),
      decisions: [],
      openQuestions: [],
    },
    provenance: {
      origin: 'as_built', fidelity: 'partial',
      scope: faultAsBuilt ? '故意翻转输出数据位的 RTL 副本；还原实际赋值。' : '按固定参数的上游有效分支，还原输出位来源和同步整向量更新。',
      configuration: config.id + ' ' + JSON.stringify(p),
      sourceDigest: hashValue({ rtl: sourceHash, test: baseline.files[baseline.pytestFile], parameters: p }),
      coverage: { elaboratedInstances: null, representedInstances: 1 },
      evidence: [
        { id: 'rtl_branch', file: rtl, fileHash: sourceHash, line, endLine, sourceKind: 'code',
          targets: [{ kind: 'module', moduleId: top }, ...signals.map(s => ({ kind: 'local', moduleId: top, itemId: s.id }))] },
        { id: 'upstream_test', file: baseline.pytestFile, fileHash: baseline.files[baseline.pytestFile],
          sourceKind: 'test', symbol: 'test_axis_register', targets: [{ kind: 'module', moduleId: top }] },
      ],
      findings: [], verification: [],
      unsupportedStructures: [{
        id: 'initial_and_four_state', kind: 'verification_scope', category: 'unsupported',
        description: '模型和单步比较只表达二态更新，不核对寄存器初值、四态和状态可达性。',
        moduleIds: [top], evidenceIds: ['rtl_branch'],
      }],
    },
  });
  const blocking = validateModel(model).filter(issue => issue.blocks.includes('commit'));
  assert.deepEqual(blocking, [], 'benchmark model must validate');
  return model;
}

export function axisNetlist(raw: unknown): Definition {
  netlistSchema.parse(raw);
  const net = raw as { modules: Record<string, Definition> };
  assert.deepEqual(Object.keys(net.modules), [baseline.top], 'one unwrapped DUT after hierarchy');
  return net.modules[baseline.top];
}

function statePin(definition: Definition, regType: number, state: string) {
  const pin = (regType === 1 ? 'genblk1.genblk1.' : 'genblk1.') + state;
  assert.ok(Object.hasOwn(definition.netnames, pin), `missing mapped state ${pin}`);
  return pin;
}

export function auditStructure(config: Configuration, model: Model, imported: Model, definition: Definition) {
  const type = config.parameters.REG_TYPE;
  const parameters = netlistSchema.shape.modules.valueType.parse(definition).parameter_default_values;
  assert.deepEqual(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [
    key, typeof value === 'number' ? value : Number(BigInt('0b' + value)),
  ])), config.parameters, 'Yosys elaborated parameters differ from upstream pytest');
  const pins = Object.entries(definition.ports).map(([name, p]) => [name, p.direction, p.bits.length]).sort();
  assert.equal(pins.length, baseline.acceptance.ports);
  for (const candidate of [model, imported]) {
    const [dut] = candidate.modules;
    assert.equal(candidate.modules.length, 1);
    assert.equal(dut.rtlModule, baseline.top);
    assert.deepEqual(dut.interfaces.map(i => [i.id, i.role === 'consumer' ? 'input' : 'output', i.width]).sort(), pins);
  }
  const inventory = stateInventory(definition);
  const registers = model.localSignals!.filter(s => s.driver.kind === 'register');
  assert.equal(inventory.length, baseline.acceptance.registerVectors[type]);
  assert.equal(registers.length, inventory.length);
  assert.equal(new Set(registers.map(s => inventory.find(r => r.aliases.includes(statePin(definition, type, s.id)))?.cell)).size, registers.length);
  for (const state of registers) {
    const pin = statePin(definition, type, state.id);
    const cell = inventory.find(r => r.aliases.includes(pin));
    assert.ok(cell?.type === '$dff' && cell.width === state.width, `incorrect mapped register: ${pin}`);
    const dff = definition.cells[cell.cell];
    assert.equal(Number(BigInt('0b' + dff.parameters.CLK_POLARITY)), 1);
    assert.deepEqual(dff.connections.CLK, definition.ports.clk.bits);
  }
  const outputs = Object.entries(definition.ports).filter(([, p]) => p.direction === 'output');
  assert.equal(model.connections.length, outputs.length);
  for (const [name, output] of outputs) {
    const wires = model.connections.filter(c => c.to.interfaceId === name);
    assert.equal(wires.length, 1, `missing/duplicate output driver for ${name}`);
    const signal = model.localSignals!.find(s => s.id === wires[0].from.interfaceId)!;
    const driver = signal.driver;
    let actual;
    if (driver.kind === 'register') actual = definition.netnames[statePin(definition, type, signal.id)].bits;
    else if (driver.value.kind === 'endpoint') actual = definition.ports[driver.value.endpoint.interfaceId].bits;
    else if (driver.value.kind === 'constant') actual = [...BigInt(driver.value.value).toString(2).padStart(driver.value.width, '0')].reverse();
    assert.deepEqual(actual, output.bits, `incorrect output driver for ${name}`);
  }
  return { ports: pins.length, outputs: outputs.length, portBits: pins.reduce((n, p) => n + Number(p[2]), 0), vectors: inventory.length,
    importGaps: imported.provenance!.unsupportedStructures.map(g => g.kind), importedFidelity: imported.provenance!.fidelity };
}

export function stateMapping(config: Configuration, model: Model, definition: Definition, runId: string) {
  const type = config.parameters.REG_TYPE;
  return {
    schemaVersion: 2, runId, netlist: 'netlist.json', top: baseline.top,
    scopes: [{
      instancePath: [],
      mappings: model.localSignals!.filter(s => s.driver.kind === 'register').map(state => ({
        moduleId: top, localSignalId: state.id, clock: 'clk', state: statePin(definition, type, state.id),
        signals: unique(driverReads(state)).filter(e => e.interfaceId !== state.id).map(endpoint => ({
          endpoint, pin: endpoint.local ? statePin(definition, type, endpoint.interfaceId) : endpoint.interfaceId,
        })),
      })),
    }],
  };
}
