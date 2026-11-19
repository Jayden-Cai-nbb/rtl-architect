# 固定上游 AXI Stream 基准

本目录冻结 `axis_register` 和 `axis_fifo` 的原版源码与测试。提交 `48ff7a7e2ef782cf778d47910cf85835c64b1bce` 的 RTL、cocotb 测试、Makefile、`tox.ini` 和 MIT 许可证按原路径保存在 `upstream/`。文件 SHA-256、九组参数、seed、验收场景及故障点冻结在 [baseline.json](baseline.json)。[固定上游提交](https://github.com/alexforencich/verilog-axis/tree/48ff7a7e2ef782cf778d47910cf85835c64b1bce) · [上游依赖](upstream/tox.ini) · [MIT 许可证](upstream/COPYING)

## axis_register 配置

| DATA_WIDTH | REG_TYPE | KEEP_ENABLE | KEEP_WIDTH | 其余 sideband |
| --- | --- | --- | --- | --- |
| 8 | 0、1、2 | 0 | 1 | LAST、ID、DEST、USER 使能 |
| 16 | 0、1、2 | 1 | 2 | LAST、ID、DEST、USER 使能 |
| 32 | 0、1、2 | 1 | 4 | LAST、ID、DEST、USER 使能 |

ID 和 DEST 均为 8 位，USER 为 1 位。8 位配置仍有 `tkeep` 物理端口，输出固定为 1。九组分别运行上游四个普通场景、一个 `tuser=1` 用例和四个随机压力场景。seed 固定为 1，采集 Icarus FST。测试、RTL 和判定断言按冻结摘要核对。

## 运行

使用 Python 3.10、可加载该环境中 cocotb VPI 的原生 Icarus Verilog，以及 PATH 上的 Yosys 和 `fst2vcd`。本机使用 Ubuntu 22.04 的 Icarus 11.0 包，与上游 CI 同代。可通过 `--icarus-bin` 指定包含 `iverilog`、`vvp` 的目录。基准记录实际执行文件和版本。首次可按原版 `tox.ini` 准备 Python 环境。

```bash
source ./env.sh
rtlarch_axis_env=$(mktemp -d -t rtlarch-axis-python-XXXXXX)
python3.10 -m venv "$rtlarch_axis_env"
"$rtlarch_axis_env/bin/python" - examples/external-axis/benchmark/upstream/tox.ini <<'PY'
import configparser
import subprocess
import sys

config = configparser.ConfigParser()
config.read(sys.argv[1])
deps = [line.strip() for line in config["testenv"]["deps"].splitlines() if line.strip()]
subprocess.run([sys.executable, "-m", "pip", "install", *deps], check=True)
PY
```

以下命令适用于 Ubuntu 22.04 amd64 上未全局安装 Icarus 的环境。它在临时目录解包 11.0，并补齐该包在非系统前缀下查找 `ivl` 的相对路径。已有兼容安装时，直接设置 `rtlarch_icarus_bin` 为对应的 bin 目录。

```bash
rtlarch_icarus=$(mktemp -d -t rtlarch-icarus-XXXXXX)
(
  cd "$rtlarch_icarus" &&
  apt-get download iverilog=11.0-1.1 &&
  dpkg-deb -x iverilog_11.0-1.1_amd64.deb . &&
  mkdir -p usr/x86_64-linux-gnu &&
  ln -s ../lib/x86_64-linux-gnu/ivl usr/x86_64-linux-gnu/ivl
)
rtlarch_icarus_bin="$rtlarch_icarus/usr/bin"
```

随后用一个入口执行整套基准。兼容的 Icarus 已在 PATH 时可省略 `--icarus-bin`。

```bash
npm run benchmark:external-axis -- --python "$rtlarch_axis_env/bin/python" --icarus-bin "$rtlarch_icarus_bin"
```

入口先按原版 `tox.ini` 从 pytest 执行测试模块，再启动架构分析。在终端给出的新临时目录保留 `summary.json`、原始 pytest 和 cocotb XML、仿真日志与波形、各配置模型和证据。覆盖的检查发生失败或受阻时返回非零，报告仍给出九组；依赖或初始化错误会在终端和对应日志定位。正常无寄存器的旁路配置只通过状态边界检查。

## axis_register 分项验收

| 分项 | 每配置通过条件 |
| --- | --- |
| 上游测试 | 外层 pytest 与内层九个 cocotb 用例均完整通过，仿真器实际编译参数和 XML 中的 seed 与冻结值一致 |
| 结构还原 | 在原始单 DUT 上展开，核对导入层级、18 个端口及位宽方向，再核对还原模型的输出位来源、常量和实际寄存向量。原始导入候选继续保留内部逻辑缺口 |
| 状态比较 | 显式映射每个寄存向量。同步整向量二态单步函数全部 MATCH 才计通过。旁路的零状态发现单列为边界通过 |
| 事务解释 | 从原版波形读取无停顿首笔的接受、可见及消费时刻，再核对背压中负载和 sideband 保持到消费。skid 配置还核对临时槽确实被占用 |
| 原生回放 | 每组导入原版无停顿和背压两段连续采样，以及一段独立定向仿真。要求三段均为 `OBSERVED`，定向场景与独立端口队列核对接受、消费和取消编号。分别验收旁路同沿收发、单槽空拍、双槽保存和同沿转移 |
| 图形阅读任务 | 生成主事务总览，以及寄存状态局部图或旁路原始连接图。报告几何和连接对应，离线页与任务卡提供正向数据、反向 ready、存储、复位和 keep 的定位入口。人工试读另记 |

`original-wave.json` 将原版 FST、XML 及采集摘要登记为 `verify` 输入，`directed.json` 用同一组参数单独运行 [定向场景](directed_replay.py)。各记录的采样时间范围、映射、来源和版本可从 `summary.json` 找到。定向场景包括同值但不同编号、同数据不同 sideband、长反压、恢复及带在途的复位。双槽还生成独立的临时槽状态图。可打开每组的 `reading/index.html` 和 `reading-tasks.json` 对照。

冻结的独立故障在临时 8 位、`REG_TYPE=1` 副本翻转写入输出槽的数据位 0。原版断言须失败，`rtlarch verify` 保存失败 JUnit。报告定位 `top.m_axis_tdata_reg`、`m_axis_tdata[0]` 和帧完整性要求。另外在临时 16 位双槽副本将临时槽的 ID 错接到输出槽 dest。独立定向队列与回放都须检出，回放应保留同一接受编号、沿、字段和状态。原版测试及冻结验收配置按摘要核对。

## axis_fifo 配置与定向验收

原版 [test_axis_fifo.py](upstream/tb/axis_fifo/test_axis_fifo.py) 包含 4 种数据宽度（8、16、32、64）、6 种 RAM 管线与输出 FIFO 组合、6 种帧和丢弃策略，共 **144** 组。每组包含 14 个 cocotb 用例，seed 为 1。工具核对原始 XML、仿真器实际编译参数及输入摘要。复用上节同一 Python 和 Icarus 环境。

```bash
npm run benchmark:axis-fifo -- --python "$rtlarch_axis_env/bin/python" --icarus-bin "$rtlarch_icarus_bin"
```

目录由入口创建在系统临时目录，也可用 `--out` 指定其中一个不存在的目录。需要复用上次原版测试时，提供其 `--upstream` 临时副本与 `--junit` 文件，报告标记 `reranUpstream=false`。新运行仍比较四组 16/32 位普通与帧配置，逐组检查五个已映射状态和独立仿真。原版测试失败时停止后续比较，运行输出保留。

直连端口、写地址、提交、RAM 读入和输出管线按源码定位。四组保留地址化 RAM 行为缺口，原生帧回放为 `UNSUPPORTED`。独立端口队列覆盖持续输入、相同值、等待、地址回绕、丢弃、恢复与复位取消。提前提交故障仅注入临时 16 位帧副本，保留原候选和端口队列。预期的单步 `MISMATCH` 与 `check_failed` 均须出现。原始判定见 [端口队列](../../../scripts/benchmarks/directed_fifo.py) 和 [基准入口](../../../scripts/benchmarks/axis-fifo.py)。

## 页面复跑

`rtlarch_axis_run` 为基准输出的临时目录。在同一构建上运行。Chromium 需可加载本机所需的共享库。

```bash
rtlarch_browser=$(mktemp -d -t rtlarch-axis-browser-XXXXXX)
export PLAYWRIGHT_BROWSERS_PATH="$rtlarch_browser/browsers"
npm install --prefix "$rtlarch_browser" --cache "$rtlarch_browser/npm-cache" --no-audit --no-fund playwright@1.56.1
"$rtlarch_browser/node_modules/.bin/playwright" install chromium --only-shell
npm run check:browser -- axis-register "$rtlarch_browser" "$rtlarch_axis_run" "$rtlarch_browser/observed"
```

FIFO 对应 `npm run check:browser -- axis-fifo "$rtlarch_browser" "$rtlarch_fifo_run" "$rtlarch_browser/fifo.json"`。其输入需来自同一构建的 FIFO 运行。

[当前实测与其他页面场景](../../../VALIDATION.md)
