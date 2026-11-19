# 2.1.0 发布验收

2026-11-19，在公开仓库隔离副本运行。版本 2.1.0，前端与服务构建 `4a8ade9bbcd98265fd710104f2673958a378f1a793a02001cc8ad80f6aac643c`。Node 24.18.1、npm 11.6.2、Python 3.10.12、Icarus 11.0、cocotb 1.7.2、Yosys 0.68+206。原版 `axis_fifo` 在固定提交 `48ff7a7e2ef782cf778d47910cf85835c64b1bce` 和 seed 1 下重跑 **144/144** 配置、**2,016/2,016** 个用例。编译参数与内层 XML 逐组核对。30 条日志截断警告仍出现。源文件、上游测试、Makefile、tox 和许可证摘要保持一致。[固定参数与原试用](../axis-fifo-skill-trial/README.md) · [本次外层 JUnit](fifo-upstream.xml)

| 问题 | 2.0 实际输出 | 2.1 实际输出 |
| --- | --- | --- |
| 回放能力 | FIFO 返回 `COMMAND_FAILED` 并提示先声明路径 | `registered_skid` 未声明为 `NOT_DECLARED`。`addressed_frame_fifo` 为 `UNSUPPORTED`，导入返回 `REPLAY_UNSUPPORTED` 并给出独立 `verify` 入口 |
| 展开接续 | 五个副本各跑两次 Yosys，共十次 | 五个副本各一次。显式映射复用同一份配置和网表，报告 `reusedElaboration=true`、原生产模型 hash 与当前模型 hash。编辑配置后，状态和结构都为 `STALE` |
| RAM 阅读 | 原始导入仅两条常量边，几何检查通过 | 两条边与几何结果保留。指定 `memory_access_top` 返回 `READING_TASK_INCOMPLETE`，给出 `mem` 的源码定位。四步任务可定位写地址、提交和输出管线，RAM 寻址仍逐步显示 `gap` |
| 多指针比较 | 四组共 12 `MATCH`、8 `UNKNOWN` | 四组共 **20 `MATCH`**。16/32 位帧模式写指针使用 6,379 节点，提交指针 5,195 节点，预算仍为 50,000 节点和 500,000 次计算 |

本次复跑脚本在五个副本中共调用 57 次 CLI。上次试用记录 82 次，两轮的检查步骤有差异。两轮均检查了正常的四个配置和同一提前提交故障，Yosys 展开次数从 10 降至 5。

本次四个定向场景均通过。提前提交故障保留原候选 hash，由 `yosys-proc-bdd-v3` 返回 `MISMATCH`。反例为 `rst=0`、`valid=1`、`last=0`，三指针旧值均为 0，E2+ 期望提交指针 `0x0`、实际 `0x1`。用同一输入对照两份独立定向采样，提交指针变化均与反例一致。端口队列在 E4+ 报 `VISIBLE_BEFORE_ELIGIBLE`，`verify` 保留 `check_failed`。超过预算的反序宽字等式继续报告 `UNKNOWN`。[四组与故障实测](fifo-review.json)

Chromium 141.0.7390.37 在 1440×1000 原版页与 1100×800 故障页均能从阅读步骤定位提交指针、打开 RAM 读入的源码，且能切换 `NOT_DECLARED` 和 `UNSUPPORTED`。独立仿真入口分别显示 `passed` 和 `check_failed`。模型仍为临时草稿。原生 FIFO 回放保持 **0/4**，人工试读未执行。[浏览器记录](browser.json)

同一发布构建重跑冻结 `axis_register`。上游 9/9 配置、81/81 cocotb 用例通过，原生回放 9/9。局部状态仍按固定分母报告 6/9 和三个零状态边界结果。两项既定故障保留原证据结论，现有回放页面另外通过 5 个浏览器用例。[九配置回归](axis-register.json) · [回放浏览器记录](axis-register-browser.json)

本地隔离副本通过锁文件干净安装、构建、RTL 自检、完整工作流和发布页面冒烟检查。维护回归分段通过。首轮新增阅读用例的写地址锚点误选为顶层模块，修正为真实边界端口后，阅读任务组和后续检查均通过。用户文档中的复用展开命令也已执行。

复跑使用固定上游的原始 pytest 目录、JUnit 和当前发布构建。下面两条命令在工具根目录执行。环境与上游准备方式沿用原试用，`rtlarch_fifo_trial` 是原版测试的临时目录，`rtlarch_axis_env` 和 `rtlarch_icarus_bin` 分别为冻结 Python 和 Icarus 的实际路径。[准备方式](../axis-fifo-skill-trial/README.md#复跑)

```bash
source ./env.sh
python3 -B scripts/check-axis-fifo-review.py --upstream "$rtlarch_fifo_trial/upstream" \
  --junit "$rtlarch_fifo_trial/upstream-junit.xml" --out "$rtlarch_fifo_trial/review-2.1" \
  --python "$rtlarch_axis_env/bin/python" --icarus-bin "$rtlarch_icarus_bin"
node scripts/check-axis-fifo-browser.mjs "$rtlarch_browser" "$rtlarch_fifo_trial/review-2.1" \
  "$rtlarch_fifo_trial/browser-2.1.json"
```

所有提交候选、故障注入和浏览器服务位于临时目录。真实项目的架构与布局摘要已复核，批准不被试验写入。`verify` 记录冻结的测试依据，局部比较与图形阅读保持独立状态。
