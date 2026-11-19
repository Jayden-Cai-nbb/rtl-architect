# 资源与存储预算

先选会改变架构取舍的工作量与约束。每个方案说明配置、工作项数量、时钟口径、成立假设与未表示依赖。用 `study` 在本地只读计算；网页“讨论与继续 → 方案预算”可载入并保存。保存使用 `workAction` 的 `kind=study`，预算修订另存新 ID。绑定候选时核对其登记 ID、hash 和该配置的证据。

| 要核对什么 | 看哪些量 |
| --- | --- |
| 独立算力和有限启动序列 | 运算延迟、资源独占周期和 II 各自声明；已知服务间隔取独占与 II 的较大值。逐个 lane 检查已列启动间隔。 |
| RAM 组织、bank 及值语义 | shared_rw、independent_1r1w、true_dual_2rw 按单时钟整 word 建模。显式声明逻辑地址到 bank/word 的映射、读延迟与同址读写规则。映射缺失保持未知。 |
| 反馈与持续流率 | 按实有反馈距离检查 `distance × II ≥ latency`。分别看有限停顿容量和持续到达/消费，长期积压不由一次停顿通过消除。 |

分别读取 `constraints.resource`、`recurrence`、`memory`、`capacity`。报告下界、冲突成员、未知、未建模及 `scheduleStatus`。无冲突只覆盖列出的有限请求。旧格式还能计算原服务量下界，缺的延迟、bank 或速率继续未知。实际 RTL 调度、器件 RAM 模式与性能由另外的验证负责。

在工具仓库根目录运行示例。随附 JSON 的 hash 供只读示例，保存时使用实际目标版本。

```bash
source ./env.sh
rtlarch help study --json
rtlarch schema study --json
rtlarch study examples/storage-budget/operation-timing.json --json
rtlarch study examples/storage-budget/shared-ram.json --json
rtlarch study examples/storage-budget/bank-conflict.json --json
rtlarch study examples/storage-budget/feedback-flow.json --json
```

公式、支持的流率单位与规模限制见[预算样例](../../../../examples/storage-budget/README.md)。
