# RTL Architect

与 AI 一起设计、理解和审阅 RTL 架构。通过一份架构模型连接模块框图、设计说明、接口约定与实现合同，让用户参与关键取舍，而不必直接编辑 JSON。

项目包含可复用的 **rtl-architect skill**、本机命令行工具和浏览器审阅界面。当前版本为 **1.0.0**。

## 能做什么

- 从需求讨论模块划分、状态归属、存储端口、吞吐与延迟预算；沿一笔事务解释方案。
- 根据已有 RTL 和证据整理架构，分别保留事实、推断、未知与未覆盖范围。
- 在同一主图中追踪控制和数据连接，查看层级、数组元素、参数与证据。
- 默认按真实拓扑安排控制、主结构与局部存储，分支和反馈保留；未分组信号使用原端口名。
- 四侧端口按连接位置安排；放大时显示接口名，缩小时保持总览简洁；图和 SVG 共用几何与路由。
- 通过候选差异、逐模块确认和整体批准组织审阅，再生成实现合同。
- 输出可独立打开的 HTML/SVG 阅读包，支持滚动、缩放和端口追踪。

工具不自动批准设计，也不是通用 HDL 导入器、RTL 等价检查器或 STA 工具。图形检查与合同导出不能替代仿真、综合和器件验收。

## 1.0：从看图到持续共同设计

- 在图上选模块或连线提问；Codex 从 context 读取问题、保存答复并关联候选，由用户核对解决。
- resume 保留目标、下一步、候选和讨论；open 核对源码、页面和服务版本，打开当前工作区。
- 导入 Yosys 展开 JSON，保留层级、端口、位连接与源码映射；源码修改后列出需要重核的实例。
- 对同一配置计算 A/B 运算、存储端口与缓存预算，保存假设；运行明确的验证清单，保存独立输入摘要和报告。
- 修改后只重新确认受影响模块，显示原因；整体批准仍对应完整当前版本。

[1.0 升级说明](docs/UPGRADE-1.0.md) · [完整共同设计流程](.agents/skills/rtl-architect/references/workbench.md) · [从原始 RTL 开始的样例](examples/rtl-intake/README.md)

默认框图继续沿用 [0.10 阅读布局](docs/UPGRADE-0.10.md)：按声明的模块类型和真实拓扑分配位置，支持四侧端口与按缩放显示名称。语义未知或大规模交叉互连仍需逐层整理和实际审阅。

## 环境与安装

当前验证环境为 Linux/WSL。需要 Bash、Git、Node **24.18.1**、npm **11.6.2**；依赖版本由 `package-lock.json` 固定。完整维护检查还需要 Python 3 和 Yosys；完整用户路径及 RTL 示例仿真需要 Verilator 和 C++ 构建工具。尚未验证原生 Windows/macOS。

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

## 先体验示例

```bash
npm run init:demo
npm start
```

按终端输出打开审阅地址。初始化仅创建未批准的示例模型，已有模型时拒绝覆盖。`tiny-stream` 包含 RTL 与自检 testbench；`packet-pipeline` 仅提供架构模型。

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

本项目采用 [MIT License](LICENSE)。第三方依赖遵循各自许可证。
