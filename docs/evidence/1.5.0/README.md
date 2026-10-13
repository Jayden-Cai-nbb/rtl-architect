# 1.5.0 状态更新实测

2026-10-13，本机 Linux/WSL。来源为通用 add_const RTL；没有发布真实 CPU/Turbo 项目、用户反馈或账户信息。

- [完整维护检查](check.log)：15 个入口，新状态检查 11 组。
- [状态与故障检查](state.log)：真实 Verilator，错误数据/保持/复位/优先级及未触发、映射、过期负例。
- [维护构建](build.log) / [公开副本构建](public-build.log)。
- [原 fixture RTL 回归](rtl.log) / [skill 格式检查](skill.log)。
- [实际示例仿真输出](simulation.log)：每个状态的复位、更新与保持计数；[当前证据状态](assurance.json)保留草稿与结构未运行。
- [浏览器结果](browser.json)：保存实际高亮的边 ID，两类问题对应不同依赖；不是只检查按钮文字。

| 页面任务 | 实际截图 |
|---|---|
| 查看声明的条件装载结构 | [主图](state-overview.png) · [下载 SVG](state-overview.svg) |
| 解释复位、装载、保持优先级 | [更新表](state-update-table.png) · [1100×820 窗口](state-small.png) |
| 回查真实过程与文件摘要 | [源码证据](source-evidence.png) |
| 解释值来源与控制原因 | [数据追踪](data-trace.png) · [控制追踪，含复位](control-trace.png) |
| 核对本次实际运行 | [行为证据](state-assurance.png) |

[示例和运行命令](../../../examples/state-updates/README.md)。保持测试使用不同的新旧数据，另在临时 RTL 中交换两个同时成立条件的优先级；测试结束清理故障源码。页面仍有交叉和收起线名，追踪保留背景关系；当前规则由源码人工整理，不代表自动解析任意 RTL 或完整行为证明。
