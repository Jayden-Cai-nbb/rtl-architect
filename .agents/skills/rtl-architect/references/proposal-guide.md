# 当前 IR 与提案约定

以 `rtlarch schema` 返回值为准，类型与验证实现在 src/core/schema.ts 和 src/core/engine.ts。

## 模型

- schemaVersion：新模型使用 3；兼容读取既有 1/2，加载不会自动改文件或改变其 hash。
- design：id、name、top；modules 为数组，稳定 id 与可修改 name 分离，只存 parent。
- kind：subsystem（唯一可含子模块）、module、memory、compute、controller；fifo/add_const 是保留原行为限制的示例模板。
- 通用 parameters 为安全整数、布尔或字符串；超出安全整数范围的宽常量用字符串。width 为 1..65536 的整数，或 `{ "param": "当前模块参数名" }`，参数必须解析成该范围整数；也可用 `{ "expr": "DATA_W * LANES" }` 的受限整数表达式。数组、参数绑定、局部驱动详见 [进阶建模](advanced-modeling.md)，不等同完整 HDL 求值。
- interfaces：id、role=producer/consumer、protocol=rv/signal、width、required；可选 group 关联 interfaceGroups 的业务标签与类别，详细约定见进阶建模。rv 聚合 data/valid/ready；signal 为单向逻辑信号。不宣称支持 AXI/TileLink/CHI，不插入隐式适配器。时钟/复位绑定单独保存在模块声明。
- clocks 显式声明 id、edge=rising/falling。resets 声明 id、clock、activeLevel=low/high、synchronous=true/false；异步复位补 deassertion=synchronous/asynchronous/unknown（未知阻断确认）。同步复位的 clock 不能为 null。模块 clock/reset 可为 null，表示无；timing=sequential/combinational/mixed/unknown，无 clock 必须明确 timing。纯组合模块 clock/reset 均为 null。未知状态用 timing=unknown 并保留合同说明。fifo/add_const 示例仍要求上升沿、同步低有效复位。
- contract：responsibility、latencyMinCycles、latencyCondition、backpressure、resetBehavior、invariants[]、verificationPlan[]、openQuestions[]。计拍起止、结果可见/消费、启动间隔与阻塞条件按 [时序方法](timing.md) 填写；未知下界、逐拍附件及物理时序的表达限制也见该文，不向 Schema 添加自定义时序字段。
- specification：summary、requirements[]、decisions[]、openQuestions[]。需求字段 id/text/moduleIds/acceptance；决策字段 id/text/moduleIds/rationale。moduleIds 引用必须存在。

完整且可直接校验的多层 128 位示例见 [packet-pipeline](../../../../examples/packet-pipeline/model.json)。它没有对应行为 RTL，不是已批准设计。

## 层级连接

connection 为 `{id, scope, from:{moduleId,interfaceId}, to:{moduleId,interfaceId}}`。scope 只能连接自身边界与直属子模块，不能跳到孙模块。

当前 scope 的 consumer 在内部是 source，producer 在内部是 target；子模块 producer 为 source，consumer 为 target。同一个边界接口在父/子 scope 各出现一次合法。rv 保留一对一及无事务环限制，属于工具能力边界，不是组合环证明。signal 可单驱动扇出，允许模块反馈；所有接收端均禁止多驱动。不同非空 clock 的端点不能直连，rv 还要求复位一致；无时钟组合路径不做跨域追踪或 CDC/RDC 证明。signal 支持显式位域、局部拼接/常量驱动，见进阶建模；不插入隐式适配器。

## 来源与覆盖（schemaVersion 3）

现有 RTL 必填 provenance；新设计无源码输入时可省略。对象字段如下，无自动默认值：

| 字段 | 内容 |
|---|---|
| origin | as_built（现状还原）或 design（设计方案） |
| fidelity | partial 或 exact；声明而非工具证明 |
| scope / configuration | 建模边界、展开配置，非空字符串 |
| sourceDigest | inventory 输出的实际输入摘要，64位小写 SHA-256 |
| coverage | elaboratedInstances: 正整数或 null；representedInstances: 正整数（实际模型实例含顶层） |
| evidence[] | id, file, fileHash, sourceKind=code/comment/test/measurement/report；可选 line/endLine/symbol/targets |
| findings[] | id, classification=fact/inference/unknown/conflict, moduleIds[], text, evidenceIds[] |
| unsupportedStructures[] | id, kind, moduleIds[], description, evidenceIds[], 可选 targets |
| verification[] | stage=compile/elaboration/lint/simulation/synthesis/timing/formal, status=passed/failed/not_run/blocked, command, detail, evidenceIds[]；可选 target/executedAt/sourceDigest/tool/batchId |

file 可以是源码或证据附件的项目相对路径，fileHash 对应该文件真实字节。evidenceIds 必须引用已声明证据；moduleIds 必须存在，空数组表示全局。事实和冲突缺证据阻断确认；unknown/conflict 未解决时同样阻断。passed/failed 必须有命令及日志证据。记录真实性由审阅负责。点击证据时只读取工作区内已声明路径，核对当前文件哈希；不同或缺失会提示，不能据此改写历史证据。不会后台监测源码。

as_built、partial、实例覆盖不全/未核对、未表达结构各自独立阻断确认和实现合同，不靠普通 openQuestions 充当唯一保护。转为设计方案须通过新提案说明意图和覆盖依据；不要删除来源记录来绕过限制。coverage 不是门级、行为或连线完整性证明。

