# axis_register 原生旁路、单槽与双槽回放实测

2026-11-19 15:29（北京时间），工具 2.0.0、回放检查器 3 完成固定提交 `48ff7a7e2ef782cf778d47910cf85835c64b1bce` 的复跑。先运行原版 pytest。九组各通过九个 cocotb 用例，共 **81/81**。本次构建为 `70881737fec906e785d6f0459de9653bfa9fdcc24aee4ecb08a5b6f10452611d`。冻结配置 SHA-256 为 `b611a8c4518ec1e31831305df44c32714f631a36cb403daa709fe7479693959c`。报告保存源文件、测试、采集器、矩阵以及工具身份。[完整矩阵与输入摘要](summary.json)

## 从上游读出的三个实现

| REG_TYPE | 实际存储 | 下游持续就绪、空载时的首笔 | 阻塞与复位 |
| --- | --- | --- | --- |
| 0 | 零槽，valid 与负载正向，ready 反向 | 同一沿接受和消费 | 上游保留等待的有效负载。`rst` 无数据通路作用，复位有效期间可收发 |
| 1 | 一个输出槽，另有寄存 ready | 接受沿后可见，下一沿消费。连续输入的两次接受之间有一个空拍 | 阻塞保留输出。复位清除 ready 和输出 valid |
| 2 | 一个输出槽、一个临时槽，另有寄存 ready | 接受沿后可见，下一沿消费。后续可同沿收新、消费旧输出 | 已给出 ready 时，新输入可进入临时槽，旧输出保持。恢复时可在消费旧输出的同一沿将临时槽移入输出。复位清除 ready 和两槽 valid |

上游 pytest 给出 8、16、32 位和三种寄存类型。三组 8 位的 `KEEP_ENABLE=0`，输出 keep 固定为 1。16/32 位 keep 分别为 2/4 位。所有原配置启用 last、ID、dest、user，ID 与 dest 各 8 位，user 1 位。上游含无暂停、源暂停、下游反压、两者同时、user 为 1，以及使用 seed 1 的随机压力用例。定向数据补上原版 ID 与 dest 同值的辨别盲区。[固定 RTL](../../../examples/external-axis/benchmark/upstream/rtl/axis_register.v) · [原版测试](../../../examples/external-axis/benchmark/upstream/tb/axis_register/test_axis_register.py) · [定向采集器和独立端口队列](../../../examples/external-axis/benchmark/directed_replay.py)

## 固定分母为九的结果

| DATA_WIDTH | REG_TYPE | 原版 cocotb | 结构 | 状态向量 | 事务解释 | 原生回放 | 图形自动检查 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 0 | 9/9 | PASS | 无寄存，边界通过 | PASS | 3/3 `OBSERVED` | PASS |
| 8 | 1 | 9/9 | PASS | 8 MATCH | PASS | 3/3 `OBSERVED` | PASS |
| 8 | 2 | 9/9 | PASS | 15 MATCH | PASS | 3/3 `OBSERVED` | PASS |
| 16 | 0 | 9/9 | PASS | 无寄存，边界通过 | PASS | 3/3 `OBSERVED` | PASS |
| 16 | 1 | 9/9 | PASS | 8 MATCH | PASS | 3/3 `OBSERVED` | PASS |
| 16 | 2 | 9/9 | PASS | 15 MATCH | PASS | 3/3 `OBSERVED` | PASS |
| 32 | 0 | 9/9 | PASS | 无寄存，边界通过 | PASS | 3/3 `OBSERVED` | PASS |
| 32 | 1 | 9/9 | PASS | 8 MATCH | PASS | 3/3 `OBSERVED` | PASS |
| 32 | 2 | 9/9 | PASS | 15 MATCH | PASS | 3/3 `OBSERVED` | PASS |

结构、事务解释、原生回放和图形自动检查各为 **9/9**。状态比较 **6/9**，共 69 个有限二态单步 MATCH，三份旁路只计边界结果。三个 skid 配置的输出槽与临时槽状态图各报 221 处交叉、1 条隐藏线名。图形交付包括总览、原始连接或状态任务图、离线阅读页与任务定位卡。九配置人工阅读为 `NOT_RUN`。

原生回放共 **27 段**，按配置各取原版 `run_test_001`、`run_test_002` 和独立定向场景。两段原版波形每个 REG_TYPE 跨三种宽度均接受并消费 2,316 笔。三组 skid 从原版背压轨迹合计观察到 1,155 次同沿消费旧输出并移入临时槽。寄存场景从第一个沿前已观察到复位的有效沿起编号，前置沿数量、FST/XML 摘要和实际采样时间写入矩阵。所有保留段连续采样。

定向场景在三种宽度得到相同的计数。输入 data 全程为 `0x5a`，T0 与 T1 的全部启用字段相同，其余输入变更 sideband。独立端口队列逐笔核对接受、消费、取消编号和字段。

| REG_TYPE | 接受 | 消费 | 取消 | 在途结束 | 峰值占用 | 最长输出阻塞 | 恢复段 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 13 | 13 | 0 | 0 | 0 | 18 沿 | 1 |
| 1 | 13 | 12 | 1 | 0 | 1 | 17 沿 | 1 |
| 2 | 14 | 12 | 2 | 0 | 2 | 17 沿 | 1 |

