# RTL Architect 使用说明书

适用于 RTL Architect 2.1.1。设计者用网页看图、讨论和审阅，Agent 与自动化用同一个 `rtlarch` 入口读取、登记和核验。硬件行为的权威记录是目标项目的 `architecture/model.json`。

## 1. 安装与启动

准备 Linux 或 WSL2、Bash、Node **24.18.1** 和 npm **11.6.2**。实际验收环境见 [验证记录](../VALIDATION.md)。使用目标项目自己的 EDA 环境进行验证。通用维护回归需要 Python 3、Yosys、Verilator 和 C++ 构建工具。固定上游基准另需与 `tox.ini` 相容的 Python 3.10、Icarus 和 `fst2vcd`。

在源码交付目录执行：

```bash
source ./env.sh
node --version
npm --version
npm ci
npm run build
rtlarch help --json
rtlarch help open --json
rtlarch schema model --json
```

`env.sh` 只设置当前 shell 的路径，锁文件固定项目依赖。若 Node 自带的 npm 版本不同，可在选定的 Node 环境执行 `npm install --global npm@11.6.2 --ignore-scripts --no-audit --no-fund`，再运行 `npm ci`。保留完整的安装，因为源码入口需要 TypeScript 加载器。`open` 可根据构建身份重建缺失或过期的页面。

日常从其他目录使用时，可以为当前用户安装命令和 skill，也可为某个 RTL 工程单独安装 skill。

```bash
./bin/rtlarch install --user --json
```

`install --user` 在当前 Linux 或 WSL 用户下注册 `~/.local/bin/rtlarch` 与 `~/.agents/skills/rtl-architect`。在新的 WSL Codex 会话中使用 `$rtl-architect`。终端的 PATH 若尚未包含 `~/.local/bin`，可以直接运行返回的 `entry`。CLI 和 skill 均从所链接的源码目录运行。

`install --workspace <项目目录>` 可为指定项目增加 skill 入口。安装使用符号链接，目标已有同名文件或目录时报告冲突。安装后将工具留在固定路径。移动目录后核对返回的 `entry` 与链接，确认旧链接由自己管理后再替换。Git 使用源码根目录，`npm run release` 生成的子目录用于分发。

## 2. 第一次看图

下面的步骤在工具目录执行，副本包含两个实际的 AXI Stream 简单寄存级和对应的还原模型。

```bash
rtlarch_demo=$(mktemp -d -t rtlarch-demo-XXXXXX)
cp -R examples/external-axis/. "$rtlarch_demo/"
rtlarch open --workspace "$rtlarch_demo" --json
rtlarch resume --workspace "$rtlarch_demo" --offline --json
```

打开输出里的 `reviewUrl`。链接绑定这个工作区，复制链接时保留查询参数。页面初次展示设计用途、模块分工和待办。选中单个对象可看端口、连接成员、状态规则和来源。双击子模块进入其作用域，从面包屑返回上一级。

| 阅读任务 | 操作 |
| --- | --- |
| 找接收、保存和输出 | 默认用“主事务总览”，沿数据、控制和反压查看。聚合关系可展开查看每条原始连接与位域。 |
| 追某个寄存状态 | 双击寄存级进入内部，选择“局部状态”及实际状态。查看更新条件、复位、默认保持与“下一状态逻辑锥”。 |
| 核对物理端口及反馈 | 切到完整图，再选架构、微架构或原始连接。点击关系查看源和目的，按需扩大追踪。 |
| 检查图的阅读代价 | 展开“框图检查”，定位最长关系、交叉和被收起的线名。在“更多操作”下载质量记录或 SVG。 |
| 有明确源码阅读路径 | 按步骤定位对象、回看引用。标记为缺口的步骤同时提供具体原因和已有证据。 |

普通选择只改变高亮与详情。移动、自动整理、保存布局和扩大追踪都是显式操作。图上位置表示组织方式，时序依据另查寄存边界和实际采样。候选与当前工作区按各自版本识别。

