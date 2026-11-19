# RTL Architect 2.1.1

RTL Architect 是一套在本机审阅 RTL 架构的 CLI、网页和 Agent skill。它让设计者沿真实事务查结构、状态和时序，用同一份模型产出框图、Spec 和实现合同，并把用户确认、源码差异和验证结论分别记录。

## 快速开始

准备 Bash、Node **24.18.1** 和 npm **11.6.2**。在源码目录执行：

```bash
source ./env.sh
npm ci
npm run build

rtlarch_demo=$(mktemp -d -t rtlarch-demo-XXXXXX)
cp -R examples/external-axis/. "$rtlarch_demo/"
rtlarch open --workspace "$rtlarch_demo" --json
```

打开输出的 `reviewUrl`。双击任一寄存级进入内部，选择状态可查看其更新规则。点击图中连接或状态的“对此提问”，可保存与对象绑定的讨论。这个示例是两个固定上游寄存级的现状还原，保留未表达的 RTL 行为。浏览结束后运行 `rtlarch stop --workspace "$rtlarch_demo"`。

```bash
rtlarch help --json
rtlarch help replay --json
rtlarch schema model --json
```

自己的 RTL 项目使用独立工作目录。已有模型直接 `rtlarch open`，新项目由用户明确授权后用 `open --init` 初始化草稿。Agent 通过 [$rtl-architect skill](.agents/skills/rtl-architect/SKILL.md) 形成候选、追溯来源和记录证据，由用户审阅并批准。

## WSL 用户级 Skill

在 WSL 中完成上述安装和构建后，从源码根目录运行 `./bin/rtlarch install --user --json`。它将 CLI 注册到 `~/.local/bin/rtlarch`，将 skill 注册到 `~/.agents/skills/rtl-architect`。在新的 WSL Codex 会话中使用 `$rtl-architect`，可在任意项目目录调用 CLI。安装链接指向同一份源码，适合在固定路径持续开发。[安装与迁移](docs/USER-GUIDE.md#1-安装与启动)

## 文档与验收

| 需要做什么 | 入口 |
| --- | --- |
| 安装、还原 RTL、看图、讨论、候选比较、验收和交付 | [使用说明书](docs/USER-GUIDE.md) |
| 理解数据模型、存储、服务、证据链和绘图机制 | [项目架构设计说明书](docs/ARCHITECTURE.md) |
| 选择测试基准、复现结果或检查发布目录 | [VALIDATION.md](VALIDATION.md) |
| 查兼容性、版本沿革和旧记录 | [HISTORY.md](docs/HISTORY.md) |
| 维护源码和 Agent 工作区 | [AGENTS.md](AGENTS.md) |

维护用 `npm run build` 和 `npm run check`。固定上游基准由 `npm run benchmark:external-axis` 和 `npm run benchmark:axis-fifo` 执行，需要与上游 `tox.ini` 相容的 Python 和 Icarus。Linux 的实际工具版本、准备方式和本轮结果见验证记录。

在当前源码根目录开发和提交。`npm run release -- --check` 根据包版本生成 `release/rtl-architect-<版本>/` 源码快照，并在独立副本验证锁文件安装、构建、skill 链接和页面。分发该目录后执行快速开始步骤。

项目使用 [MIT License](LICENSE)。固定上游 Verilog 与测试保留 [上游许可证](examples/external-axis/benchmark/upstream/COPYING)。
