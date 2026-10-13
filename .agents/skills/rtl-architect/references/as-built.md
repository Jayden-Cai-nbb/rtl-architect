# 从已有 RTL 建立现状模型

适用于审阅、文档化和后续优化前的现状还原。工具支持一个有明确范围的 Yosys 展开 JSON 适配器，不直接解析任意 Verilog/SystemVerilog。提取方法应匹配工程规模与语法；针对某项目的正则或静态脚本必须说明支持范围，不能称为通用解析器。

## 先明确构建对象

读项目 AGENTS.md、README、filelist、构建脚本及相关 RTL/TB，确定实际顶层、源文件顺序、include 路径、宏、顶层参数、生成文件和库依赖。配置不明时继续可确认的读取，将影响实例层级的选择交由用户确认。区分模块定义与实例：列出顶层可达类型、实际展开路径、未使用定义。不要仅凭文件名或注释判断调用关系。

可用工程原有编译器的只编译/展开能力交叉核对。编译器不可用时说明静态结果未经过展开；未核对的实例数写 null。无需为架构还原自动安装新工具或执行不明构建脚本。

### 输入摘要工具

准备 `proposals/inputs.json`，文件与目录条目相对目标 workspace；manifest 文件路径本身相对 shell cwd：

```json
{
  "top": "decoder_top",
  "configuration": "源码默认参数，未设置宏",
  "parameters": {},
  "defines": [],
  "includeDirs": ["rtl"],
  "files": ["rtl/decoder_top.sv", "rtl/memory.sv", "tb/tb_decoder.sv", "filelist.f"],
  "assets": [{"path":"data/rom.hex","stages":["simulation"]}, {"path":"data/golden.hex","stages":["simulation"]}]
}
```

列表按实际项目填写，不要求这些示例文件存在。保留编译文件顺序。将 filelist、被引用的 include 文件、宏配置和实际参与构建的生成文件纳入 files；未使用配置文件不要当成有效宏来源。assets 记录当前验证所需 ROM/向量；没有需要时为空数组。files/assets 可以使用字符串（保守计入两个阶段），或 `{path,stages:["compile","simulation"]}`。准确区分仿真时读取数据与编译/展开期必须存在的文件，不能假定所有 ROM 仅用于仿真。

```bash
rtlarch inventory proposals/inputs.json --workspace <项目> --json
```

输出每个显式文件的 SHA-256 和 sourceDigest，不要求已有模型，不创建目录，不启动服务。保存输出到 proposals/evidence 下作为附件。缺失输入时退出非零，仍输出缺失条目与摘要；存在全部文件也不意味着编译或仿真通过。compileInputsAvailable / simulationInputsAvailable 仅说明对应清单依赖齐全，不是 compileReady/simulationReady 或运行通过。它不会自动展开 filelist、发现 include/$readmemh、验证 HDL 表达式或执行测试。

sourceDigest 纳入配置、文件顺序、文件内容和缺失状态。生成候选前后重跑并比较，变化则重新读取相关源码并生成新提案。模型中的摘要和 evidence 是声明，运行时不会自动读取工程文件或检测源码变化；旧候选不会自动更新。

## 优先复用可核对的展开结构

工程可以生成 Yosys `write_json` 时，保留层级、实际顶层和配置，使用 `import-yosys <manifest.json> <新目录>`；适配器不执行展开命令。manifest 含 schemaVersion=1、top、netlist、files 和 configuration，文件相对 workspace，完整例子见 [原始 RTL 样例](../../../../examples/rtl-intake/README.md)。将宏/include/参数配置等依赖也纳入 files。先核对工程语法、库和展开支持，不能为了适配器改变原 RTL。

输出 model.json 与 import.json：实例 ID 按路径稳定生成，来源 src 属性映射到实例，单向端口与可确定的位级连线/常量进入 IR。原位序 offset/upto/signed 和 RTL 名留在映射。双向、未知/多驱动、内部运算、存储行为及周期仍列缺口；参数二进制保留字符串，不猜 signed。最多 4096 个层级实例，整个输出仍为 as_built / partial，未核对展开输入与源码对应关系前不能消除该未知。

