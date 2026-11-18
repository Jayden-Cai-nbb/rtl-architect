# 仓库导航与近期更新

源码和维护脚本保留原路径，按职责查找，避免因移动文件破坏 CLI、构建和示例入口。

| 内容 | 入口 | 用途 |
|---|---|---|
| 语义权威与操作 | src/core/schema.ts、engine.ts | IR、校验和 preview/commit |
| 阅读投影 | hardwareView.ts、readingProjection.ts、inspection.ts | 主事务总览、状态局部范围及追溯 |
| 状态逻辑 | nextStateCone.ts、stateUpdates.ts、stateObservation.ts | 模型 AST 与 RTL 观察分别标识 |
| 框图与连线 | src/web/graph/ | 布局、走线、Worker、质量与导出 |
| 事务回放 | core/transactionReplay.ts、workspace/transactionReplay.ts | 显式单时钟 ready/valid 观察与逐拍定位 |
| 对象协作 | workbench.ts、decisions.ts、workspace/repository.ts | 精确对象问题、候选决策和版本隔离 |
| 资源预算 | studies.ts、studyConstraints.ts | 资源、递推、RAM bank、长期容量 |
| 操作入口 | bin/rtlarch、src/cli、src/server、src/web | 共用 core，页面不执行任意命令 |
| 回归 | scripts/check-*.ts、package.json | 维护检查，不引入独立测试框架 |
| 通用样例 | examples/ | 可运行 fixture、预算输入及使用说明 |
| 验证记录 | VALIDATION.md、docs/evidence/ | 区分本轮、历史、失败与未执行项 |

## 2026 年 11 月更新

- 阅读任务与有限状态逻辑锥，保留模型、成员、未知及原始连接。
- 候选图形质量检查与连线改进，普通选择保持几何稳定。
- 显式映射的事务回放，区分接受、可见、消费和取消。
- 精确硬件对象讨论、恢复定位及候选绑定决策。
- 有限资源与存储预算，区分 latency、II、独占与资源数，报告 bank 冲突和长期失稳。

详细使用说明：[对象协作](../examples/object-collaboration/README.md)、[事务回放](../examples/transaction-replay/README.md)、[存储预算](../examples/storage-budget/README.md)。实际执行与限制以 [验证索引](../VALIDATION.md) 为准；本地通过不代表远端 CI 已通过。

## 文件保留与发布

源码、脚本、通用模型 fixture、固定第三方许可和有对应报告的证据进入版本管理。失败与未知证据保留，不以清理名义删去反例。旧版本资料沿用远端已经整理的版本，不重新引入本地重复历史资产。

node_modules、dist、运行环境、用户 architecture/proposals/generated、仿真波形和临时服务目录不推送。dist 通过构建生成，通用 examples 中明确允许的模型由 .gitignore 例外保留。

当前包版本继续为 2.0.0；本次是源代码更新，不创建额外 GitHub Release 或版本标签。页面/服务通过内容摘要区分构建。
