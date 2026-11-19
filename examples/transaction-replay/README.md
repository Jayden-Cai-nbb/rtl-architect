# 有限 ready/valid 事务回放

原生回放支持显式 ready/valid 路径的组合旁路、简单单槽、双槽 skid 和已有的级联单槽。采样最多 4096 个连续沿，输入和结果各限 8 MiB。FIFO、仲裁、负载变换、额外 flush、异步复位和跨域保留为能力边界。

## v2 单作用域路径

在 `contract.transactionPaths` 中声明 `schemaVersion: 2`。`semantics` 选 `combinational_bypass`、`registered_single_slot` 或 `registered_skid`。显式给出接口方向对应的 `ingress`、`egress`、字段宽度与来源连接。`fields` 最多六个，含 `data`，每字段 1 到 256 位。启用字段保留完整事务关联。禁用字段声明 `constant`，采样时核对其固定输出。位宽由同一模型解析器核对。

| 路径 | 事务和复位语义 |
| --- | --- |
| 组合旁路 | valid 与负载正向、ready 反向。在同一个 E− 接受并消费，零存储。`resetPolicy: transparent` 时仍核对复位有效期间的传输，采样时钟是观察锚点 |
| 简单单槽 | `ready` 寄存。输出槽在阻塞时保留。空载接收后在 E+ 可见，最早下一沿消费。`resetPolicy: cancel_all` 撤销输出槽在途事务 |
| 双槽 skid | 入口拿到 ready 后，若旧输出受阻，新事务可进入临时槽。恢复时可以消费旧输出，同时在 E+ 将旧临时槽移入输出槽。稳态也可同沿消费旧输出及接受新输入。复位撤销两个有效槽位 |

寄存路径显式引用 `readyState`、槽位的 `validState`、每个启用字段对应的状态和装载分支。每次接受分配新的 `T` 编号。相同整个负载也保留各自编号。`store` 表示进入临时槽，`transfer` 保留编号和全部启用字段。输出阻塞与入口等待分别计数，从复位时丢弃未接受的 offer 也不会产生取消事件。

`schema replay --json` 可查看 v2 映射的 `ports` 和 `states`。键是模型端口或局部状态 ID，值是对应取样列。每个观察角色需有明确的列，包括内部槽位。映射、路径和 `rtlarch-rv-samples-v2` 必须同代。v2 继续使用连续 E−/E+ 字典。寄存路径由 E− 复位决定该沿的更新，E+ 已改变的复位作为观察值保留。入口仍等待时，每个启用字段都要保持。零接受、必需值未知和入口违规分别报告 `COVERAGE_INCOMPLETE`、`UNKNOWN` 和 `ENVIRONMENT_VIOLATION`。

