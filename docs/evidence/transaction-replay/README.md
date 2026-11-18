# 最小事务场景回放 · 2026-11-17

本轮实现可运行的单时钟、有序、无 payload 变换、每级单槽 ready/valid 回放。规范性声明保存在可选 `contract.transactionPaths`；实际沿前/沿后采样和派生轨迹分别保存在 verify 运行目录与 `evidence/replays`。没有向旧文件补默认语义，没有创建第二份硬件模型。

## 实现与约定

- core/schema、engine、spec 共用事务路径声明，经已有 preview/commit 校验；每级显式关联 data/valid 状态、装载分支、连接 ID 和已有源码依据。
- core/transactionReplay 根据显式信号映射，核对连续采样沿和有界事务身份。入口 E− 握手是 accept，末端 E− 握手是 consume，新保存事务的 E+ 可见性是 visible，复位沿取消在途身份是 cancel。visible 是合同预期事件，实际不符标记未匹配并保留诊断；位置也是按声明跟踪的期望位置，不是假造 RTL 标签。
- workspace/transactionReplay、CLI `replay` 和只读 `/api/replays` 复用 verify 输入/产物摘要与新鲜度。记录绑定 modelHash、sourceDigest、runId、采样产物、配置、映射及结果摘要。sourceDigest 特指 verify 声明输入闭包的摘要。
- 页面复用当前结构图、register.update 规则表、证据预览和 workbench。点击沿叠加事务位置；点击事件高亮所属模块，可打开声明分支、源码文件和相关讨论。普通选择不改变路由；显式打开内部状态会切换范围。过期轨迹不定位当前模型。人工推演显示 MANUAL，采集命令成功和事务核对结果分开。
- 格式要求显式 clock ID / rising 或 falling、`pre_edge_handshake_post_edge_settled` 约定，且 E0 观察到同步复位。X/Z、缺列及超宽值为 UNKNOWN，后续不猜测；缺沿、错误时钟/方向/宽度或越界路径拒绝导入。最多 8 级、256 位、4096 沿；输入和结果分别限 8 MiB，不隐式截断。

可运行演示及导入格式见 [示例](../../../examples/transaction-replay/README.md)。维护代码位于 `scripts/check-transaction-replay.ts`，已加入原有 check 链；没有恢复测试框架或新增项目依赖。

## 本轮真实仿真

使用 external-axis 固定 MIT 上游的 REG_TYPE=1 双寄存级。原 vendor 未修改；故障只注入临时副本。采集器执行 Verilator，记录 56 个沿。REG_TYPE=1 插入空拍，因此连续输入表示持续提供 valid，不表示每拍接受。

| 场景 | 本轮观察 |
|---|---|
| 连续输入、排空 | 接受 17 笔，消费 16 笔，复位取消 1 笔，结束在途 0；身份守恒 |
| 下游阻塞恢复 | E10..E18 下游阻塞，E11..E18 两级均阻塞；E19 恢复，后续消费继续 |
| 在途复位 | T8 在 E28− 取消，关联 stage0.stage0_valid_q 的 reset；E28+ 有效位清零 |
| data/valid 错拍 | T0 / E2+ / stage0.stage0_valid_q：期望 true，观察 false；FAILED |
| 阻塞覆盖 payload | T3 / E10+ / stage1.stage1_data_q：期望 19，观察 20；FAILED |

[正常轨迹](good.json)、[错拍诊断](valid_phase.json)、[覆盖诊断](blocked_overwrite.json) 保存绑定摘要、所有事件及问题。原始 [正常采样](artifacts/good-trace.json)、[错拍采样](artifacts/valid_phase-trace.json)、[覆盖采样](artifacts/blocked_overwrite-trace.json) 和对应 `*-run.json` / `*-stdout.log` 在 artifacts/；它们是本轮维护记录，不是对当前真实项目的批准或通用 RTL 证明。

