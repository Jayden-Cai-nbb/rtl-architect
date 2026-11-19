# RTL Architect 验证与发布

本页是当前源码的验证入口。历史结果在 [HISTORY.md](docs/HISTORY.md)。自动化图形审计、实际浏览器操作和人工试读分别报告。

## 主要基准

| 主入口 | 范围与分母 |
| --- | --- |
| `npm run check` | 4 个分组、29 个维护场景。覆盖语义、图形、核验和真实 RTL 工作流，包括已知故障、来源失效与权限边界。 |
| `npm run benchmark:external-axis` | 固定上游 `axis_register`，3 个位宽 × 3 个 REG_TYPE。上游测试、结构、状态、事务解释、原生回放和图形均按九组报告。 |
| `npm run benchmark:axis-fifo` | 固定上游 `axis_fifo`，原版 144 组。另用固定 16/32 位普通与帧四组做读取路径、5 个状态、独立场景和提前提交故障检查。 |

### 维护回归

```bash
source ./env.sh
npm run build
npm run check
```

可用 `npm run check -- <分组>` 聚焦。运行完整回归时已包含下面各项。

| 分组 | 验收 |
| --- | --- |
| `workspace` | 模型兼容、语义修改、身份、提案/批准、参数与数组、对象讨论、候选决策、资源及存储预算。 |
| `diagrams` | 完整/总览/状态图、阅读约束、共享/反馈/并行、长关系和线名、逻辑锥、SVG 与离线包。六类真实 RTL 的展开端点另行核对。 |
| `verification` | 显式结构和状态映射、有限二态类型与覆盖、旧证据失效、双实例抵消故障、事务回放及来源核验。 |
| `workflow` | skill 与重启入口、阅读整理守卫、tiny-stream 自检/TIMEOUT 负例，以及原 RTL 的展开 → 还原 → 草稿 → 讨论 → 恢复 → 自检 → 来源变更失效。 |

`npm run rtl:test` 单独执行 tiny-stream 兼容回归。所有工作流的保存、批准与注入发生于临时副本。需要保存工作流 JSON 时，可运行 `npm run check -- workflow /tmp/rtlarch-new-workflow.json`。

### 固定上游

两个基准共用固定提交 `48ff7a7e2ef782cf778d47910cf85835c64b1bce` 的冻结目录。先按 [原版环境和配置矩阵](examples/external-axis/benchmark/README.md) 准备 Python 与 Icarus，再从已构建的工具目录执行：

```bash
npm run benchmark:external-axis -- --python "$rtlarch_axis_env/bin/python" --icarus-bin "$rtlarch_icarus_bin"
npm run benchmark:axis-fifo -- --python "$rtlarch_axis_env/bin/python" --icarus-bin "$rtlarch_icarus_bin"
```

两项运行均保留各自输出路径、冻结输入摘要、seed、参数、工具版本、检查器身份和故障证据。CLI 的 `ok`、上游 pytest/cocotb 结果、局部比较、有限回放和图形阅读分项使用各自分母。旁路的零状态与 FIFO 的 `UNSUPPORTED` 分别按边界判定。允许事先建立临时环境，保持上游原件和验收规则原样。

### 浏览器与源码交付