```bash
rtlarch diagram-quality --task overview --workspace "$rtlarch_demo" --json
rtlarch diagram-quality --module stage0 --task state --state stage0_data_q --workspace "$rtlarch_demo" --json
```

`--model <candidate.json>` 检查独立候选，`--layout <layout.json>` 可指定匹配其 hash 的阅读布局。`--reading-task <ID>` 检查一项已声明阅读路径能否跟读。关注几何、连接对应、显式约束、阅读路径及人工试读各自的结果。

## 3. 从自己的项目开始

- 已有工作区，执行 `rtlarch open --workspace <项目目录>`，用 `resume --offline` 或 `context-index --offline` 了解上次任务。
- 尚无模型，从原始 RTL、测试和实际构建配置入手。仅在需要存放草稿时显式使用 `open --init`。初始顶层的时钟、复位保持未知。
- 需要 Agent 参与时，明确要求使用 [$rtl-architect](../.agents/skills/rtl-architect/SKILL.md)，指定目标、实际配置、参考结果和希望用户决定的取舍。

例如可以对 Agent 说：

> 使用 $rtl-architect 还原当前配置。沿一笔事务交代接受、保存、可见、消费与取消。用源码和实测区分事实与推断，保留 RAM、时钟域和行为缺口，登记一个供我审阅的候选。

可用 `inventory` 核对显式源码、宏、参数、include 和资产清单。已有 Yosys 网表时用 `import-yosys` 生成候选、映射和缺口记录。导入只读给定产物，候选保留 `as_built` 与 `partial`。在展开放入宏和实际顶层之后再确认结构，源文件总量未知时保留未知分母。[现状还原指引](../.agents/skills/rtl-architect/references/as-built.md)

在独立副本练习设计候选：

```bash
rtlarch_draft=$(mktemp -d -t rtlarch-draft-XXXXXX)
rtlarch init --workspace "$rtlarch_draft" --json
rtlarch draft examples/packet-pipeline/model.json --workspace "$rtlarch_draft" --open --json
rtlarch proposals --workspace "$rtlarch_draft" --json
```

`draft` 接收完整模型。已有增量提案时先用 `preview` 核对基线和问题，再用 `propose <proposal.json> --open` 登记。用户打开审阅链接，查看候选版本差异，选择保存草稿。旧候选基线过期后保留原记录，按当前基线显式重新预览。

从“逐层审阅”逐模块确认职责、接口和行为，再批准当前完整架构。依赖变动会使受影响的模块需要复核，整体批准绑定完整模型。用于实施前，用户在当前批准版本导出合同，再运行 `handoff <模块ID>` 获取对应版本的合同与交接信息。发现 `partial`、来源变化或导出不匹配时，先解决相应阻断。

```bash
rtlarch compare examples/tiny-stream/model.json examples/packet-pipeline/model.json --json
rtlarch context-index --workspace "$rtlarch_demo" --purpose review --offline --json
rtlarch spec --workspace "$rtlarch_demo" --json
```

完整模型、提案、阅读布局及检查映射以实际 `rtlarch schema <名称> --json` 输出为准。机器调用同时看退出码、`ok`、具体结果及 `error.code`。[提案与合同指引](../.agents/skills/rtl-architect/references/proposal-guide.md)

## 4. 讨论、方案预算与恢复

1. 在图中点选连接、状态或更新分支，核对对象名、作用域和实例路径后点“对此提问”。需求和验证义务也有独立提问入口。
2. 在“讨论与继续”保存问题。面板支持拖动调整尺寸，详细证据可按需展开。返回 Codex 让 Agent 读取目标和讨论再答复。页面负责保存和展示记录。
3. 在“继续工作”保存下一步。重开工作区时以已保存的 checkpoint 恢复对象及分支。过期对象在历史中保留，先核对再在当前版本发起问题。
4. 在“变更”载入 A/B 候选。要持久比较时分别登记。为各自的 ID/hash 绑定预算，加入输入新鲜的实验、假设和风险。
5. 在“决策记录”说明选择。选择与草稿保存、确认、批准及问题解决各有独立操作。更换候选或修改预算时按新对象记录，保留已有选择。

