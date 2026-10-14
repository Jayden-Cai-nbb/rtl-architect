# RTL Architect 2.0.0

帮助用户看懂、质疑并把控 Agent 写出的 RTL，也让 Agent 按明确的状态、时序和验收约定实现。框图、Spec、状态规则和实现合同共用一份模型，审阅批准与实际 RTL 验证分别记录。

## 从这里开始

| 你的任务 | 最短路径 |
|---|---|
| 看懂已有代码 | 请 Agent 使用 `$rtl-architect`，读取实际 RTL/TB/构建配置，先还原一条真实事务与状态边界；未知保留 partial |
| 修改或设计 RTL | 比较关键结构取舍 → 预览候选 → 用户确认 → 按合同实现 → 用当前源码重跑检查 |
| 核对修改是否正确 | `verify` 展开/仿真 → `observe-state` 映射比较 → `assurance` 看逐状态失败、过期与未覆盖 |

框图提供架构、微架构和原始连接三种视图；按缩放展示端口名称。阅读约束能表达并排分支、共享资源和外围反馈，普通选择不会重新摆图。密集交叉互连仍需分层和沿事务实际阅读。

2.0 修复局部重测遮住旧失败的问题，支持显式多实例状态映射，并加入固定上游 RTL 的故障/修复对照。单步 MATCH 不是完整顺序等价；还原模型一致不是独立需求验收。真实用户阅读效率尚未测量。

[2.0 改进与边界](docs/UPGRADE-2.0.md) · [独立上游双实例样例](examples/external-axis/README.md) · [六类架构样例](examples/architecture-patterns/README.md) · [数值类型样例](examples/typed-expressions/README.md) · [验证记录](VALIDATION.md) · [skill](.agents/skills/rtl-architect/SKILL.md)

## 环境与安装

已验证环境为 Linux；Windows 用户可在 WSL 中按 Linux 流程使用，WSL 尚未单独验收。需要 Bash、Git、Node **24.18.1**、npm **11.6.2**；依赖版本由 `package-lock.json` 固定。完整维护检查还需要 Python 3 和 Yosys；完整用户路径及 RTL 示例仿真需要 Verilator 和 C++ 构建工具。尚未验证原生 Windows/macOS。

克隆仓库并安装依赖：

```bash
git clone https://github.com/Jayden-Cai-nbb/rtl-architect.git
cd rtl-architect
source ./env.sh
node --version
npm --version
npm ci
npm run build
```

仓库不附带本机 Node、Python 虚拟环境或 node_modules；请先准备上述版本。`env.sh` 将本仓库命令加入当前终端 PATH，不负责下载或升级依赖。

将 skill 与命令链接到个人环境：

```bash
./bin/rtlarch install --user --json
```

也可以只为指定 RTL 项目增加 skill 入口：

```bash
./bin/rtlarch install --workspace /path/to/my-rtl --json
```

安装通过符号链接引用工具目录，不覆盖已有配置。移动仓库后需要重新检查链接。skill 的完整入口位于 [.agents/skills/rtl-architect/SKILL.md](.agents/skills/rtl-architect/SKILL.md)。

## 先打开真实 RTL 示例

在工具根目录执行：

```bash
example_dir=$(mktemp -d -t rtlarch-example-XXXXXX)
cp -R examples/external-axis/. "$example_dir/"
./bin/rtlarch open --workspace "$example_dir"
```

打开终端返回的 `reviewUrl`。这是两个真实流寄存级的还原模型；双击模块进入内部，点击寄存器查看更新条件。示例副本位于输出的临时路径，不会修改仓库内的模型。完成后用 `rtlarch stop --workspace "$example_dir"` 停止该示例服务。

需要核验 RTL 时，继续按 [双实例示例说明](examples/external-axis/README.md) 执行展开、状态比较和仿真。仅打开框图不需要运行 EDA 工具，也不代表 RTL 已通过验证。

## 在自己的项目中使用

向 AI 描述需求，例如：

> 使用 $rtl-architect 设计当前模块。请比较影响面积与吞吐的关键方案，沿一笔事务讲清状态、时序与阻塞，给出预算和可审阅候选。我希望参与重要架构取舍。

或者还原已有代码：

> 使用 $rtl-architect，根据当前项目的 RTL、TB 和构建配置还原架构。保留未核实部分，说明模块分工、数据流向和来源。不修改 RTL，也不自动批准。

工具仓库与目标 RTL 项目分开保存。目标项目保留自己的 `architecture/`、`proposals/`、`generated/`、RTL 与验证资料。

```bash
# --init 仅在无模型时创建未知时钟/复位的草稿；已有模型不覆盖
rtlarch open --init --workspace /path/to/my-rtl
rtlarch resume --workspace /path/to/my-rtl --json
rtlarch context --workspace /path/to/my-rtl --json
rtlarch draft proposals/design.json --workspace /path/to/my-rtl --open --json
```

