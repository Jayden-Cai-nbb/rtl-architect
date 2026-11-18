# 有限资源与存储预算

这组小型共享 RAM 示例是可解释的预算输入，不是硬件模型或仿真报告。计算结果保存在工作记录中；不改 IR、layout、确认或批准。没有增加 AXI/CHI 协议或通用调度器。

```bash
source ./env.sh
bin/rtlarch study examples/storage-budget/shared-ram.json --json
bin/rtlarch study examples/storage-budget/operation-timing.json --json
bin/rtlarch study examples/storage-budget/bank-conflict.json --json
bin/rtlarch study examples/storage-budget/feedback-flow.json --json
```

这些独立文件的 modelHash 是占位值，只供只读计算。在网页“讨论与继续 → 方案预算”选择示例并显式载入，会使用当前工作区版本和对象；计算后可保存新预算。候选预算仍需分别选定自己的登记 ID/hash，关联证据沿用原 verify 新鲜度检查。不能将示例里的时序和 RAM 模式当成目标 RTL 已核实事实。

## 资源口径

`compute.lanes` 是独立资源数量，`operationsPerItem` 是每个工作项的运算数，`cyclesPerOperation` 保留旧含义：一次启动独占整个资源的周期数。新增可选 `compute.timing` 明确 `latencyCycles` 和 `initiationInterval`，两者可为 null（UNKNOWN）。不从其中一个推断另一个。

- latency：假定 E0 接受后，结果到 E_latency 可见。不是资源服务间隔。
- 独占周期：在 `[启动沿, 启动沿 + cyclesPerOperation)` 中，不能向同一个资源再分配运算。它不是流水线内数据驻留时间。
- II：同一资源两次启动必须间隔至少这些周期。已知服务间隔取 `max(独占周期, II)`；II 未知时只保留独占下界。
- 每工作项资源间隔下界为 `operationsPerItem × 已知服务间隔 / lanes`，允许分数。固定整数工作项 II 另取上整。

因此三拍流水延迟、每拍启动且独占一拍，资源下界为 1；三拍独占且 II=3，下界为 3。示例 8 个独立运算的结果窗口下界分别为 10、24 拍。这不是含存储和反馈的端到端时延。

`cyclesLowerBound` 继续报告原来的服务量/独占周期下界和 `overheadCycles`，不改称完整完成时间；启动、结果排空和端到端依赖没有被该字段证明。旧输入和原预算数值保留；读取旧工作记录不增加 timing、organization、feedback 或 sustained 默认字段。

有限 `compute.launches` 显式填写 `{id, cycle, lane}`，lane 从 0 开始。检查列出独占区间、再次启动下界及冲突成员，不重排请求、不自动调度，也不声称请求已实际接受。

## RAM 端口、bank 与读值

旧 memory 输入继续使用总独立 `readPorts` / `writePorts`，副本数不自动增端口。新输入使用互斥的 `organization`，不能同时填旧端口总数：

| kind | 每 bank 的请求能力 | 总服务量下界 |
|---|---|---|
| shared_rw | 一拍共一个读或写 | `(读数 + 写数) / bank数` |
| independent_1r1w | 一拍一个读、一个写，可同时 | `max(读数, 写数) / bank数` |
| true_dual_2rw | 两个端口各可读或写，每拍共两个请求 | `(读数 + 写数) / (2 × bank数)` |

仅支持单时钟、整 word、每端口每拍一个请求的声明；没有任意多端口、字节掩码或多时钟语义。读延迟不占住后续拍的请求端口。目标器件是否满足上述声明须另外核验。

`organization.bankIds` 列出独立 bank，`copies` 必须等于其数量。每 bank 容量为 `words × width`；这些 bank 不自动具有副本一致性。`mapping` 是明确的逻辑地址到物理 bank/word 表，例如：

```json
{
  "kind": "shared_rw",
  "bankIds": ["b0", "b1"],
  "readLatencyCycles": 1,
  "sameAddressReadWrite": "unknown",
  "mapping": [
    {"address": 0, "bank": "b0", "word": 0},
    {"address": 1, "bank": "b0", "word": 1}
  ]
}
```

上例两个地址都落在 b0；同拍读写仍冲突，b1 的空闲端口不能掩盖它。有限 `accesses` 记录 `{id, cycle, kind, address}`；地址 null 或无映射为 UNKNOWN，不猜测取模映射。不同行逻辑地址显式映射到同一物理 word 时，也按同址检查。

读结果可见沿按 `cycle + readLatencyCycles`，延迟 null 为未知。同址读写明确选择写前值 old_data、本拍写值 new_data、输出保持 no_change、禁止 forbidden 或未知 unknown。no_change 不产生该读请求的新结果。两个写同一物理 word 为冲突，不猜写入优先级。这里只说明声明的值语义，不执行 RAM 内容仿真；冲突请求不生成确定读结果。

示例 shared-ram 的两种组织，存储下界分别为 2、1；bank-conflict 的两种方案总下界同为 1，但只有同 bank 方案出现局部端口冲突。有限序列未发现冲突不证明它可覆盖所有工作量或无限重复。

## 反馈与长期容量

可选 `feedback` 中每条 `{id, latencyCycles, distance}` 满足 `distance × II ≥ latency`；距离必须为正整数。3 拍反馈、距离 2 的平均间隔下界为 1.5，固定整数 II 至少为 2。未知 latency 保持未知；缺少声明不等于没有反馈。不会从图形、规则顺序或名称推断递推距离。

原 flow 停顿预算仍为 `producedPerCycle × maxStallCycles + inFlight`，单位为数据项。可选 `flow.sustained` 单独输入持续到达和消费率：

- `items_per_cycle`：项/拍，可用小数；两个速率分别可为 null。
- `bytes_per_second`：十进制字节/秒，另给 `bytesPerItem`，用于换算已有容量项数。

持续 8 GB/s 输入、6 GB/s 消费，积压每秒增加 2 GB；任何有限 FIFO 都不能支持长期无阻塞输入。增加容量只能推迟填满。页面会同时保留“停顿预算足够”和“长期积压无界”，两者不互相覆盖。填满时间仅为恒定流率、初始占用为 inFlight 的流体估算，不包括离散拍、突发与消费抖动。

到达率等于或小于消费率也只满足平均速率必要条件，不能保证有限容量长期稳定；unknown 不补零，也不转成通过。没有将 B/s 与运算或 RAM 拍率自动换算成端到端吞吐。

## 结果与边界

core、CLI、页面共同使用 `evaluateStudy`。`constraints` 分开输出 resource、recurrence、memory 和 capacity，列出 unmodeled 假设。删除原来笼统的 `feasible` 输出，所有方案均注明 `scheduleStatus: not_proven`；旧输入仍可直接使用。请读取具体冲突、新鲜度、未知及容量状态，不能把旧 `feasible` 或单项“未发现冲突”解释为完整调度通过。

规模限制：最多 6 个预算选项、16 bank、512 条地址映射、512 次 RAM 访问、256 次运算启动、32 条反馈；请求时刻为 0..4095 的有效沿。超范围或整数溢出拒绝计算，不截断。冲突按资源或物理 word 聚合，保留全部成员 ID。

检查入口为 `npm run check:storage-budget`。本轮实际检查、截图、失败尝试和未执行范围见 [验证记录](../../docs/evidence/storage-budget/README.md)。
