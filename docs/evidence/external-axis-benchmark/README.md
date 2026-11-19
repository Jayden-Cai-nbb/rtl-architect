# 上游九配置基准实测

2026-11-18，本机执行 `npm run benchmark:external-axis`。上游为 `alexforencich/verilog-axis@48ff7a7e2ef782cf778d47910cf85835c64b1bce`，外层 pytest 九组与内层 81 项原版 cocotb 用例全部通过。执行环境为 Python 3.10.12、pytest 7.2.1、cocotb 1.7.2、Icarus 11.0、Yosys 0.68+206、Node 24.18.1、npm 11.6.2。seed 为 1。执行路径、依赖的实际版本、冻结文件和运行产物摘要见机器报告。[机器报告](summary.json) · [原版 pytest XML](upstream.pytest.xml) · [复现与完整参数](../../../examples/external-axis/benchmark/README.md)

| REG_TYPE | DATA_WIDTH | KEEP_ENABLE / KEEP_WIDTH | 上游 cocotb | 结构还原 | 状态比较 | 事务解释 | 图形自动检查 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 8 | 0 / 1 | 9/9 | 通过 | 无状态 | 同沿消费 | 通过 |
| 0 | 16 | 1 / 2 | 9/9 | 通过 | 无状态 | 同沿消费 | 通过 |
| 0 | 32 | 1 / 4 | 9/9 | 通过 | 无状态 | 同沿消费 | 通过 |
| 1 | 8 | 0 / 1 | 9/9 | 通过 | 8 向量 MATCH | 下一沿消费 | 通过 |
| 1 | 16 | 1 / 2 | 9/9 | 通过 | 8 向量 MATCH | 下一沿消费 | 通过 |
| 1 | 32 | 1 / 4 | 9/9 | 通过 | 8 向量 MATCH | 下一沿消费 | 通过 |
| 2 | 8 | 0 / 1 | 9/9 | 通过 | 15 向量 MATCH | 下一沿消费 | 通过 |
| 2 | 16 | 1 / 2 | 9/9 | 通过 | 15 向量 MATCH | 下一沿消费 | 通过 |
| 2 | 32 | 1 / 4 | 9/9 | 通过 | 15 向量 MATCH | 下一沿消费 | 通过 |

- **结构 9/9。** 每组是原始单 DUT，核对 18 个端口的方向和位宽、8 个输出的位来源与寄存向量。8 位的寄存模式仍有内部 keep 寄存器，外部 `m_axis_tkeep` 固定为 1。原始导入候选保留内部逻辑和行为缺口。
- **状态 6/9。** 69 个寄存向量的有限二态单步函数 MATCH，比较依据为 `as_built`。三组旁路独立核对零状态发现，只计边界处理。寄存器初值、四态和全序列等价仍未验证。
- **事务解释 9/9。** 首笔在 70 ns 接受，旁路输出从 60 ns 可见且在 70 ns 消费。两种寄存模式在 70 ns 沿后可见，80 ns 消费。背压场景各组均观察到有效负载和 sideband 保持到消费，三组 skid 均观察到临时槽被占用。原生回放通过数为 0/9，旁路及 skid 共六组超出其模型范围，简单寄存三组未运行原生回放。
- **图形自动检查 9/9。** 各组保存 2 张任务 SVG、质量报告、离线阅读页和定位任务卡。三组 skid 状态局部图各报 221 处交叉和 1 条隐藏线名。人工试读为 0/9，状态为 `NOT_RUN`。

16 位 skid 的背压波形展示了两个槽的分工。3,580,001 ps 的上升沿，`tid=1` 的数据仍在输出槽等待。入口此前已给出 ready，`tid=2` 在这一沿进入临时槽。3,600,001 ps 的上升沿，下游消费 `tid=1`，`tid=2` 同沿移入输出槽，临时槽有效位清零。[该组逐沿证据](skid-16.transaction.json)

## 独立故障

在临时 `DATA_WIDTH=8, REG_TYPE=1` 副本，把输出槽数据写入的最低位翻转。固定 seed 下，原版 pytest 退出 1，九项原版 cocotb 用例全部失败。首项 `run_test_001` 的帧数据断言观察到收到的首字节为 `0x01`，预期为 `0x00`。`rtlarch verify` 保存 `check_failed`，校验失败的 JUnit、RTL/TB 摘要和日志。模块 `top` 的 assurance 可读取该失败运行。[失败运行记录](fault.verify.json) · [cocotb XML](fault.cocotb.xml) · [原始日志](fault.upstream.log)

报告以原始需求 `frame_integrity` 关联 `top.m_axis_tdata_reg`、`m_axis_tdata[0]` 和源码第 247 行。冻结原版模型给出单步 `MISMATCH`。故障版还原模型的八个状态向量均 `MATCH`，依据是 `as_built`，批准状态为 `DRAFT`，独立原版帧完整性要求仍判 `FAIL`。[关联和单步反例](summary.json)

机器报告中的相对路径以当次临时运行目录为基准。仓库保留机器摘要、上游 pytest XML 和失败运行的原始日志及 JUnit。运行目录另含每组内层 XML、FST、还原模型、状态报告和阅读页。根目录模型和布局的运行前后 SHA-256 一致。