`draft` 登记候选并返回审阅链接；在页面核对差异后由用户提交草稿，再分别确认模块与批准整体架构。语义变化使受影响模块需复核，无变化的依赖保留局部确认；整体批准必须重新对应当前完整版本。讨论、预算、布局和缩放不改变架构版本。模型不完整或存在未表达结构时，不能将其当作可直接实施的完整合同。

网页中的“讨论与继续”可保存问题、查看答复、记录下一步和比较预算。保存问题后回到 Codex 让它继续处理；页面不会自行运行 AI。再次运行 `rtlarch open --workspace /path/to/my-rtl` 打开当前成果；加 `--json` 仅返回链接，不弹浏览器。

完整命令、候选与交接约定见 [提案指南](.agents/skills/rtl-architect/references/proposal-guide.md)。

## 导出与阅读

```bash
rtlarch evidence --workspace /path/to/my-rtl --json
rtlarch bundle /path/to/new-review-package --workspace /path/to/my-rtl --json
```

`bundle` 输出目录必须新建。导出只读源项目，不修改模型或批准；打开生成的 `index.html` 即可离线阅读。离线页双击模块放大，Ctrl+滚轮缩放，滚轮滚动；90% 及以上显示接口名称。点击模块、线或接口名查看真实关系。

在线画布双击子系统进入下一层，可通过“阅读大小”放大当前模块。只有明确声明为配置或时钟复位的组默认折叠，控制和数据连接保持可见。框图位置与距离不表示周期。

## 更新与版本核对

在线窗口显示包版本，并核对页面/服务构建身份。源码和构建按内容摘要匹配，避免同版本号的旧页面悄悄混用。候选创建版本是历史记录，不会随升级重写。

```bash
git pull --ff-only
source ./env.sh
npm ci
rtlarch open --workspace /path/to/my-rtl --restart
```

open 缺少或发现过期页面时自动运行构建，不安装或升级依赖；构建日志在工作区 `.rtlarch/build.log`。旧服务存在时必须显式 `--restart`，且只影响这一工作区。重启前保存页面未发送的输入。浏览器无法自动打开时复制返回的 reviewUrl；诊断使用 doctor。

已有模型、布局、候选与 IR 1/2/3 保持可读，工作记录按需新建；没有依赖指纹的旧模块确认，在下一次模型变更后需重新确认。已有项目不要重新初始化。

`bundle` 生成的离线 HTML 是固定快照，更新源码不会改变旧文件；需要导出到新目录。仓库根目录的 `index.html` 是构建入口，应通过服务访问，不能作为离线成果直接双击打开。

## 维护

```bash
source ./env.sh
npm run build
npm run check
npm run rtl:test
npm run check:workflow
npm run check:release
```

`rtl:test` 验证 tiny-stream；`check:workflow` 从 rtl-intake 原始 RTL 展开、导入、讨论、续接、仿真并检查来源变化。所有提交/确认都在临时工作区。能力边界与本次验证见 [VALIDATION.md](VALIDATION.md)，实现职责见 [架构说明](docs/ARCHITECTURE.md)。

| 目录 | 内容 |
|---|---|
| `.agents/skills/rtl-architect/` | skill、建模方法、协作与阅读指引 |
| `src/core/` | 架构模型、语义规则、检查、覆盖与合同 |
| `src/workspace/` | 项目存储、证据、提案、离线交付 |
| `src/cli/`、`src/server/`、`src/web/` | 本机 CLI、API 与审阅界面 |
| `scripts/` | 维护检查与 RTL 自检 |
| `examples/` | 通用架构和 RTL 示例 |

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖遵循各自许可证；随附的 `axis_register.v` 保留上游 MIT 许可及作者声明。

## 升级记录

[1.9 数值类型](docs/UPGRADE-1.9.md) · [1.8 阅读约束](docs/UPGRADE-1.8.md) · [1.7 状态发现](docs/UPGRADE-1.7.md) · [1.6 证据覆盖](docs/UPGRADE-1.6.md) · [1.5 状态更新](docs/UPGRADE-1.5.md) · [1.4 硬件视图](docs/UPGRADE-1.4.md) · [1.3 架构核验](docs/UPGRADE-1.3.md) · [1.2 走线](docs/UPGRADE-1.2.md) · [1.1 追踪](docs/UPGRADE-1.1.md) · [1.0 共同设计](docs/UPGRADE-1.0.md)

2.0 保留旧模型和布局格式，但旧状态比较器证据会过期，需重新 verify / observe-state。发布目录可运行 `npm run check:release`：从 lockfile 安装到独立临时目录，重建并打开示例，不复用旧 dist、node_modules 或本机 runtime。此检查不发布、不推送。GitHub Actions 独立执行构建、回归及安装检查；人工试读单独记录。

仓库保留可复现的示例、维护脚本和 2.0 验证证据。旧版本重复截图、临时报告及生成包已清理；历史摘要仍可查询。运行时依赖、构建目录和仿真波形不纳入 Git。
