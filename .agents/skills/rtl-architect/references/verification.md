# 从行为承诺到当前证据

架构解释仍是入口。选出本次修改最重要、能被反例推翻的一项承诺，再决定检查方式；不要为了数量给每个模块堆断言。与用户说明承诺、触发场景、失败影响及尚未覆盖的部分。复用项目自检，不自动改 RTL 让检查“变绿”。

## 先少读，再精读

`resume --offline` 获取继续位置与未解决讨论；`context-index --offline --limit 30` 获取模块导航。局部任务用 `context --module ID --purpose design|review|implementation|debug --max-bytes 12000 --offline --json`。预算按 UTF-8 字节计，不是精确 token 数。索引按 offset 分页；局部上下文优先相应任务的信息，省略项有计数和完整读取入口。自身合同、需求、问题和未知不截断，装不下就报错并要求扩大预算。实现仍需当前 handoff，精简上下文不代替授权或完整依赖阅读。

`compare` / 提案预览给出字段差异与影响模块：DIRECT 是模块自身变化，POTENTIAL 是已声明依赖变化。检查关联验证义务与原验证计划；自然语言计划没有可执行映射时保持未知。不能从 DEPTH、fifo 等名字推断时序或影响，也不能用局部影响报告豁免其他验证。

## 有限的可执行义务

IR 3 的 `contract.obligations` 可选，经过正常提案保存。`schema model` 给出精确类型。现有自然语言合同保留，不自动转换任意文字为断言。

| kind | 模型字段 | 明确语义 |
|---|---|---|
| ready_valid_stability | interfaceId（rv producer） | 上次采样 valid=1 且 ready=0，下一非复位采样须保持 valid/data；至少实际观察一次保持场景 |
| reset_flush | interfaceId（rv producer） | 同步复位至少采样一次，首个非复位采样沿 valid=0；不等价于证明所有内部状态复位 |
| fifo_ordering | inputInterfaceId、outputInterfaceId、capacity、completion=drained_test_end | 对接受的数据记账，比较每次输出的顺序/载荷，检查容量；复位取消在途项，测试结束须排空且至少输出一次 |

每项包含 id、description，可用 requirementIds 关联真实需求。FIFO 模板只适合等宽、原样传递的数据，不能用于加法或编码路径。capacity 允许已有整数参数/表达式；不会从模块名猜容量。

先 `schema checks`，再写显式绑定：testbench，moduleId/obligationId，instancePath，clock/reset，interfaces 的 data/valid/ready RTL 引脚。`checks bindings.json <新目录>` 从当前保存模型生成 checks.sv 与 checks.json；在 TB 显式实例化 `rtlarch_contract_checks checks();`。当前只支持普通标识符路径、单实例、同域同步复位。数组、异步复位、跨域不生成近似替代。采样在时序 NBA 更新前，TB 在非采样沿驱动。生成物是仿真监视器，不是通用 SVA 或形式证明。

按 `schema verification` 写清单：stage=simulation，inputs 包含全部 RTL、include、脚本、TB、ROM/向量、配置及生成的 checks.sv/checks.json。加入 `checks: [{kind:"obligations",file:"step-1.stdout.log",metadata:"checks/checks.json"}]`，file 指实际仿真步骤日志。编译和运行均成功且监视器实际被触发才通过。无触发、未复位或测试未排空会失败；不要删除监视器换成单纯 contains PASS。改变模型需生成新检查目录并更新 inputs。

`inputClosure: {status:"declared_complete",note:"实际依赖与配置依据"}` 是作者对输入闭包的声明；不知道就 partial 或不填。它不自动发现隐式文件或环境。外部工具提供 versionArgs；本次 runDir 内构建出的可执行程序保存摘要。环境影响结果时把配置固化到清单输入，不能靠声明完整掩盖未知依赖。

至少做一个针对义务的故障注入，确认错误会失败；正常结果不能单独证明检查器有效。通用可运行例子见工具 `examples/contract-checks`，维护验收为 `check:assurance`。

## RTL 结构比较

`verify` 以 stage=elaboration 显式运行 Yosys，使用 artifact 检查保存本次 write_json 产物。`schema conformance` → 显式映射 → `conform mapping.json`：runId 必须指这次展开；instancePath 是相对 top 的实例名称数组，顶层为 []。参数、逻辑接口到 RTL 引脚、clock/reset 均显式映射。

检查模块类型、相邻父子路径、非负整数参数、端口宽度/方向、同作用域逐位连接及已映射同域控制线。保留 ready 反向及切片顺序。未映射、数组、黑盒、复杂内部逻辑、符号/字符串参数编码不明确时 UNKNOWN；不把跨模块的 Yosys net ID 当同一网络。报告只适用于 scope.mappedModules，不代表整个设计。

MATCH / MISMATCH / UNKNOWN 与来源新鲜度一起读。缺当前模型、源码、报告摘要、成功展开、工具版本或完整输入声明时不判 MATCH。人工写出的 JSON、旧展开报告不能冒充当前 RTL 一致性证据。执行清单仍需读懂，不自动执行陌生构建脚本。结构匹配不证明行为、时序、CDC/RDC 或综合后等价。

## 交付看三项状态

`assurance [--module ID] --json`，或模块详情“行为约定 → 核验状态”，分别呈现：

- 架构审阅：本地记录，未认证 reviewer 身份；不能称作独立受保护的人类批准。
- RTL 结构：最新相关报告与当前生产输入重新核对；未比较就是未运行。
- 行为：逐义务呈现通过、最新运行失败、过期、证据不足或未运行。运行失败不擅自归因到某一义务；较早通过不能盖住新失败。

当前最多读取最近 100 次运行/结构报告；源码、TB、生成器输入或模型变化会失效。候选不借用保存版本证据。handoff 仍只说明架构审阅和导出合同符合交接条件。报告未覆盖的义务、场景、STA/formal 与器件验收，不能给出一个概括所有维度的绿色通过标记。
