# 有限资源与存储预算 · 2026-11-18

本轮完成了可运行的 core、CLI 和 UI 改造，保留旧 study 输入与原有资源服务量下界。预算仍是 workbench 中绑定版本的假设与计算，不是第二份硬件模型；未引入聊天模型、云服务、HDL parser 或 AXI/CHI 协议。

## 改动与设计理由

- [studies.ts](../../../src/core/studies.ts) 保留旧字段及数值口径，新增可选 timing、有限启动序列、显式 RAM organization/accesses、feedback 和 sustained。新输入不在读取旧记录时补默认值，旧 workbench hash 检查通过。
- [studyConstraints.ts](../../../src/core/studyConstraints.ts) 将运算结果 latency、启动 II、整个资源独占周期和资源数分开；把资源、递推、RAM 访问及长期容量分别报告。未知不会成为零延迟或隐式端口映射。
- RAM 明确支持每 bank 的共享单 R/W、独立 1R1W、双端口 2RW。地址映射到 bank/word，逐拍检查端口和同址冲突，保留请求 ID。不同逻辑地址映射到同一物理 word 也按同址检查。有限请求不自动排队、重排或宣称已接受。
- 容量分开短时停顿与长期持续流率。到达率高于消费率时报告无界增长；其他情况也只报告速率条件，不承诺完整稳定性。原笼统 `feasible` 输出已移除，统一说明 `scheduleStatus: not_proven`。
- [BudgetEditor](../../../src/web/components/BudgetEditor.tsx)、[BudgetResult](../../../src/web/components/BudgetResult.tsx) 从 WorkbenchPanel 分出，提供四个可修改示例、显式字段、有限序列编辑、占用表、冲突与未知说明。保存复用原 workbenchHash 和候选/证据校验。CLI 原 `study` 入口直接使用同一 `evaluateStudy`，没有另写计算器。
- 页面直接导入的预算示例纳入构建身份，临时工具副本也复制这些依赖，避免示例变更却被视为页面仍是最新。

## 验收结果

以下均为条件化预算，不是 RTL 实测吞吐或完整调度证明。

| 场景 | 本轮计算与检查结果 |
|---|---|
| latency=3、II=1、独占=1，对比 latency=3、II=3、独占=3 | 单资源服务间隔下界为 1 / 3 拍；8 次独立运算的结果窗口下界为 10 / 24 拍。第二种方案在 E1 再次请求时定位到资源 0 的 op0/op1 独占重叠 |
| 单 bank，每项 1 读 + 1 写 | 共享 R/W 的存储间隔下界 2 拍；独立 1R1W 为 1 拍。同拍访问只有共享端口方案发生端口冲突 |
| 两个共享 R/W bank，端口总数相同 | 总端口下界同为 1 拍；两个请求落在 bank0 时仍报告 E0 / read0、write0 冲突，分到两个 bank 后该有限序列未发现冲突 |
| 三种端口类型 | 独立递归端口分配器穷举 75 组读/写数量，核对共享 R/W、1R1W、2RW 的能力；同一物理 word 多写另行拒绝 |
| 反馈 latency=3、distance=2 | 平均间隔下界 1.5 拍，固定整数 II 下界 2；未知 latency 保持 UNKNOWN |
| 8 GB/s 输入、6 GB/s 消费 | 积压增长 2 GB/s；任何有限 FIFO 都不能支持长期无阻塞输入。16 个 4-byte 数据项约 32 ns 填满，100 万项约 2 ms；均只是恒定流率估算 |
| 未映射地址、未知读延迟/同址语义 | 保留 UNKNOWN 边界；未知请求可能占用同 bank 时，不能为另一笔地址已知的读宣称确定返回沿 |

最终 CLI 原始结果：[运算时序](operation-timing-result.json)、[共享 RAM](shared-ram-result.json)、[bank 冲突](bank-conflict-result.json)、[反馈与容量](feedback-flow-result.json)。完整字段和公式见 [使用说明](../../../examples/storage-budget/README.md)。

## 本轮执行证据

新增 [check-storage-budget.ts](../../../scripts/check-storage-budget.ts) 的 **11 组检查通过**，包括旧输入/hash、独立端口枚举、未知与冲突、数值溢出、规模上限、CLI/core 一致及已批准临时 fixture 的模型/批准字节保持。记录见 [最终预算检查](check-storage-budget-final.log)。