更新源码先 `import-impact <import.json>`：显示直接映射到的重核范围，缺映射、展开 JSON 或未映射配置变化则保守扩大。重新展开到新 JSON、导入新目录、compare/draft 新旧候选；影响报告不是语义等价证明。不要自动把旧职责、组、合同覆盖到新端口上；按稳定 ID 对齐后复核受影响部分。没有展开器时继续受限静态还原，明确未核对范围。

## 还原事实及参数环境

以实际代码和展开结果描述现状；注释说明意图，TB 描述验证假设，实测日志描述实际结果。不同来源冲突时分别记录，不能借此自行修复 RTL。每项重要发现关联文件、行、符号、文件哈希与 sourceKind，并标为 fact / inference / unknown / conflict。

参数记录声明默认值、实例覆盖表达式、实际求值、位宽/signed 以及所在实例路径。追踪参数是否向下传递；顶层同名参数不意味着子模块受控。未传播、固定常量、未使用输入应列入 findings。原始表达式及参数审计可放附件，正式行为与发现保存在 IR；可显式建立受限整数 parameterBindings，不能把工具求值当成 HDL elaboration。

普通 JSON 数值仅支持安全整数。宽常量在局部驱动中用 `{kind:"constant",width:8192,value:"0x..."}`；接口宽度和参数绑定使用 [进阶建模](advanced-modeling.md) 的受限表达式。只有明确记录的绑定会自动传播；同名参数、固定位宽、RTL 中未建模的表达式不会自动关联。涉及 signed、隐式截断或未支持运算时保留原表达式和限制，先按工程工具求值。

## 时钟与复位

先按 [时序方法](timing.md) 追踪一笔事务的接收、寄存、可见与消费，并核对 TB 采样时刻。下面只规定结构字段；正常/阻塞/复位的逐拍推导及物理约束按该方法记录。已存在但难读的候选另走 [阅读整理](reading-refinement.md)，不要把补时序或补证据混入纯文字整理。

- 同步/异步由实际 always 事件和条件核实，不用合同文字覆盖错误结构字段。
- 异步复位：`synchronous:false`、真实 activeLevel，deassertion 记为 synchronous / asynchronous / unknown。`posedge clk or negedge rst_n` 说明异步置位；仅凭事件列表不能断言外部释放同步化。未知释放会阻断确认。
- RAM 有 clock、无 reset 时用 `reset:null`；纯组合模块用 `timing:combinational, clock:null, reset:null`。
- 未核对时用 timing=unknown，不能把 null 当成已经证实无时钟/复位。混合模块用 mixed；合同分别说明控制状态、数据阵列、帧初始化的覆盖。
- 包装层只有复位门控输入、内部状态/RAM 无复位时，reset=null，resetControlInputs 列出对应真实输入端口；合同明确控制用途，不能凭端口名绑定状态复位。
- 多时钟模块/跨时钟连接目前不能完整表达，不强塞成单一域；保留限制与 partial。

## 连接、反馈和重复实例

signal 是普通单向信号，允许一个发送端连接多个接收端，接收端仍限制单驱动。不同信号可构成 mem→pro→mem 的模块反馈；工具不会把它当成已证明的组合环，也不会证明不存在组合环。rv 保留一对一、无事务环的产品限制；含 last/配置旁带的完整协议不能假装为单个 rv。

层级边界反转发生在 scope 内，只连接父边界与直属子模块。保留完整双向物理信号，不为“画成 DAG”删反馈或制造流水级。

优先用 instances、端点 slice、localSignals、parameterBindings 表达工具支持的真实结构，见 [进阶建模](advanced-modeling.md)。assign 和作用域内寄存驱动不是 RTL 子模块，不制造 fake logic 实例，也不能把父层输出直接当内部 source。未覆盖的表达式继续保留 ledger 与 unsupportedStructures，targets 只关联相关端口与证据；确认原因后用 causes 明确诊断代码、端口和索引/位域范围。模型接口缺线不等于 RTL 悬空。

已核对的一维同构叶实例优先原生数组折叠、共享合同、按索引查询和覆盖参数；计数含数组展开。原生数组不能自动消除连线或行为缺口。尚不适用数组表示时可选择代表实例供初步探索，但必须记录真实路径、索引范围及省略数量，fidelity=partial。coverage.representedInstances 只计真正建模的实例（含顶层），不能因一个 z=0 图块就算覆盖256个实例；模型节点与连接数由 IR 计算。完整实例路径清单放证据附件，不复制成千份合同来绕过数组缺口。

## 让状态与事务进入主图

