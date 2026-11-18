# 硬件对象协作闭环 · 2026-11-17

本轮实现代码、页面和维护检查，未引入聊天模型或云服务。讨论、预算和决策继续存于 `architecture/workbench.json`；硬件语义仍来自 IR，修改仍经过 preview/commit。所有写入、故障注入及检查用批准均发生在临时 fixture，没有批准真实 RTL 项目。

## 第一步：精确对象讨论

`core/workbench` 的可选对象目标记录 local state、update branch、requirement、obligation，携带作用域、完整 IR 实例路径、显式数组下标和模型版本。分支另带所属状态 ID。路径不使用显示名或 RTL 定义名，两个同定义实例不会因为状态同名而共享讨论。旧记录不补字段。

状态详情、规则行、需求、义务和事务回放的“对此提问”入口共用目标构造与校验；问题定位及继续工作恢复复用同一目标。分支恢复突出显示对应规则行。删除对象、改变实例路径或模型版本后，记录保留并禁用定位，不按名称重绑。普通选择、提问和保存工作记录不重新布局、不改模型或批准。

独立验证：新增 [check-work-objects.ts](../../../scripts/check-work-objects.ts) 的 4 组检查通过，随后本步构建通过；原有 milestone、explore 也通过。记录见 [对象检查](step1-check.log)、[构建](step1-build.log)、[milestone](step1-milestone.log)、[explore](step1-explore.log)。批准字节保持负例在已批准的临时 packet-pipeline fixture 中执行。

## 第二步：候选与决策

新增结构化决策引用已有问题、两个候选的 ID/hash、各自预算、假设、风险、实验和追加式用户选择理由。保存决定及选择方案均不提交、批准或自动解决问题；不反写硬件模型内的设计决策文本。

候选只读评估分别显示模型检查、partial/未知和属于该 hash 的已有 verify 记录。预算每个选项可绑定自己的不可变登记候选；修订产生新 ID/hash，旧预算仍归属于旧版本，在新配对下显示不适用。候选、来源或产物过期时保留历史失败并显示 STALE。跨候选 hash 的实验、预算及伪造候选版本被拒绝。未执行实验保持无证据。

`core/diff` 新增确定性摘要，覆盖状态更新、复位/保持、真实分支顺序、可解析边界位宽、显式 cast/截断节点及完整连接端点/位域。原始 diff 保留；摘要不从布局推断优先级，也不推导端到端性能。Changes、CandidateCompare 和 CLI compare 复用该摘要。

独立验证：新增 [check-decisions.ts](../../../scripts/check-decisions.ts) 的 5 组检查通过，本步构建通过。记录见 [决策检查](step2-check.log)、[构建](step2-build.log)。该检查中的 A 通过/B 失败实验是 **Node 记录绑定 fixture**，用于检查隔离、新鲜度和失败保留，不是 RTL 仿真结果。

## 本轮最终检查

| 项目 | 本轮实际结果 |
|---|---|
| 两步独立检查 | 第一步 4 组、第二步 5 组通过，各自构建通过 |
| 标准维护检查 | 按 package 中顺序分段运行全部 26 个入口，均 exit 0；不是一次未中断的 `npm run check` 进程 |
| 最终 build | typecheck、Vite 构建通过；保留已有大 chunk 警告 |
| rtl:test | 初始 tiny-stream RTL fixture 及其负例通过 |
| check:workflow | 通用临时 RTL 的真实 Yosys/Verilator 路径通过，测得 19.251 秒；不代表人的效率提升 |
| 浏览器 | 临时 Chromium 141.0.7390.37，1600×1100；最终完整流程通过，无 pageerror |
| 文件保护 | 根模型/布局、所列示例模型/布局及固定 vendor 共 9 份文件摘要不变 |
| 清理 | 已停止本轮临时工作区服务，删除该工作区、浏览器依赖目录和临时批处理脚本 |

可核对 [结构化总记录](validation.json)、[26 项状态与耗时](check-status.json)、[最终构建](build-final.log)、[RTL 日志](rtl.log)、[实际工作流](workflow.log)、[文件摘要](preservation.json)、[清理记录](cleanup.json)。页面构建身份为 `33e5458244a08faf592664ee26aa20cd628409cd62a962e20a6494e7e2108f82`。

浏览器实际检查了两个实例隔离、提问前后节点/路径几何不变、CLI open 恢复原分支、需求/义务定位、A/B 证据隔离、改选 B 修订后旧预算失效、用户选择前后模型及批准状态不变，以及最后替换分支 ID 后禁止恢复。最后一项是临时 fixture 中明确执行的语义变更，发生在普通讨论/选择的保持断言之后。

截图已实际查看：

- [实例零](instance-zero.png)与[实例一](instance-one.png)：各自实例路径和问题可见，没有串联。
- [恢复分支](restored-branch.png)：精确恢复到 `load` 规则行。
- [候选比较](candidate-comparison.png)：保留 partial、独立版本及 B 的失败。
- [预算过期](revised-budget.png)：显示 STALE / 不适用于当前候选。
- [决策与选择](decision-choice.png)：保留预算、风险、版本和失败实验，显式选择附理由。
- [失效对象](invalid-target.png)：原对象失效提示及禁用的定位入口。

首次浏览器尝试因为自动化定位器同时命中问题标题和正文而停止，见 [失败记录](browser-locator-attempt.json)和[当时截图](browser-locator-attempt.png)。仅修正测试定位器后完整通过，见 [首次成功](browser-first-success.json)。随后调整截图滚动位置和图形等待条件，再次从新临时工作区完成全流程，最终结果见 [browser.json](browser.json)。上述失败不是通过项，也未据此隐去产品失败。`browser-failure.*` 是首次尝试保留的原文件，名称不表示最终流程失败。

可复核 [浏览器过程](browser-procedure.mjs.txt)、[fixture 构造](browser-setup.mts.txt)、[保存的 workbench](browser-workbench.json)、[最终失效状态快照](browser-final-workbench.json)、[候选 A 记录](candidate-a-run.json)、[候选 B 记录](candidate-b-run.json)。浏览器候选实验同样只是 Node 记录 fixture；最终快照在故意替换分支后采集，因此其中的 STALE 是预期负例。历史服务端口与临时目录仅作追溯，现已清理。

## 仍有限制

- 对象定位采用保守版本约束：任何 modelHash 变化都会令旧目标失效，包括其他模块的修改；不声称选择性跨版本迁移。路径是 IR 实例身份，不推断 HDL 层级。状态范围仍受现有 IR 限制。
- 老增量候选缺少原基线时不能重建；不借当前模型猜回历史版本。页面只读关联本工作区已有 verify 记录，不执行新的候选仿真，也不把 A 的 hash 证据迁移到 B。
- 预算是显式假设下的条件化计算，不是实测吞吐率、延迟或完整时序证明。摘要保留无法解析的宽度，不替代原始 AST/diff。
- 本地 `author=user` 是操作者记录，不认证身份。选择方案本身不构成批准。
- 浏览器确认了对象、版本、失败和操作入口可读；讨论面板展开后图的可视高度偏小。本轮没有声称改善所有拥挤问题或提升人的阅读效率。
- 未运行远端 CI、本轮干净发布安装检查、形式/STA/CDC 证明或用户效率实验。其他报告中的历史结果不作为本轮结果。

使用说明见 [对象协作示例](../../../examples/object-collaboration/README.md)。
