# 有限 ready/valid 事务回放

复用 `external-axis` 的固定 MIT 上游双寄存级，不改原模型或 vendor 文件。首版只支持一个显式时钟域、同步复位、有序且 payload 不变的路径，每级一个保存槽（最多 8 级、256 位、4096 个连续沿，输入/结果各限 8 MiB）。不支持旁路、skid/FIFO 多槽、仲裁、数据变换、flush、异步复位和跨域；不能用于任意 RTL 自动计拍或完整时序证明。

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

维护入口 `npm run check:transaction-replay` 在临时副本完成声明、preview/commit、真实 Verilator 采集、导入和两种实际 RTL 故障注入。原始模型/布局/vendor 不动，不批准项目。要直接打开包含正反例的可运行演示，可保留一个新临时副本：

```bash
source ./env.sh
npm run build
RTLARCH_REPLAY_WORKSPACE=/tmp/rtlarch-replay-demo npm run check:transaction-replay
bin/rtlarch open --workspace /tmp/rtlarch-replay-demo --json
# 页面打开“事务回放”；结束后停止自己启动的这个服务。
bin/rtlarch stop --workspace /tmp/rtlarch-replay-demo --json
```

指定目录必须尚不存在、直接位于系统临时目录且名称以 rtlarch- 开头；检查拒绝覆盖已有工作区。保留副本最后恢复原始来源并重新采集，故障记录显示 STALE 和原来的 FAILED。

## 格式与事件

仿真产物只接受 `rtlarch-rv-samples-v1` JSON：`clock: {id, edge}` 必须匹配模型时钟及 rising/falling 有效沿；`sampling` 必须是 `pre_edge_handshake_post_edge_settled`，`rows` 每项为 `{edge,pre,post}`；edge 从 0 连续编号。pre/post 为显式列名到十进制或 `0x` 字符串的映射。X/Z/null、缺失列和超宽值产生 UNKNOWN，后续不推测；缺沿或不合法格式拒绝导入。观察点映射还需写 model.moduleId/data/valid/ready，检查真实接口、方向和位宽。时钟 ID 和有效边沿同时核对声明与产物，采集者负责在这个沿前采样、NBA 与组合稳定后记录 post，工具不分析模拟器调度。

- **accept**：复位无效时入口 E− 的 valid && ready，为每次接受分配独立 T 编号；重复 payload 也不合并身份。
- **visible**：声明所期望的级内新事务在 E+ 可见，逐项与实际 post 的 valid/payload 核对；不符标记 matched=false 并保留诊断。它不等于下游已经消费。
- **consume**：最后观察点在 E− 的 valid && ready，消费的是该沿前保存的身份，不是同沿新输入。
- **cancel**：复位沿按 cancel_all 撤销在途身份。必须从观察到的复位起步，不能猜初始事务；无效状态的数据不被当作事务。

阻塞时核对已接受事务的 payload 和 valid，保留具体事务、E−/E+ 和 data/valid 状态对象。位置表是按声明及握手跟踪的期望身份；不是从 RTL 自动提取的硬件标签。消费不推断更新分支；其余事件的分支是显式声明关联，点击可核对同源 register.update 表，不声称 RTL 自动分支覆盖。

## 证据与页面

`replay` 只读取 verify 已登记并核对摘要的 simulation 产物；configuration 必须是本次 verify 的输入文件。独立保存 `evidence/replays/<id>/record.json` 与派生 `result.json`，绑定 modelHash、runId、产物摘要、run.json 摘要、mapping/configuration；sourceDigest 是 **verify 声明输入闭包的摘要**，与模型 provenance 中的源码摘要含义区分。新鲜度复用 verify，输入、产物或模型变化后显示 STALE。结果文件损坏显示 UNKNOWN，旧 FAILED 不因最新成功消失。

人工推演也可经显式 verify 清单登记一个手写 JSON 产物，但 mapping.origin 必须标 `manual`，界面始终显示 MANUAL；包装/复制文件的 verify 命令成功不代表仿真。仿真采集器及映射由作者声明，工具不会从命令名字认证来源。`OBSERVED` 仅表示该轨迹未发现违反此有限合同，不升级 assurance、批准或原模型验证声明。采集命令通过与事务核对 FAILED 可以同时存在。

页面“事务回放”展示逐拍事件、阻塞和跟踪位置；点击沿把在途身份叠加到当前结构图，点击事件高亮模块。普通回放不布局、不编辑硬件。事件可打开关联分支、已有源码证据和同模块讨论；过期或候选记录禁用当前结构定位。讨论按模块和模型版本关联，不假装已有逐事务讨论 ID。没有自动播放时钟或通用波形解析器。

本例场景：持续提供输入、下游阻塞后恢复、在途复位、最后排空。REG_TYPE=1 本身插入空拍，“连续输入”是持续 valid，不声称每拍接受。负例仅在临时 vendor 副本中增加一级 valid 延迟，或无视装载条件覆盖 payload；均要求诊断包含事务身份、沿和状态。
