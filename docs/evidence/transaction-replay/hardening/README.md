# 事务回放工程加固实测

2026-11-18，先用原检查器运行 Verilator 双寄存级样例并保留临时工作区，再执行六项复现。修复后用相同的模型、输入轨迹和旧记录重跑对照。参数宽度、装载分支、空场景和入口保持使用短 JSON 轨迹。历史版本使用真实 Verilator 轨迹生成的回放；排序用例复制回放并固定创建时间，使最新记录的 UUID 字典序最小。[修复前原始输出](before.json) · [修复后原始输出](after.json)

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 等值参数和表达式位宽 | 两种声明均返回 `TRANSACTION_PATH`，阻断提交 | 两种声明均无提交阻断，回放 `OBSERVED` |
| 常量 0 装载分支 | `OBSERVED`，E1+ 的 visible 标记 `branch=load, matched=true` | `TRANSACTION_PATH` 报告 `stage0.stage0_data_q.load` 不可达，拒绝回放 |
| 仅 E0 复位 | `OBSERVED`，0 个事件 | `COVERAGE_INCOMPLETE`，复位 1 沿，接受 0，valid 匹配 2 次 |
| 入口等待时 payload 从 17 改到 42 | `OBSERVED`，随后以 42 跟踪 T0 | `ENVIRONMENT_VIOLATION`，E1+ 的 `INPUT_PAYLOAD_CHANGED` 定位到 `top.s_axis_tdata`，路径诊断 0 条 |
| 更换检查器读取同一历史记录 | 临时工具中的新检查器已替换为抛错实现，历史仍是 `fresh=true, OBSERVED` | 旧结果显示 `STALE / CHECKER_VERSION`，历史 `OBSERVED` 保留。同一新鲜 verify 产物用版本 2 重导为 `OBSERVED` |
| 101 份历史截取最近 100 份 | 最新的 01:40 UTC 记录漏掉，首条为 01:39 | 首条为 01:40，仍返回 100 份，标记 `limited=true` |

输入违规停止该沿及之后的路径归因。回归还同时注入了入口违规和该沿的下游异常采样，确认该沿无寄存器故障诊断。更早一次已确认的复位 valid 失配仍保留。另验证跨沿撤销 valid、在恢复握手前换 payload，以及复位清除入口等待约束。

有限轨迹在 E1 接受 T0 后立即结束，结果是 `OBSERVED`，接受 1、消费 0、在途 1。visible 记录独立的 valid 与数据观察结果，`branch=load` 是模型声明关联。

## 真实 RTL 回归

Verilator 原版轨迹检查了 56 沿，接受 17 笔、消费 16 笔、级内阻塞 2 笔、恢复 2 笔、取消 1 笔，结束时在途为 0。入口等待 26 沿，等待后握手 17 次。

| 临时故障 | 首次差异 |
| --- | --- |
| valid 多延迟一拍 | `VALID_PHASE`，T0、E2+、`stage0.stage0_valid_q`，期望 true、观察 false |
| 阻塞时覆盖 payload | `BLOCKED_PAYLOAD_OVERWRITE`，T3、E10+、`stage1.stage1_data_q`，期望 19、观察 20 |

两个故障的采集命令均通过，回放均判 `FAILED`，入口前提均为 `CHECKED`。这些结果限于本次显式采样，`OBSERVED` 不等于形式证明。[运行与覆盖摘要](verilator.json)

复现回归入口为 `npm run check:transaction-replay`。原版及故障 RTL 仿真、回放和历史记录验证均在临时工作区执行。

Chromium 141 在 1600×1000 页面核对了入口端口归因、人工推演、零事务覆盖、数据和 valid 的独立显示、声明分支定位及旧记录的只读状态。点选采样沿前后，节点位置和连线路径一致。页面异常为 0，临时服务已停止。[页面核对结果](browser.json)