16 位轨迹中，旁路在 E51 的复位标记期间同沿接受和消费 T10。单槽在 E2 接受 T0、E3 消费、E4 才接受 T1。双槽在 E18 把 T7 保存到临时槽，E35 消费输出 T6，E35+ 把 T7 移入输出，E36 消费 T7。相同数据的两笔 dest 分别为 179 和 182。E51+ 的复位清空输出 T10 和临时槽 T11。[实际事件与槽位摘录](directed-edges.json)

另外用 16 位双槽轨迹检查边界。只保留复位沿时结果为 `COVERAGE_INCOMPLETE`。截止两槽填满的前缀为 `OBSERVED`，在途保留 T6 和 T7。临时槽有效 user 置 X 得到 `UNKNOWN`。E19+ 等待中的入口 ID 从 56 变为 57 时，得到 `ENVIRONMENT_VIOLATION`，本沿下游诊断为零。空槽在 E2− 错误拉高 valid 且 E2+ 新负载值错误时，修正前 `VALID_PHASE` 和 `BLOCKED_PAYLOAD_OVERWRITE`，修正后 `VALID_PHASE` 和 `PAYLOAD_MISMATCH`。缺临时槽映射或混用 v1 采样均拒绝。等值参数位宽可通过校验，常量 0 的 `move_temp` 分支仍报 `TRANSACTION_PATH`。[边界检查输出](summary.json)

## 独立故障证据

- 冻结的 8 位单槽故障翻转数据 bit 0。原版 scoreboard 对九个用例全部报失败，`verify` 留存 `check_failed`。映射到 `top.m_axis_tdata_reg`，参考模型 MISMATCH，故障版还原 MATCH，独立帧完整性仍失败。状态与批准保留原依据。[原版故障关联](fault-association.json)
- 16 位双槽只在临时副本将输出槽的 dest 从临时槽 ID 取值。回放在 E35+ 返回 `FAILED`，关联 T7、`top.m_axis_tdest_reg` 和声明 `move_temp`，期望 182、观察 49。独立端口队列在 E36 出口消费同一编号时也发现 dest 错误，data 保持 90，入口前提 `CHECKED`。[双槽故障证据](skid-sideband-fault.json)

## 页面核对

从 `rtlarch open` 打开临时工作区后点事务回放记录。1440×1000 验证 16 位三个类型和双槽故障，1100×800 再验双槽。五次均通过。旁路消费 T0 打开 `m_axis_tdata` 的讨论，单槽定位输出状态。双槽从 `store T7` 定位临时槽，再从 E35 的 `transfer T7` 定位输出槽并打开 `m_axis_tdata_reg/move_temp` 的讨论。故障记录定位到 `m_axis_tdest_reg`，页面保留 E35+ 和期望、观察值。每次核对模型 hash、构建和草稿状态。Chromium 141.0.7390.37，Playwright 1.56.1。[浏览器实测](browser.json) · [复跑脚本](../../../scripts/check-axis-replay-browser.mjs)

## 复跑

先准备冻结 Python 环境和可运行的 Icarus。`rtlarch_axis_env` 为 Python 虚拟环境目录，`rtlarch_icarus_bin` 为 Icarus 的 bin 目录。

```bash
source ./env.sh
npm run build
npm run benchmark:external-axis -- --python "$rtlarch_axis_env/bin/python" --icarus-bin "$rtlarch_icarus_bin"
```

本次为 Node 24.18.1、npm 11.6.2、Python 3.10.12、Icarus/vvp 11.0、Yosys 0.68+206、cocotb 1.7.2、cocotbext-axi 0.1.20。完整依赖、`fst2vcd` 摘要和模型 hash 见矩阵。Icarus 的 Ubuntu 包解包后在临时前缀补齐了 `usr/x86_64-linux-gnu/ivl` 路径，再用原生进程完成运行。实际参数使用 `/tmp/rtlarch-axis-final-EkiEsg/python/bin/python` 和 `/tmp/rtlarch-axis-final-EkiEsg/simulator/usr/bin`。矩阵内的相对路径以本次运行目录 `/tmp/rtlarch-axis-final-EkiEsg/rtlarch-axis-benchmark-KFS4aC` 为根。复跑会产生新目录。[依赖准备与入口](../../../examples/external-axis/benchmark/README.md#运行)

同一构建通过 `npm run check`，含 12 组 skill 入口检查和 10 组原有事务回放检查。`npm run rtl:test` 的 tiny-stream 自检通过，超时负例按预期失败退出。

历史 v1 模型原样解析。检查器 2 及无版本记录显示 `STALE`，已有轨迹重新导入只得到其原格式的观察范围。新增路径为 v2，并要求同代显式采样和映射。有限 `OBSERVED`、单步状态 MATCH、上游测试和批准各有证据。真实工作区与批准状态保持原值。[迁移策略](../../../examples/transaction-replay/README.md)