```bash
rtlarch workbench --workspace "$rtlarch_demo" --offline --json
rtlarch resume --workspace "$rtlarch_demo" --json
rtlarch study examples/storage-budget/shared-ram.json --json
```

在线工作记录用 `workbenchHash` 防止覆盖，目标字段用模型版本和对象身份定位。预算按已声明的 latency、II、独占、RAM 端口、bank、反馈路径和流率估算。持续到达率超过服务率时，有限缓冲也会长期积压。利用预算发现取舍与未知，具体 RTL 的资源、时序和吞吐另以相应工具和场景验证。[预算输入示例](../examples/storage-budget/README.md)

## 5. 验证、结构和状态证据

运行前核对 `verify` 清单里的 argv、阶段、文件、参数、测试、输出检查和声明的输入闭包。只执行已经明确提供的配方。每次运行在目标项目的 `evidence/runs/` 保存当时的模型版本、输入与产物摘要、工具版本、退出和检查结果。`runs` 显示历史，`assurance` 汇总当前证据。

```bash
rtlarch verify "$rtlarch_demo/elaboration.json" --workspace "$rtlarch_demo" --json
rtlarch verify "$rtlarch_demo/verification.json" --workspace "$rtlarch_demo" --json
rtlarch runs --workspace "$rtlarch_demo" --json
rtlarch assurance --workspace "$rtlarch_demo" --json
```

`checks` 可按显式状态/端口映射生成有限仿真监视器，交给原项目的仿真清单执行。结构核对 `conform` 引用真实展开产物和逐端点映射，状态核对 `observe-state` 引用具体实例与寄存状态。发现的状态数量与已比较数量分别显示。`MISMATCH` 提供可复核的单步输入、沿前状态和下一值。有效的 X/Z、未知单元、缺失映射、跨时钟和预算超限留在 `UNKNOWN`。

### 复用一次展开

下面的样例用现成的 8 位加三设计，登记实际 Yosys 输入，保存一次展开并同时生成结构和状态清单。需要 Yosys 在 PATH。

```bash
rtlarch_state=$(mktemp -d -t rtlarch-state-XXXXXX)
cp -R examples/state-updates/. "$rtlarch_state/"
python3 - "$rtlarch_state" <<'PY'
import json
from pathlib import Path
import sys

work = Path(sys.argv[1])
source = dict(top='add_const', configuration='8-bit add-3 fixture',
              parameters=dict(DATA_W=8, CONST=3), defines=[], includeDirs=[],
              files=['rtl/add_const.sv'], assets=[])
(work / 'inputs.json').write_text(json.dumps(source))
profile = json.loads((work / 'elaboration.json').read_text())
profile['elaborationInputs'] = 'inputs.json'
profile['inputs'] += ['inputs.json', 'source-elaboration.json']
(work / 'source-elaboration.json').write_text(json.dumps(profile))
PY
rtlarch verify "$rtlarch_state/source-elaboration.json" --workspace "$rtlarch_state" --json > "$rtlarch_state/run.json"
python3 - "$rtlarch_state" <<'PY'
import json
from pathlib import Path
import sys

work = Path(sys.argv[1])
run = json.loads((work / 'run.json').read_text())
assert run['ok'] and run['status'] == 'passed'
(work / 'import-input.json').write_text(json.dumps(dict(schemaVersion=2, runId=run['id'], netlist='state.json')))
mapping = json.loads((work / 'state-mapping.json').read_text())
mapping['runId'] = run['id']
(work / 'observed-input.json').write_text(json.dumps(mapping))
PY
rtlarch import-yosys "$rtlarch_state/import-input.json" "$rtlarch_state/imported" --workspace "$rtlarch_state" --json
rtlarch observe-state "$rtlarch_state/observed-input.json" --workspace "$rtlarch_state" --json
```

`elaborationInputs` 声明实际命令只依赖源码配置，输入须包含该配置和全部实际编译文件。导出的 `conformance.json` 与 `state-discovery.json` 是显式映射的起点。后者可发现状态，核对语义时再填写映射。经用户保存新模型后，当前映射可带 `reuseElaboration: true` 使用同一份源网表。记录保留原生产版本与当前模型版本。编辑输入、配置、工具或网表后重新展开。