运行 [固定上游九配置入口](../external-axis/benchmark/README.md#运行) 后，各配置的 `*.replay.json`、`evidence/replays` 和 `summary.json` 提供可复跑映射与实际结果。`rtlarch replay --workspace` 可读记录，`rtlarch open --workspace` 后从页面“事务回放”选择场景并定位端口或槽位。

## v1 双单槽样例

下述样例复用 `external-axis` 的固定 MIT 上游双寄存级，采用原有 v1 路径、映射和采样格式。上限为 8 级、256 位数据。它继续维护 REG_TYPE=1 的原行为。

`path.json` 是待加入顶层 `contract.transactionPaths` 的规范性声明。通过现有 `update_contract` 的 preview/commit 添加，不能直接改正在运行项目的模型。旧文件不补该字段，原 hash 不变。声明包含状态对象、装载分支和源码依据，但不带某次仿真记录。`connectionIds` 是结构追溯，不单独证明仿真映射正确。

在临时副本开始：

```bash
work=$(mktemp -d)
cp -R examples/external-axis/. "$work/"
cp examples/transaction-replay/tb_replay.sv examples/transaction-replay/replay-profile.json "$work/"
# 用 path.json 构造 update_contract 提案；preview 后由操作者提交该临时副本。
bin/rtlarch verify "$work/replay-profile.json" --workspace "$work" --json
# 将 mapping.json 的 runId 改为上一步实际 ID，保存于副本。
bin/rtlarch replay "$work/mapping.json" --workspace "$work" --json
bin/rtlarch replay --workspace "$work" --json
bin/rtlarch open --workspace "$work" --json
```

维护入口 `npm run check -- verification` 在临时副本完成声明、preview/commit、真实 Verilator 采集、导入和两种实际 RTL 故障注入，另检查参数位宽、入口保持、有限轨迹和历史版本。可保留一个新临时副本以在页面查看正反例。

```bash
source ./env.sh
npm run build
RTLARCH_REPLAY_WORKSPACE=/tmp/rtlarch-replay-demo npm run check -- verification
bin/rtlarch open --workspace /tmp/rtlarch-replay-demo --json
# 页面打开“事务回放”；结束后停止自己启动的这个服务。
bin/rtlarch stop --workspace /tmp/rtlarch-replay-demo --json
```

指定目录必须尚不存在、直接位于系统临时目录且名称以 rtlarch- 开头；检查拒绝覆盖已有工作区。保留副本最后恢复原始来源并重新采集，故障记录显示 STALE 和原来的 FAILED。

## 格式与事件

这个样例使用 `rtlarch-rv-samples-v1`。两代采样都要求 `clock: {id, edge}` 匹配声明的有效沿，`sampling` 为 `pre_edge_handshake_post_edge_settled`，`rows` 每项为 `{edge,pre,post}`，从 E0 连续编号。pre/post 为显式列名到十进制或 `0x` 字符串的映射。所需值为 X/Z/null、缺失或超宽时返回 UNKNOWN。缺沿或不合法格式拒绝导入。采集者负责沿前采样与 NBA、组合稳定后的沿后记录。

- **accept**：复位无效时入口 E− 的 valid && ready，为每次接受分配独立 T 编号；重复 payload 也不合并身份。
- **visible** 在 E+ 核对本沿进入该级的事务。分别记录 valid 和数据的观察结果。
- **consume**：最后观察点在 E− 的 valid && ready，消费的是该沿前保存的身份，不是同沿新输入。
- **cancel**：复位沿按 cancel_all 撤销在途身份。必须从观察到的复位起步，不能猜初始事务；无效状态的数据不被当作事务。

状态位宽通过所属模块的参数绑定求值。装载分支若是字面常量 0，或被前面的字面常量 1 分支屏蔽，事务路径校验给出 `TRANSACTION_PATH`。状态覆盖分析负责这两类判定。

`event.observation` 记录比较发生的沿前或沿后、valid 的匹配结果，以及有效数据的匹配结果。没有可比较的有效数据时，`data=null`。visible 关联声明中的装载分支，cancel 关联有效状态的同步复位声明。accept 和 consume 按握手记事件。分支关联用于打开模型规则，实际 RTL 选择了哪个分支仍未核验。位置表按声明和握手跟踪事务身份。

入口在 E− 有 valid 且 ready 为 0 时，发送方必须保持 valid 和 payload。回放检查这一沿的 E+，以及随后各沿的 E−，直到入口实际握手或观察到复位。违规返回 `ENVIRONMENT_VIOLATION`，在 `environment.violation` 中记录端口、等待起点、违规沿和取值。该沿起停止路径归因，先前已检查的状态差异继续保留。未知采样单独给出 `sampleIssue`。

`coverage` 统计已检查的前缀。接受按入口握手计数，消费按具有跟踪身份的出口握手计数，取消要求观察到沿后 valid 清零。级内阻塞和恢复按已跟踪且沿前观测匹配的事务去重。入口等待沿数和等待后的恢复握手另外记录。至少接受一笔且核对无差异才可得到 `OBSERVED`，只复位或只等待返回 `COVERAGE_INCOMPLETE`。允许有限轨迹结束时还有在途事务。

## 证据与页面

`replay` 读取 verify 已登记并核对摘要的 simulation 产物，configuration 必须是本次 verify 的输入文件。每次保存独立的 `evidence/replays/<id>/record.json` 和 `result.json`，绑定检查器版本、模型、runId、运行记录、输入闭包和产物摘要。页面和 CLI 按 `createdAt` 选择最近 100 份回放，按关联 runId 核对确切的 verify 记录。

当前检查器为版本 3。旧记录没有版本或与当前检查器版本不同，显示 `STALE` 并保留原结果。已有 v1 合同与模型 hash 保持原值，原 verify 产物仍新鲜时可重新导入，只给出 v1 范围的结果。迁移到 v2 需通过提案新增或替换路径声明，再为当前模型登记包含完整端口及实际槽位观测的 v2 采样和映射。模型、来源或产物变化也会使历史记录过期。结果损坏显示 `UNKNOWN`。

人工推演也可经显式 verify 清单登记手写 JSON，mapping.origin 须标为 `manual`，界面显示 `MANUAL`。仿真采集器及映射由作者声明。`OBSERVED` 表示所采样的有限轨迹通过此次回放核对，形式证明和架构批准各有独立依据。采集成功与回放 `FAILED` 可以同时出现。

页面分别展示状态观测、入口前提、场景覆盖和声明分支。点击沿可将跟踪身份叠加到当前结构图。当前记录可定位声明分支、源码和相关讨论，过期记录保留为只读历史。

本例包含持续 valid 输入、下游阻塞后恢复、在途复位和最后排空。REG_TYPE=1 的实际输入握手之间有空拍。负例仅在临时 vendor 副本中增加一级 valid 延迟，或无视装载条件覆盖 payload。诊断给出事务身份、沿和对应状态。[回放沿革](../../docs/HISTORY.md#2021-的验证与兼容节点)