先用 [临时 Playwright 步骤](examples/external-axis/benchmark/README.md#页面复跑) 准备 Chromium。浏览器可检查主题工作流或两个固定基准的页面。基准参数目录由上一步命令输出。

```bash
npm run check:browser -- selection "$rtlarch_browser" "$rtlarch_browser/selection"
npm run check:browser -- axis-register "$rtlarch_browser" "$rtlarch_axis_run" "$rtlarch_browser/register"
npm run check:browser -- axis-fifo "$rtlarch_browser" "$rtlarch_fifo_run" "$rtlarch_browser/fifo.json"
npm run release -- --check
```

源码交付目录默认为 `release/rtl-architect-<版本>`。命令从白名单收集源码与输入，再在隔离副本从锁文件安装、构建、安装项目 skill、打开含空格路径的项目并验证构建身份。平台兼容、发布上传和完整工具链离线安装有各自验收。

## 2.1.1 发布验收

2026-11-19，在 Ubuntu 22.04 WSL2 上执行。内核为 `6.18.58.1-microsoft-standard-WSL2`，Node 24.18.1、npm 11.6.2。发布构建身份为 `c0d8707290bd293d86c813971ce9d7570468d6a6e463ba29f63fda498d4d4306`。

| 检查 | 实际结果 |
| --- | --- |
| WSL 用户级注册 | `~/.local/bin/rtlarch` 与 `~/.agents/skills/rtl-architect` 指向同一源码。Codex `skills/list` 在独立项目目录发现 `scope=user`、`enabled=true` 的 `rtl-architect`。 |
| 干净 shell | 无 PATH 上的 Node，从用户 CLI 和 skill 脚本读取、打开含空格路径的临时项目。页面与服务构建身份一致，服务实际使用当前源码目录的 Node。原已保存的模型字节一致。 |
| 综合与干净安装 | 锁文件安装、构建和 4 组 29 个综合场景通过。从源码白名单另建临时副本，验证依赖安装、项目 skill 和页面启动。 |
| 固定 `axis_register` | 本轮重跑 9/9 配置、81/81 原版用例、9/9 原生回放。数据位反转和双槽 sideband 故障均保留检出结果。 |
| 固定 `axis_fifo` | 核对整理版的 144 组、2,016 个原版产物，使用当前构建重新跑四组定向仿真，20/20 映射 MATCH。提前提交得到 MISMATCH，独立仿真回报 `check_failed`。原版 pytest 产物以 `reranUpstream=false` 标记为复用。 |

本轮页面验收使用真实本机服务与 HTTP 冒烟。下节 Chromium 交互为整理版实测记录。工作区写入均在临时项目执行。远端运行由 GitHub Release 链接关联到提交。

## 2.1.0 整理版验收

2026-11-19，本机 Ubuntu Linux。Node 24.18.1、npm 11.6.2、Yosys 0.68+206、Verilator 5.053 devel，外部基准使用 Python 3.10.12、Icarus 11.0、cocotb 1.7.2、cocotbext-axi 0.1.20。源码与页面构建身份为 `244382e8c2347efc9ae23277edccf48c5e904cbc67c8b53b0e23a02c81d04165`。

| 实际执行 | 本轮结果 |
| --- | --- |
| 构建与完整维护回归 | TypeScript 和 Vite 构建通过。一次 `npm run check` 完成 4 组、29 个场景。原 1,365 处 TypeScript 维护断言中，唯一文字变化是切换被调用的 CLI 包装。 |
| 原 tiny-stream | 接受 1,134 笔、消费 1,125 笔、复位取消 9 笔。故意超时的负例按预期失败。 |
| 固定上游 `axis_register` | 上游 9/9 配置、81/81 用例。结构、事务解释、原生回放和图形自动阅读任务均为 9/9。状态为 6/9 MATCH 与 3/9 零状态边界。数据位翻转和 skid sideband 错接都检出。 |
| 固定上游 `axis_fifo` | **新入口一次通过原版 144/144 配置、2,016/2,016 cocotb 用例**。四组普通/帧定向仿真通过，20 个已映射状态 MATCH。提前提交的 `wr_ptr_commit_reg` 反例为 E2+ 期望 0、实际 1，独立队列在 E4+ 报 `VISIBLE_BEFORE_ELIGIBLE`。RAM 阅读任务保留缺口，原生回放 0/4，为 UNSUPPORTED。 |
| Chromium 141.0.7390.37 | 对象讨论与恢复 2/2，寄存器回放 5/5，FIFO 正常和故障页 2/2，无页面异常。包含 1440×1000 与 1100×800。FIFO 页面使用本轮原版产物复用验证生成的副本。 |
| 说明书与源码交付 | 实跑 9 段说明书操作，涵盖临时示例、候选登记、结构导入、状态比较、回放能力预检和离线包。独立源码副本从锁文件安装，借本机 npm 缓存完成构建。含空格路径、项目 skill 和页面服务均通过。已有输出目录拒绝覆盖。 |

整理后的脚本 16 个，原 45 个。npm 入口从 40 个归并为 9 个。原 `docs/` 的 1,101 个历史与说明文件压缩归档，现行目录为两本说明书和一份履历。源码交付只包含可构建和复跑的资料。

首轮 FIFO 原版 144 组已通过，后续发现合并入口漏接 `profile` 与 `directed`。恢复两个方法后，使用本轮原始产物核对后续流程，再重跑完整入口。原版 RTL、测试、冻结验收和独立队列逐文件摘要一致。工具根目录的模型和布局摘要一致，维护运行全部使用临时目标工作区。

原版 FIFO 日志保留 30 条日志截断提示，对应 XML 的用例数与 seed 已核对。Vite 保留现有大 chunk 提示。人工试读、其他平台和本轮远端 CI 未执行。各项工具输出与独立场景结论按表中的实际范围解释。
