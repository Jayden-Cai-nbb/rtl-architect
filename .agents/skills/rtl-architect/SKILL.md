---
name: rtl-architect
description: 与用户设计、审阅或还原 RTL 架构，沿真实事务核对结构、状态、时序与资源取舍，交付同源框图、Spec、候选和可追溯证据。
---

# RTL 架构设计、阅读与审阅

先沿一笔事务讲清接收沿、实际保存状态、结果可见、消费及阻塞或取消。依据任务挑选下表的参考材料，把关键事实、未知和需要用户决定的取舍放在前面。

## 从项目进入

- 读目标项目的 AGENTS.md、README、RTL、测试和实际构建配置。通过本 skill 目录的 `scripts/rtlarch` 调用工具，保留目标项目 cwd，并明确传 `--workspace`。用 `rtlarch help --json` 发现命令，`rtlarch help replay --json` 这类查询给出给定命令和相应 schema。机器调用核对退出码、`ok`、`error.code` 及结果中的具体状态。[入口与可执行示例](references/proposal-guide.md#从项目入口到可审阅提案)
- 已有工作先按需读取 `resume --offline`、`context-index --offline` 和对象局部 `context --offline`，核对工作区、模型 hash 与恢复目标。需要页面或在线写入时用 `open` 核对服务和构建身份。无模型的只读还原可输出独立候选；确需创建工作区才执行 `init`。服务受阻的磁盘快照保持只读，不把它当在线验收。

## 按任务读取参考

| 用户想做什么 | 入口 |
| --- | --- |
| 看主事务总览、局部状态和原始连接，核对候选图 | [阅读任务投影](references/diagram.md#阅读任务投影) |
| 解释下一拍的 D 值、使能、优先级、保持或位宽 | [下一状态逻辑锥](references/state-cone.md)，需要 RTL 比较时读 [状态观察](references/state-observation.md) |
| 沿实际采样看接收、可见、消费、阻塞和复位取消 | 先用 `help replay --json` 核对能力，再读 [事务回放](references/transaction-replay.md) |
| 对图中的对象提问、保存下一步或恢复讨论 | [对象讨论与续接](references/workbench.md) |
| 比较 A/B 候选并记录用户选择、预算及实验 | [候选决策](references/decisions.md) |
| 核对计算资源、RAM 端口与 bank、反馈距离或流率 | [资源与存储预算](references/resource-budget.md) |
| 从 RTL、上游测试和构建配置还原 | [现状还原](references/as-built.md) 与 [时序方法](references/timing.md) |
| 新设计或调整架构、分工与取舍 | [设计方法](references/design.md) 与 [共同设计](references/collaboration.md) |
| 写模型、增量提案、数组或类型转换 | [提案约定](references/proposal-guide.md)、[进阶建模](references/advanced-modeling.md)、[数值类型](references/expression-types.md) |
| 整理文字、命名与用途分组 | [阅读整理](references/reading-refinement.md) 与 [表达方式](references/writing.md) |
| 核对证据、离线成果或按合同实现 | [架构可验证](references/verification.md)、[证据与交付](references/delivery.md)、[实现交接](references/implementation.md) |

## 全程保留的约定

- `architecture/model.json` 是唯一语义权威，图、Spec、时序附件与布局为派生；布局独立绑定 modelHash。新模型用 IR 3，旧模型保持原 hash。源码事实、推断和未知分开，现状还原保留 `as_built`、`partial`、覆盖缺口和未表达结构。保留真实反馈、时钟、复位和端口关系。
- 语义修改使用当前工作区基线经 preview/commit。提案放 `proposals/`，登记只生成审阅入口。核对 workspaceId 与 base/candidate hash，冲突保留原提案再显式预览。Agent 不直接写权威模型、确认记录或 `generated/`，不自动提交、确认或批准真实项目。用户先审阅草稿，再逐模块确认和整体批准；局部确认跟随依赖指纹，整体批准绑定完整 hash。handoff 还核对当前导出合同。缺覆盖、未表达结构及现状还原状态不能靠删标记绕过。
- 来源新鲜度、本地审阅、结构映射、状态比较、场景测试和器件验收各有依据。仅运行用户明确输入的验证 argv，记录配置、模型和源码摘要、工具版本及结果。人工阅读未做就报未执行；缺映射、超出支持或过期明确报边界。失败保留，历史结果不冒充本轮通过；不能由还原一致性或有限观察宣称满足原要求。
- 同一工作区只使用其唯一写入服务。运行时不从外部改架构文件，不为工具维护迁移或重启其他项目。样例验证与故障注入使用临时副本，保护原始 RTL、测试和验收规则。输出放新目录，按需提供可审阅链接、当前证据和待决定问题。