按 package 顺序分段完成标准维护检查的 **27 个入口**，均有成功记录；另执行 `rtl:test` 和 `check:workflow`。不是一次未中断的 `npm run check`。27 项完成后补强了未知同拍请求的负例，重新运行预算检查和最终构建；最终浏览器使用该构建。顺序与耗时见 [29 项记录](check-status.json)，构建见 [build-final.log](build-final.log)，RTL fixture 和既有真实 RTL 工作流分别见 [rtl-test.log](rtl-test.log)、[check-workflow.log](check-workflow.log)。这些既有 RTL 检查不认证新预算示例的物理 RAM 行为或性能。

最终构建身份：`c29ec15eb5a5460c773d0242586f6d8296b66c9764a5984b3dccba1cb498bc7a`。Node 24.18.1、npm 11.6.2；Vite 保留已有大 chunk 提示。[结构化记录](validation.json)保留范围和未执行项。

Chromium 141.0.7390.37 在临时共享 RAM 结构工作区执行完整流程，窗口 1600×1100、1100×820：四例的页面数字与 core 一致；冲突、长期失稳和 UNKNOWN 可见；无效 JSON 不能保存；保存后刷新并重新打开预算可恢复记录；模型 hash、批准状态和布局均未改变，无 pageerror。预算数值是明确的假设方案，不是从结构 fixture 自动抽取的时序。

截图均已实际查看：[下界对照](timing-bounds.png)、[资源占用](resource-occupancy.png)、[独立 RAM 访问](independent-ram.png)、[bank 冲突](bank-conflict.png)、[持续流量](feedback-flow.png)、[未知边界](unknown-boundaries.png)、[保存恢复](saved-budget.png)、[窄窗口](narrow-budget.png)。表格和具体问题可以阅读；面板展开后主图可视高度仍较小，需要滚动，本轮没有用户阅读效率结论。恢复截图另作了只读补拍，等待框图 Worker 就绪，见 [补拍记录](browser-snapshot-followup.json)。

可复核 [浏览器结果](browser.json)、[实际保存的预算](browser-workbench.json)、[浏览器过程](browser-procedure.mjs.txt)、[临时 fixture 构造](browser-setup.mts.txt)、[补拍过程](browser-snapshots.mjs.txt)。

## 失败尝试与修复

1. 普通沙箱阻止新增检查启动 CLI 子进程，前 9 组已运行；完整检查随后在允许本机子进程的执行环境通过。[原日志](check-storage-budget-sandbox-attempt.log)。
2. 首轮 `check:open` 在临时副本中重建失败。补齐新导入预算示例的复制和构建摘要后重建、重跑并通过，新增第 4 组构建身份检查。[失败日志](check-open-missing-fixtures-attempt.log)、[首次进度](check-status-first-attempt.json)、[成功日志](check-open.log)。
3. 代码复核增加“未知地址请求影响另一读请求”的负例，先复现错误的 E2 返回推算，再修复为未知；最终预算检查通过。[修复前断言](unknown-peer-before-fix.log)。
4. 浏览器首次停在“同址读写”的精确标签定位，第二次在保存成功后刷新页面却未重新打开讨论面板。只修正自动化定位/步骤，未改产品语义；最终从空临时工作区完整通过。[首次定位失败](browser-locator-attempt.json)、[刷新操作遗漏](browser-resume-locator-attempt.json)。`browser-failure.*` 保留第二次尝试的原文件，不表示最终流程失败。

## 保护、清理与限制

[保护记录](preservation.json)核对 8 条路径：5 份已有模型/布局、lockfile 和 vendor 文件摘要未变，3 份原本不存在的根工作记录/批准文件仍不存在。临时 fixture 内的批准仅用于验证预算不改变批准字节；未批准真实 RTL 项目。临时浏览器、解包库/字体、工作区、批处理脚本已删除，专属服务已停止，见 [清理记录](cleanup.json)。未增加项目浏览器依赖或恢复测试框架配置。

首版限单时钟、整 word、每端口每拍一个请求的三种 RAM 组织；最多 16 bank、512 映射、512 次访问、256 次运算启动、32 条反馈，有限请求沿为 0..4095。没有完整调度、自动依赖提取、RAM 内容仿真、仲裁公平性、突发稳定性、跨时钟、字节掩码或任意端口类型证明；不由预算推断端到端性能。未知和未声明情况仍需用户核对。

本轮未运行远端 CI、干净发布安装检查、这些预算场景的 RTL/FPGA 性能实测、形式调度证明或用户效率实验；历史报告不能替代本轮执行。