两个故障的 verify 命令均完成采集，但 replay 为 FAILED。这明确区分“仿真程序成功写出轨迹”和“事务合同核对成功”。恢复临时来源后重新采集正常运行，旧故障仍可见为 STALE，保留原 FAILED 和具体问题。

## 检查与浏览器

- [最终构建](build-final.log) 成功；包含类型检查，保留已有 chunk 大小提示。
- 两次长 `npm run check` 调用以 SIGTERM / 143 结束，没有取得整条命令成功退出状态。第一份 [中断记录](check-interrupted.log) 和第二份 [记录](check.log) 均保留。第二次前 18 个入口通过后继续进入 expression-types；随后从 expression-types 起分段顺序重跑余下 6 个入口，两段退出码均为 0。全部 24 个 check 入口已完成；不称为一次未中断的 npm run check 成功。
- 分段记录：[表达式](check-expression-types.log)、[外部 RTL](check-external-axis.log)、[阅读任务](check-reading-tasks.log)、[状态锥](check-state-cone.log)、[候选质量](check-candidate-quality.log)、[最终回放 5 组](focused-final.log)。[rtl:test](rtl.log) 与超时负例通过，只验证原 tiny-stream fixture。
- [CLI 导入](cli-import.json) 和 [CLI 查询](cli-list.json) 在临时工作区实际执行成功。
- Chromium 临时环境，1600×1100：[浏览器断言与构建身份](browser.json)、[过程](browser-procedure.mjs.txt)。点击采样沿和事件后节点位置、尺寸和连线路径均保持不变；事务位置叠加、固定表头、分支高亮、源码、讨论、过期禁用和人工标识通过，无 pageerror。实际查看了以下截图，并未把几何数字代替视觉检查。

| 截图 | 实际检查 |
|---|---|
| [逐拍表与结构](table-and-structure.png) | E10 的 T4 / T3 保存位置、阻塞条件及固定表头可读；partial 提示仍可见 |
| [更新分支](branch.png) | 模型规则表中 load 高亮，真实优先级和保持行保留 |
| [源码依据](source.png) | 打开已有 upstream 文件证据，并核对文件摘要；没有推断新的行号映射 |
| [过期失败](stale-failure.png) | STALE 与原 FAILED 同时呈现，T3 / E10+ / 状态对象及期望/观察值保留，当前结构定位禁用 |

初次浏览器检查发现事件选择收起回放面板，已修复并重建复核；失败记录见 [首次页面尝试](browser-panel-attempt.json)。初次 valid 故障方式主要产生无身份输出，未满足具体事务断言，保留 [失败尝试](early-valid-negative-attempt.log)；最终改为真实增加一级 valid 延迟，未调整核对期望以掩盖故障。早期 focused.log / build.log 是本轮较早阶段记录，最终结论以上述 final 文件和 browser.json 为准。

## 保留的边界

不支持旁路、skid/FIFO 多槽、乱序/仲裁、数据变换、flush、异步复位、跨时钟和任意波形解析。映射与采集时刻由作者显式声明；工具不认证模拟器调度、不会自动抽取实际 RTL 分支。事件到分支是声明关联，源码按已有 evidence 定位，讨论按状态所属模块及版本关联，尚无逐事务讨论 ID。

正常核对标记 OBSERVED，不是完整时序或任意输入证明；人工记录不升级为仿真证据。页面最多列出 100 份记录并明确提示省略，完整磁盘记录保留。没有运行本轮远端 CI、check:release、check:workflow、形式/STA/CDC 验证或用户阅读效率实验。

[9 个受保护文件摘要](preservation.json) 均一致，包括根模型/布局、既有示例模型/布局及固定 vendor。前 8 个摘要与上轮已存基线比较，vendor 与固定上游摘要比较；未把历史执行结果当成本轮通过。所有语义提交、故障及讨论写入均在临时工作区，没有批准真实项目。最终执行与清理状态见 [validation.json](validation.json)。