实例树正确仍可能看不懂设计。沿一笔事务找到真实状态所有者，把作用域内流水寄存器记录为 localSignals.register，保留 sourceText 和来源；不要造出仅为排版服务的“阶段模块”代替实际层级。同步存储的内部数据/地址/控制可能与外部控制寄存器在同一沿更新，不能根据教科书外观再加一个数据寄存级。

packed 状态可保持一个框，以切片追溯字段。inputs 仅记录已知读取集合；没有字段级写入映射时，明确它不是精确组合锥。无法表达的 mux/比较/移位继续留缺口，不把组合运算假装为 register 来获得绘图节点。先满足主路径和关键反馈可解释，再补影响本次问题的局部逻辑；未导入处能查到源码。

## 验证可用性与实际结果

先检查 TB 所引用的模块名、端口、参数和 DUT 版本是否匹配，再检查 ROM、golden、生成脚本、路径假设和超时/自检机制。编译产物放临时目录或用户指定构建目录，保留命令、工具版本、退出码和必要日志。还原任务不修改 RTL/TB，不补造 ROM/golden 让测试显得通过；若用户另行授权修复，应明确作为独立变更。

分别记录 compile、elaboration、lint、simulation、synthesis、timing、formal 的 passed / failed / not_run / blocked。passed/failed 需要命令与日志证据。新执行记录填写 target（如 tb_PE）、executedAt（真实 ISO 时间）、sourceDigest、tool={name,version}、batchId。引用旧记录保留原时间/摘要/批次，未知时间不编造；本轮仅改模型时不能将旧编译记为本轮通过。缺依赖时标 blocked 并列出依赖；不适用或未安排的阶段用 not_run。TB 内的 PASS 字符串、测试时钟周期和编译退出0都不能证明功能或硬件频率。

## 输出和后续优化

首份候选同步按 [框图阅读设计](diagram.md) 整理有证据的接口组并生成默认布局。覆盖所有交付层级；用顶层与最复杂子层样稿验证，再沿一笔事务讲解。布局改进不能代替缺失的 RTL 连接或业务证据。

通过 schemaVersion 3 的 provenance 保存范围、配置、摘要、覆盖、发现、证据、表达限制及验证记录；字段详见 proposal-guide 与实际 Schema。origin=as_built 即便声明 exact 也仅供还原审阅；partial、未知覆盖或 unsupportedStructures 分别独立阻断实现交接。

先交付可浏览的现状链接及证据，再讨论优化。用户要求优化时，保留当前基线和源码证据，用增量提案解释目标、约束、权衡及预期影响。性能提升未实测时写作假设。进入实现阶段须形成范围明确、已解决表达缺口的 design 方案并重新人工审阅；不能仅改标记解除限制。

对旧版候选的迁移也生成新提案：核对真实时钟/复位，添加 provenance，补回现在能表达的 signal 反馈/扇出。不要直接改旧登记文件，也不要把旧仿真结论套到新架构。交付报告包含候选 hash、sourceDigest、实例及连接覆盖、限制和各验证阶段结果。

迁移前先比对 context 的已提交模型与待修订候选。候选 A/B 用 compare，只读差异不改变 baseHash。未提交过的候选按完整模型再次 draft，提交基线仍是工作区当前版本。迁移应同步更正合同、总述、coverage 和 unsupportedStructures 的过时描述；参数/连接数量变化不是完整性证明。


## 交付前的两次核对

先核对表达：这次是完整迁移还是限定试用，数组哪些索引、端口哪些位域已导入，哪些内部状态和参数绑定未记录。估计规则条数、展开实例/连接数量和请求字节数；等步长切片用 sliceMapping。总量未知就写未知。issues 中“模型未连”不能直接翻译成“RTL悬空”；targets 关联与 causes 因果范围分开。

再核对阅读：主图能辨认真实模块及请求/返回/写回；边界在外框，LLR配置等同用途端口可分组但保留逐项映射。检查数组123时的切片、参数、广播和缺口要与同一索引对应。折叠时钟、配置或内部逻辑后仍有入口和数量；完整模块名和层级路径可读。若实际没有运行页面，把这项标为未验证，不用节点数减少代替可读性验收。

生成的职责/问题按 [表达方式](writing.md) 写。源码证据、完整hash和原始命令放结构化记录；不把审计账本逐句塞进行为合同。