## 增量命令

Proposal：`{baseHash, reason, commands:[...]}`。baseHash 必须来自当前 API，不能用占位符。

| op | 字段 |
|---|---|
| set_parameter | moduleId, key, value（绑定参数须先移除绑定） |
| set_parameter_binding | moduleId, key, binding={scope:"self"或"parent",expression} 或 null；准确形状见进阶示例 |
| update_instance_array | moduleId, instances（完整数组声明）或 null |
| set_instance_parameter | moduleId, index, key, value |
| update_local_signals | localSignals（完整数组） |
| rename_module | moduleId, name |
| update_contract | moduleId, contract（完整对象） |
| update_interface_groups | moduleId, groups（完整 interfaceGroups 数组） |
| update_interfaces | moduleId, interfaces（完整数组） |
| update_specification | specification（完整对象） |
| update_provenance | provenance（完整对象） |
| update_domains | clocks、resets（完整数组） |
| update_module_timing | moduleId、clock、reset、timing |
| create_module | id, parent, template（kind 之一） |
| define_module | module（完整模块对象，可包含自定义参数/接口） |
| delete_module | moduleId（叶模块或空子系统，不能删顶层） |
| connect | connection |
| disconnect | connectionId |
| replace_architecture | model（完整候选模型） |

替换整个架构同样需要 baseHash、候选预览、语义差异和用户提交，不绕过校验。增量批次顺序执行，最后统一验证；可在同批调整关联宽度、断开与重接，不能部分落盘。

required 未连接、合同描述缺失、未决问题或需求缺少验收条件允许保存草稿，但阻断确认。非法引用、层级、参数、位宽、方向、域、rv 扇出、多驱动等阻断提交。

## 常用命令

```bash
rtlarch open --workspace <项目> --json
rtlarch resume --workspace <项目> --json
rtlarch context
rtlarch schema
rtlarch draft proposals/design.json proposals/proposal.json --workspace <项目> --open --json
rtlarch propose proposals/proposal.json --workspace <项目> --open --json
rtlarch spec processing
rtlarch handoff compute
```

`draft` 不覆盖已存在提案文件。输入/显式输出路径相对于当前 shell 目录；未指定输出时写到目标工作区 proposals/。除 schema / compare / study 外，命令应指定 --workspace；--json 返回单个 JSON 对象。spec 是当前 IR 的确定性派生；候选 spec 可在 GUI 候选框图的 Spec 面板查看。带 --open 的 draft 或 propose 会登记提案并返回 reviewUrl；链接打开候选框图，仍需人提交和确认。登记文件位于 proposals/registered/，不要手改。


## 错误与恢复

| 错误 | 处理 |
|---|---|
| WORKSPACE_MISMATCH | 核对返回路径与目标项目，不改连其他服务。 |
| VERSION_MISMATCH | 用户要继续此项目审阅时执行 stop/start，再 proposals 找回链接；仅维护工具不重启真实项目。 |
| SERVICE_PERMISSION_DENIED | 按当前环境权限流程处理；等待期间可以 inventory/schema/context --offline。 |
| VERSION_CONFLICT | 保留原提案，读取新基线和差异，再显式重新预览。 |
| MODEL_INVALID / SCHEMA_INVALID | 修正模型；不为通过校验而改写源码事实。 |
| REQUEST_TOO_LARGE | 核对 actualBytes/limitBytes，使用数组规则减少重复连接；不盲目重发或继续放大上限。 |
| INPUTS_UNAVAILABLE | 查看各阶段缺失输入，清单齐全也不等于运行成功。 |
| REVIEW_REQUIRED / CONTRACT_OUTDATED | 说明缺少的确认或合同导出，不伪造记录。 |

同一错误无新证据时不重复尝试。旧登记文件不手改，恢复用 `rtlarch proposals --workspace <项目> --json`。

## 只读核验与离线交付（0.8）

- `rtlarch evidence --workspace <项目> --json`：批量核对已声明证据；有变化/缺失返回 EVIDENCE_ATTENTION，无证据返回 EVIDENCE_UNKNOWN。均非零退出，不修改批准。
- `rtlarch bundle <新目录> --workspace <项目> --json`：导出当前模型的离线成果入口；不启动服务、不写权威文件。候选加 `--model <完整模型.json>`，展示布局加 `--layout <布局.json>`。
- `rtlarch schema layout --json`：查询展示布局及可选 reading 格式。过期约束返回 LAYOUT_OUTDATED；图形硬错误返回 DIAGRAM_QUALITY_FAILED，诊断包保留；已有目录不覆盖。

路径参数相对调用 cwd。成果入口、四种状态与证据保存方法见 [证据与交付](delivery.md)。只读导出成功不代表来源全部新鲜或实现验收通过。

宿主命令执行、工具环境、工作区服务与 RTL 检查是不同故障层。命令尚未开始或长时间无返回时，不宣称已运行，也不盲目并行重试；按环境权限流程处理，保留已完成步骤，继续读取已有文件或离线说明。不能修改系统挂载来绕开宿主故障。

持续讨论、预算、显式验证与按影响复核见 [持续工作](workbench.md)。讨论动作必须走服务，以 workbenchHash 并发控制；不是修改 Model 的新命令。
