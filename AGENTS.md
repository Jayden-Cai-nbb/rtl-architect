# RTL Architect 维护约定

先读 [README.md](README.md)。用户指令优先。研究或改变工具行为时查 [架构设计](docs/ARCHITECTURE.md) 与相关代码，交付操作查 [使用说明](docs/USER-GUIDE.md)，报告实际结果查 [验证入口](VALIDATION.md)。

此目录是源码与 Git 开发入口。维护、提交和 WSL 用户级安装均从这里执行。`npm run release` 生成的带版本目录是交付快照。

## 工作区与入口

- 对 `/home/cjjnbb/projects/` 内的 RTL 设计、验证、综合和时序任务，先读 `/home/cjjnbb/projects/AGENTS.md`、目标工程规则与 README，再按 `rtl-common` 选择环境和规范。工具维护遵循本仓库约定。
- `bin/rtlarch` 是统一入口，保留调用者 cwd，机器调用带 `--json`。`npm run arch` 是兼容入口。为其他工程工作时读 [.agents/skills/rtl-architect/SKILL.md](.agents/skills/rtl-architect/SKILL.md)，以真实路径定位工具。
- 维护先 `source ./env.sh`。固定 Node 24.18.1、npm 11.6.2 和锁文件。构建生成 `dist/`。启动时禁止隐式安装依赖。安装用符号链接，保留用户已有配置和 AGENTS.md。
- 每项目一个写入服务。核对工作区、协议、版本与构建身份，端口只用于连接。`open --restart` 须显式指定目标，维护不得迁移、停止或重启其他真实工程。在线时外部禁止直写架构文件。

## 模型、提案和审阅

- `architecture/model.json` 是唯一语义权威。新模型用 IR 3，既有 IR 1/2 的文件和 hash 保持兼容。layout、讨论、预算、批准及派生合同分别保存，UI 和 CLI 使用同一 core 语义。
- 语义编辑经 engine 和服务 preview/commit，核对 workspaceId、baseHash 和 candidateHash，原子保存。proposals/registered 只登记候选。旧提案与冲突保留原样，重新预览须显式执行。
- Agent 不自动提交、确认或批准真实工作区，不直写模型、确认文件或 generated。逐模块确认跟随依赖指纹，整体批准绑定完整模型。handoff 还要核对当前导出合同。验证过程中的提交、批准和故障注入仅在临时工作区。
- 已有 RTL 按 skill 的现状还原约定核对源码、配置与证据。`as_built`、`partial`、覆盖缺口和未表达结构独立保留。禁止用虚构复位、删反馈、自然语言备注或变更测试来消除阻断。
- 结构与更新语义由显式声明决定。按工作区配置解析位宽、位域、类型、数组和时序。禁止执行 sourceText 或任意 HDL 求值。表达式数值类型、原始成员关系和兼容规则见架构设计。

## 图形与证据

- `scopeDiagram`、阅读投影、质量检查与导出共用结构和路由。显式约束保留应用结果，聚合保留全部原始成员及关系。禁止按名称推断协议、借隐藏标签或删边改善指标。普通选择只影响详情与样式，追踪范围由用户显式调整。
- SelectionRef、讨论、checkpoint 与图使用同一版本和对象身份。讨论答复、候选选择、布局和预算是独立记录。旧对象或候选失效后须显式核对；预算修订另存。
- `verify` 仅执行显式 argv 清单并保存运行及输入摘要。网页只读证据和运行记录。登记完整输入闭包由作者负责。源配置展开只通过 `elaborationInputs` 显式复用，保留生产运行和比较模型各自版本。
- 当前失败、未知、历史与过期分别呈现。状态证据按每个更新聚合。比较器和回放检查器升级使旧记录过期。几何、人工阅读、有限仿真、二态单步比较、器件和需求验收各有分母与依据。
- 先查询回放能力。RAM FIFO 和帧回放为 UNSUPPORTED，使用独立仿真。显式阅读路径保留 gapId。覆盖、环境前提、关联和观察结果分开。源证据只在工作区内读，先核对 hash；输出使用新目录。

## 验证与发布

- 核心维护使用 `npm run build`、`npm run check`。分组和外部基准见 [VALIDATION.md](VALIDATION.md)。初始 tiny-stream 自检和超时负例由工作流组运行，`npm run rtl:test` 可单独复跑。
- 固定上游测试、RTL、许可证及冻结验收配置保持原样。浏览器验证用临时 Playwright，完成后清理环境。禁止增加项目测试框架、恢复 tests/ 或引入不相关依赖。
- `npm run release -- --check` 检查白名单源码交付目录和独立安装。归档、私有反馈/源码、真实架构、生成产物、依赖缓存和运行记录留在发布目录之外。当前执行证据与历史分开报告，构建、CI、人工试读分别标明。