`MATCH` 局限于声明作用域、已映射的二态单步函数。顺序等价、初始状态、反例可达性、已批准需求和器件时序有各自验证依据。过期的记录可追溯，在当前版本的结论中保持过期。[状态观察与义务指引](../.agents/skills/rtl-architect/references/state-observation.md)

## 6. 事务回放

先查能力，再决定采集与映射格式：

```bash
rtlarch help replay --json
rtlarch replay --semantics registered_skid --workspace "$rtlarch_demo" --json
rtlarch replay --semantics addressed_frame_fifo --workspace "$rtlarch_demo" --json
rtlarch schema replay --json
rtlarch schema replaySamples --json
```

`DECLARED` 表示模型已有对应路径。`NOT_DECLARED` 对应受支持语义的缺失声明，需经提案补充。`UNSUPPORTED` 给出独立 `verify` 入口。当前支持单域级联单槽、旁路、简单寄存以及双槽 skid。地址化 RAM FIFO 与帧 FIFO 使用独立仿真与端口队列，页面可查看运行结果、失败和来源新鲜度。

回放从 `verify` 登记的显式沿前/沿后采样读取握手、启用的负载及 sideband、状态观测值。事务按接受事件编号。原轨迹上的状态关联、数据和 valid 匹配、输入保持前提、实际场景覆盖分别报告。检查器记录实际接受、可见、消费、阻塞、恢复、取消与结束在途。有限轨迹允许在结束时保留待消费事务。`OBSERVED` 只描述这组采样，输入违规有独立位置，不能归给下游寄存器。原版轨迹和故障用法见 [事务回放样例](../examples/transaction-replay/README.md)。

## 7. 导出、交接和排查

```bash
rtlarch_review=$(mktemp -d -t rtlarch-delivery-XXXXXX)
rtlarch evidence --workspace "$rtlarch_demo" --json
rtlarch bundle "$rtlarch_review/review" --workspace "$rtlarch_demo" --json
rtlarch stop --workspace "$rtlarch_demo" --json
rtlarch stop --workspace "$rtlarch_draft" --json
```

离线包可通过生成的 `index.html` 打开。它用同一模型生成 Spec、图和来源清单，保留模型版本、覆盖缺口、折叠范围及质量记录。另一次交付应输出到新目录；旧包固定在导出时的输入。工具根目录的 `index.html` 由 Vite 用于构建，在线页面通过工作区服务访问。

| 现象 | 处理 |
| --- | --- |
| 缺 Node 或依赖 | 在工具目录加载 `env.sh`，核对版本和锁文件，运行 `npm ci`。 |
| 返回链接但浏览器没打开 | 复制 `reviewUrl` 到本机浏览器。使用 `doctor --workspace` 检查目标与构建。 |
| `RESTART_REQUIRED`、构建身份变化 | 保存还未发送的输入，在对应工作区执行 `rtlarch open --workspace <项目目录> --restart`。构建日志在该项目的 `.rtlarch/build.log`。 |
| 端口或 workspaceId 不匹配 | 回到要操作的项目重新取链接。只读排查用 `context --offline`。 |
| 提案或讨论冲突 | 保留原候选、问题和输入，重新取得基线和确切对象后发起新预览或写入。 |
| 来源或检查器过期 | 从 `runs`、`assurance` 和具体报告定位欠缺的输入、映射或旧记录，按当前配置重跑对应验证。 |
| `READING_TASK_INCOMPLETE` | 按报告查看缺失的关系、范围和源码，用显式阅读任务记录还原缺口。 |
| 超过 8 MiB 的请求 | 以模块和任务分批提交或查询，保留必要的关系和追溯。 |

维护者从 [VALIDATION.md](../VALIDATION.md) 选择回归和固定上游基准。`npm run release -- --check` 生成并核对干净的源码目录，也可追加一个不存在的输出目录。源码交付经 `npm ci` 和 `npm run build` 启动，目标项目的 RTL、模型和证据各自保存。
