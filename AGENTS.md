# RTL Architect 1.0.0

- 先读 README。当前任务是可在本机多个 RTL 项目复用的 skill 与审阅工具，用户指令优先于设计文档。
- `bin/rtlarch` 是统一入口，保留调用方 cwd；技能脚本通过真实路径定位它。机器调用使用 --json；npm run arch 只是兼容入口。
- Node 24.18.1、npm 11.6.2、package-lock 固定，不隐式升级或启动时安装。维护时 source ./env.sh；页面变更后 npm run build。
- 代码位于 src/core、workspace、cli、server、web。核心语义逻辑不依赖 React/HTTP/文件系统；客户端和 UI 共用同一模型与规则，不维护另一套展示语义。
- architecture/model.json 是唯一语义权威。语义修改经 engine 与 API preview/commit，原子写入并检查 base/candidate hash。layout 独立保存。
- 提案登记只写 proposals/registered，不提交或批准。链接必须检查 workspaceId，旧提案不能自动重放；冲突保留原提案并明确重新预览。
- 逐模块确认与整体批准相互独立；语义变化按模块及依赖指纹标记受影响确认，旧记录无指纹时保守失效；整体批准仍绑定完整模型，布局变化不影响确认。handoff 要求当前批准且导出合同内容匹配，不是 RTL 一致性证明。
- Agent 为目标项目做架构或按合同实现 RTL 时使用 .agents/skills/rtl-architect/SKILL.md。不得自动批准真实工作区，不直接写权威模型、确认文件或 generated。
- 每个工作区只允许一个写入服务，不同项目可同时运行。发现服务需核对工作区、协议、工具版本，不能仅信任端口。临时状态存 .rtlarch，运行中不支持外部直接改架构文件。
- 安装通过符号链接引用本工具目录，不覆盖目标项目已有配置或 AGENTS.md。不要把个人安装目录、node_modules 或 .runtime 复制进用户 RTL 项目。
- 按此前要求不恢复 tests/、Vitest/Playwright 配置及项目依赖。维护使用 npm run check（核心与 skill 检查）、build、rtl:test；浏览器验证使用临时环境，结束清理。
- 所有验证的提交/确认均在临时工作区；保护当前根目录的模型和布局。准确报告实际执行结果，不能把历史结果或生成代码称为本轮通过。
- examples/tiny-stream 只验证初始 RTL fixture；examples/packet-pipeline 没有对应 RTL。保留自检 testbench。dist 是运行必需产物，只通过构建更新。
- 不扩展复杂协议、VS Code 插件、MCP、云服务或未要求功能。本轮只保证当前机器使用；不声称跨平台或离线分发验证。

- 已有 RTL 还原按 skill 的 references/as-built.md；不借工具表达缺口填假复位或删物理反馈，不自动修复 RTL/TB。核对输入配置、源码摘要及实际验证阶段。
- 新模型使用 schemaVersion 3；保持既有 1/2 的 hash 与文件不变。provenance 参与差异/hash，as_built、partial、覆盖缺口及未表达结构独立阻断确认/交接，不靠自然语言 openQuestions 兜底。
- signal 允许单驱动扇出及模块反馈，不能声称组合环或 CDC/RDC 证明；rv 保留一对一/无事务环限制。时钟复位真实声明，无复位/纯组合用 null，未知用 timing=unknown。
- inventory 只处理显式清单及哈希，context --offline 只读磁盘；doctor 未启动服务时不能宣称监听可用。不自动迁移或重启其他真实项目服务。

- IR 3 原生数组只支持 1..4096 个同构叶实例；展开计数与节点数区分，all 连接按真实索引校验，不自动清空 partial。单元素修改必须经 set_instance_parameter 预览/提交。
- localSignals 是作用域内部驱动，不能当 RTL 子模块计数；slice 目标按位域检查覆盖与重叠。寄存 sourceText 不是可执行 RTL 语义证明。
- parameterBindings 只做明确 self/parent 整数表达式求值或有类型的直接参数引用，禁止 eval、隐式截断及任意 HDL 解释；示例模板保留旧约束。
- 聚合框图由 IR 生成，连接束保存真实连接 ID；架构视图临时布局不落盘。证据仅按声明路径在工作区内只读预览，核对当前哈希。
- compare 只读候选 A/B，不改变提交 baseHash；先区分候选和当前工作区。新执行与历史验证分别报告，阶段输入齐全不等于验证通过。新增维护检查为 scripts/check-explore.ts，不恢复 tests/。

