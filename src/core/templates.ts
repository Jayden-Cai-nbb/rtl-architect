import type { Contract, Module } from './schema';
export function defaultContract(kind: Module['kind']): Contract {
  const fifo = kind === 'fifo';
  return {
    responsibility: fifo ? '寄存器 FIFO 按接收顺序缓冲数据；无空队列组合旁路。' : kind === 'add_const' ? '单级弹性输出寄存器，实现 (x + CONST) mod 2^DATA_W。' : '串联 FIFO 与加常数级，按顺序输出 (x + CONST) mod 2^DATA_W。',
    latencyMinCycles: kind === 'subsystem' ? 2 : 1,
    latencyCondition: '输入握手采样边沿至对应输出握手采样边沿；初始为空、无复位且下游持续 ready 时为最小延迟。持续背压不声明有限最大延迟。稳定无背压目标每周期 1 个事务。',
    backpressure: fifo ? 's_ready = rst_n && count < DEPTH；m_valid = rst_n && count != 0。满时即使出队也不接受输入；非满可同时入队/出队，计数不变。阻塞时保持 valid/data。' : '发送方在 valid && !ready 时保持 valid/data，直到接收或复位。加法级 s_ready = rst_n && (!out_valid || m_ready)，允许输出接收同沿装入新结果。',
    resetBehavior: 'posedge clk 同步低有效 rst_n；复位期间 valid/ready 输出为 0；复位采样边沿取消全部在途事务。FIFO 清读写指针和计数，不要求清存储数组。',
    invariants: ['仅在 posedge clk 且 rst_n=1 时以 valid && ready 记账。', '每个未被复位取消的输入恰好按序输出一次。', fifo ? '0 <= count <= DEPTH；DEPTH 仅允许 2、4、8、16。' : 'DATA_W 为 1..32，CONST 为 0..2^DATA_W-1；结果按 DATA_W 截断。'],
    verificationPlan: ['握手 scoreboard 检查顺序、丢失、重复及溢出截断。', '连续输入、随机背压、FIFO 满/空与同时入队/出队。', '在途复位、背压保持、超时失败；非采样边沿驱动。'],
    openQuestions: []
  };
}
export function createTemplate(id: string, parent: string, kind: Module['kind']): Module {
  if (!['fifo', 'add_const'].includes(kind)) return { id, parent, kind, name: id, rtlModule: id, clock: 'clk', reset: 'rst_n', parameters: { DATA_W: 32 }, interfaces: [], contract: { responsibility: '', latencyMinCycles: 0, latencyCondition: '', backpressure: '', resetBehavior: '', invariants: [], verificationPlan: [], openQuestions: ['补充模块职责、接口与验证合同'] } };
  return { id, parent, kind, name: id, rtlModule: kind === 'fifo' ? 'rv_fifo' : 'add_const', clock: 'clk', reset: 'rst_n', parameters: kind === 'fifo' ? { DATA_W: 8, DEPTH: 4 } : { DATA_W: 8, CONST: 3 }, interfaces: [{ id: 'in', role: 'consumer', protocol: 'rv', width: { param: 'DATA_W' }, required: true }, { id: 'out', role: 'producer', protocol: 'rv', width: { param: 'DATA_W' }, required: true }], contract: defaultContract(kind) };
}
