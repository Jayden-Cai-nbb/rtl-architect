# 事务回放

按采样沿核对一笔事务如何接受、保存、可见、消费和取消。先读 RTL、测试与有效构建配置，给出实际握手、时钟和状态边界。相同负载可有不同接受编号。固定上游基准和其他仿真场景分别报告。

| 声明 | 观察重点 |
| --- | --- |
| 已有 v1 `ordered_lossless_single_slot_stages` | 同时钟、有序、负载不变、每级一个保存槽。最多 8 级、256 位 |
| v2 `combinational_bypass` | 零存储，valid 和负载直通、ready 反向返回，同沿接受与消费。复位标记期间仍观察物理直通 |
| v2 `registered_single_slot` | 输出槽和寄存 ready，接受后沿后可见，阻塞时保持，复位清除有效状态 |
| v2 `registered_skid` | 输出槽、临时槽和寄存 ready。受阻时装载临时槽，恢复可同沿消费旧输出并移动旧临时槽，复位分别撤销两槽身份 |

v2 支持一个明确作用域，逐字段声明 data 和启用的 sideband，最多六项，每项 1 到 256 位。禁用字段显式指定输出常量。观察轨迹最多 4096 个连续采样沿。FIFO、仲裁、变换、额外 flush、异步复位和跨域保留为能力边界，继续使用独立 scoreboard、只读波形及可追溯逐拍解释。

`rtlarch help replay --json` 给出语义 ID、能力范围和独立验证入口。对已有工作区，`rtlarch replay --semantics registered_skid --workspace . --json` 检查所需语义。`NOT_DECLARED` 表示可表达、当前范围缺声明。`DECLARED` 提供现有路径 ID。需要地址化帧 FIFO 时查询 `--semantics addressed_frame_fifo`，结果为 `UNSUPPORTED`。选定模块可加 `--module ID`。模型中的显式 `ram_frame_replay` 缺口也会提示该边界。图中声明的存储和端口沿用原名，能力判定来自显式需求或缺口声明。

遇到 `UNSUPPORTED`，使用 `verify` 的 simulation 清单核对独立 scoreboard、JUnit 和采样产物，再用 `runs` 或网页“查看独立仿真证据”追溯当前、失败和历史运行。缺少路径的导入返回 `REPLAY_PATH_NOT_DECLARED`，超范围返回 `REPLAY_UNSUPPORTED`。有限仿真通过仍属于独立运行证据。

## 声明与产物

1. 在模型 `contract.transactionPaths` 声明路径、时钟和复位语义。v2 给出字段到端口/槽位的显式对应及真实连接 ID。模型修改走提案。位宽通过模型参数求值，已知不可能装载的声明会被拒绝。
2. 用 `verify` simulation 清单登记实际配置、输入和采样产物。沿前采握手，沿后等状态与组合稳定。v1 用 `rtlarch-rv-samples-v1`，v2 用 `rtlarch-rv-samples-v2`。FST/VCD 通过有来源的适配器转为连续 E−/E+ 字典，保留原测试和 scoreboard。
3. 通过 `help replay --json` 和 schema 查询构造映射。v1 给观察点，v2 的 `ports`、`states` 将明确的模型 ID 对应采样列。填实际 runId、产物相对路径和本次配置文件。`replay` 导入映射，省略映射则列出记录。手写采样标 `manual`，报告 `MANUAL`。
4. 检查器当前为 3，旧结果显示 `STALE` 并保留历史。未改变的 v1 合同可用原本仍新鲜的采样重新导入。新增 v2 声明后登记当前模型的 v2 采样和映射。两代路径、产物和映射不能混用。

## 读结果

沿前 valid && ready 决定接受和消费。沿后独立观察槽位和有效负载，旁路也核对沿前及沿后直通。只在观察到接受时分配 T，临时槽转移保留原身份。沿前 valid 等待 ready 时，入口须保持 valid 和全部启用字段。`ENVIRONMENT_VIOLATION` 定位入口前提，从违规沿停止下游归因。未知值另报 `UNKNOWN`。

分别报告当前采样、分支声明关联、入口检查和场景覆盖。列出实际接受、出口握手、阻塞和恢复、取消及结束在途。零接受为 `COVERAGE_INCOMPLETE`，有限轨迹允许在途。`OBSERVED` 依据当前有限轨迹。`FAILED` 保留事务、字段、沿和实际对象。上游需求、状态函数 MATCH 和批准各有自己的依据。

页面“事务回放”可定位同一端口或槽位、模型声明分支、源码与讨论。当前记录核对模型 hash、verify 产物和检查器，过期保留历史。以下入口从工具根目录运行，先查询 CLI 和 schema，再执行 Verilator 的双单槽维护样例。

```bash
source ./env.sh
temp=$(mktemp -d -t rtlarch-replay-XXXXXX)
rmdir "$temp"
rtlarch help replay --json
rtlarch schema transactionPath --json
rtlarch schema replay --json
rtlarch schema replaySamples --json
RTLARCH_REPLAY_WORKSPACE="$temp" npm run check -- verification
rtlarch replay --workspace "$temp" --json
```

[格式和迁移](../../../../examples/transaction-replay/README.md) · [固定上游九配置及 v2 定向采样](../../../../examples/external-axis/benchmark/README.md)