- 单一主图使用 core/inspection 与 web/graph/scopeDiagram；边界框不参与 RTL 子模块布局。选择、索引、显示分组和局部驱动探索不重建另一份模型，不在检查时自动布局。
- sliceMapping 限于显式数组索引的 stride/offset/width，展开后共用 connectivity 位域检查。请求统一按 UTF-8 预检 8 MiB，超限使用 REQUEST_TOO_LARGE，不隐式截断。
- interfaceGroups 只声明阅读用途；仅显式 configuration/clock_reset 默认折叠，control 不自动隐藏。分组编辑经过语义预览提交。
- evidence.targets 仅说明相关；诊断归因须有 causes 的 issueCodes 与范围匹配。问题列表按需分页，不能仅用 details 隐藏全部 DOM。
- coverage 分开报告实例、端口位域、局部驱动、参数绑定、行为与实际验证；未知源码总量不计算完整率。候选创建版本仅记录新登记时版本，旧记录保持未知。
- typed parameter reference 只沿已声明 self/parent 依赖传播；同名参数不能推断为绑定。表达、检查、上下文共用解析器。
- 维护增加 scripts/check-review.ts 与固定大规模样例。面向人的 Spec、问题及交付文字按 skill references/writing.md，说清行为和影响，工具字段用于追溯，不替代设计说明。

- 阅读入口先呈现设计用途、模块分工和待定问题；完整端口、证据及版本按需展开，推断/未知不能因缩短摘要丢失。
- scopeDiagram 分配分组锚点，orthogonal 绕开模块，route 与 exportSvg 共用路径。图中收起标签须有提示，SVG 保留 partial、版本和折叠范围。不得把显示整理当作覆盖或 RTL 验证。
- scripts/check-reading.ts 验证边界分组隔离、局部节点包容、避障方向和 SVG。浏览器维护仍用临时环境，实际项目只读；工具维护不自动迁移或重启真实项目。

- 阅读整理按 skill references/reading-refinement.md；scripts/check_reading.py 仅保护字段边界，不证明文字等价。补时序/来源与阅读整理分提案，保留旧候选、partial 和全部 provenance。
- 状态相关任务按 references/timing.md 核对接受、可见、消费与真实寄存边界。功能周期、启动间隔及 STA 分开；现有 IR 不含原生波形或自动计拍。派生时序附件带模型版本，不建立第二份权威合同。
- scripts/check-reading-skill.py 使用 Python3 标准库，在临时目录验证允许字段与误改拦截；不将单个示例的周期行为当成通用 RTL 证明。

- 0.8 的 evidence/bundle 为离线只读源操作；输出使用新目录，拒绝覆盖及权威目录/符号链接别名。来源变化不改批准，外部实现与器件证据未核验不得自动判通过。
- reading 仅为带 modelHash 的展示约束，存于独立 layout；保持 IR 1/2/3 的语义 hash。CLI/GUI 共用 arrangeScope、scopeDiagram 和路由；保存布局显式执行。
- scripts/check-delivery.ts 覆盖证据新鲜度、路径保护、离线交付、版本和布局负例。能力与共创方法按 skill 的 design/collaboration/delivery 按需读取；不把 Turbo 参数、数值语义和工具命令写死进共享实现。

- 0.9 框图按 .agents/skills/rtl-architect/references/diagram.md：紧凑模块、四侧端口、实际语义线名；分叉点仅按真实来源端点集合判定。离线页增强同一 SVG，不维护第二套模型或路由。文字与交叉的浏览器审阅不能由几何数字代替。

- 0.10 默认阅读布局只依据声明的 kind/组和真实连接，不从名字推导用途或折叠。无声明端口保留原名和独立身份；自动布局不写 reading 或语义。完整保存位置与显式 reading 优先，空/不完整位置使用共同 arrangeScope。scripts/check-auto-reading.ts 覆盖通用拓扑与误分类负例。

- 1.0 工作记录保存于 architecture/workbench.json，通过服务及 workbenchHash 写入，与 IR/布局/批准分开。Agent 答复不代替用户标记解决；预算修订另存新 ID。
- import-yosys 仅导入明确层级/端口/位连接，保留未知、原位序、来源映射及 partial；import-impact 不是语义等价证明。不要自动执行不明构建脚本。
- verify 只通过显式 CLI 清单执行 argv，在独立 evidence/runs 目录保存输入/报告摘要、版本与结果；不自动批准或修改 IR 验证声明。网页不执行任意命令。
- open 核对源代码、页面构建和服务身份；缺/旧 dist 可构建，不自动安装依赖；旧服务只在显式 --restart 时重启指定工作区。维护源代码后先 build 再运行服务检查。
- 新增 check:milestone 检查边界；check:workflow 从原始通用 RTL 运行 Yosys/Verilator 并测量完整用户路径。继续禁止真实项目自动提交、确认及历史日志冒充本次结果。
