# axis_fifo 任务验证与 skill 实测

2026-11-19，从已安装的 `rtl-architect` skill 进入，按独立任务草案运行。冻结上游 **144/144** 配置通过，共 **2,016/2,016** 个 cocotb 用例。首阶段四个配置均可用独立仿真解释多槽与帧边界，**原生回放 0/4，均为 `UNSUPPORTED`**。结构还原到端口、地址和部分管线，RAM 读写关系仍为 `partial`。这是带既有开发上下文的一次实际操作，两次 Chromium 脚本核对覆盖原版与故障页。用户试读和独立 Agent 盲测均未执行。[任务定义](../../axis-fifo-task.md) · [实测摘要](result.json) · [固定上游参数矩阵](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/tb/axis_fifo/test_axis_fifo.py#L450-L507)

## 基线、结构和状态

固定 `alexforencich/verilog-axis` 提交 `48ff7a7e2ef782cf778d47910cf85835c64b1bce` 的 RTL、testbench、Makefile、`tox.ini` 和许可证。运行前后逐个核对 SHA-256。在 Python 3.10.12、Icarus/vvp 11.0、cocotb 1.7.2、cocotbext-axi 0.1.20 下用原版 pytest `-n 8` 运行 460.88 秒。核对全部外层 JUnit，逐配置检查内层 14 个实际用例、XML 中的 seed 1，以及编译后的 `.vvp` 参数。原版运行有 30 条日志截断警告，完整用例 XML 仍可逐组核对。[冻结摘要](frozen-sha256.txt) · [144 组参数与实际结果](upstream-matrix.json) · [外层 JUnit](upstream-junit.xml)

首阶段沿用上游的 `RAM_PIPELINE=1`、`OUTPUT_FIFO_ENABLE=0`、`PAUSE_ENABLE=1`、`FRAME_PAUSE=1`，定向输入固定 `pause_req=0`。普通模式关闭帧与丢弃选项。帧模式启用 `FRAME_FIFO`、`DROP_OVERSIZE_FRAME`、`DROP_BAD_FRAME`，保留上游 `USER_BAD_FRAME_MASK=USER_BAD_FRAME_VALUE=1`。16/32 位的 `KEEP_WIDTH` 为 2/4，`DEPTH` 为 2048/4096 个数据字。两组均展开为 1024 个 RAM beat、10 位地址、11 位读写和提交指针、两个带 valid 的管线级。RAM 每字分别打包 36/54 位，含 `data/keep/last/id/dest/user`。[地址与负载打包](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_fifo.v#L129-L240) · [读取及有效位更新](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_fifo.v#L372-L415)

| 宽度与模式 | 原版 cocotb | 结构 | 状态比较 | 事务解释 | 原生回放 | 图形 |
| --- | ---: | --- | --- | --- | --- | --- |
| 16 位普通 | 14/14 | 25 端口、RAM 尺寸核对；`conform UNKNOWN` | 3 `MATCH`、2 `UNKNOWN` | 独立定向通过 | `UNSUPPORTED` | 总览、局部和离线包可生成 |
| 16 位丢弃帧 | 14/14 | 同上，read/write RAM 缺口保留 | 3 `MATCH`、2 `UNKNOWN` | 独立定向通过 | `UNSUPPORTED` | 同上，浏览器定位 `publish` 和源码通过 |
| 32 位普通 | 14/14 | 25 端口、RAM 尺寸核对；`conform UNKNOWN` | 3 `MATCH`、2 `UNKNOWN` | 独立定向通过 | `UNSUPPORTED` | 总览、局部和离线包可生成 |
| 32 位丢弃帧 | 14/14 | 同上，read/write RAM 缺口保留 | 3 `MATCH`、2 `UNKNOWN` | 独立定向通过 | `UNSUPPORTED` | 总览、局部和离线包可生成 |

`observe-state` 每组比较 5 个显式映射。`rd_ptr_reg`、`depth_reg`、`depth_commit_reg` 合计 12 个 `MATCH`。`wr_ptr_reg` 和 `wr_ptr_commit_reg` 合计 8 个 `UNKNOWN`，原因为“布尔函数节点超过预算”。32 位帧配置单独比较提交指针，随后另建 `opt_muxtree; wreduce` 展开记录，仍分别观察到相同预算限制。普通配置发现每组 27 个展开状态向量，帧配置 21 个，包含 Yosys 降低过程产生的内部向量。发现不计作比较。`conform` 的端口、显式参数和时钟匹配，派生参数与局部逻辑链接留有 `UNKNOWN`。以 16 位帧配置为例，51 项 `MATCH`、19 项 `UNKNOWN`。其中三项派生参数在此试用中保留导入的二进制字符串，尚未显式类型化，另 16 项为局部连接。RAM 内存字及访问关系仍需独立证据。[结构、状态和预算尝试](result.json)

## 定向仿真与故障

独立端口队列按 `valid && ready` 编 beat，按接受的 `last` 划帧。前两笔完整负载相同，后续 beat 的 sideband 有变化。端口队列核对输出可见性、逐 beat 字段、反压保持、丢弃状态脉冲和复位取消。内部采样另外记录三指针、两级 valid、packed 数据和端口深度。全部场景连续采 E−/E+，每组结束无在途。[定向测试及独立端口队列](directed_fifo.py) · [逐沿证据](directed-excerpts.json)

| 模式，两宽结果相同 | 接受 | 消费 | 坏帧丢弃 | 超长帧丢弃 | 复位取消 | 采样沿 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 普通 | 1,035 | 1,031 | 0 | 0 | 4 | 2,122 |
| 丢弃帧 | 2,067 | 1,033 | 2 | 1,026 | 6 | 3,184 |

- **空载首笔**。普通模式 E2 接受，E4+ 可见，E5 消费。帧模式 E2 接受首 beat，E10 接受 `last` 并提交，E12+ 首次可见，E13 消费。帧等待期间读口的无效负载可能变化，valid 保持为 0。
- **满载和恢复**。四组均观测到 RAM 1024、管线 2 同时占满，最长输出阻塞 1,043 沿。E1065 首次恢复，出口消费且 RAM 读指针前进，入口沿前 ready 仍为 0。E1066 入口握手，并与 RAM 读同沿。另观测到低 10 位地址从 1023 回到 0。报告深度取沿前指针差，乘 `KEEP_WIDTH`，管线占用独立计算。
- **帧丢弃与复位**。16 位帧配置的坏帧在 E2102+ 把写指针从 1031 回滚到 1030，并脉冲 `status_bad_frame`。超长帧在 E3143+ 回滚并脉冲 `status_overflow`，两次之后均有好帧消费。E3172+ 清除三指针和管线 valid，取消两笔管线、两笔已提交 RAM、两笔未提交 RAM 各自的身份。该沿 `status_depth=8`、`status_depth_commit=4` 仍反映沿前差值，随后更新为 0。[写入、提交及回滚](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_fifo.v#L261-L370)

在独立临时 16 位帧副本改动第 289 行，使每次存入都尝试提交。保留原模型 hash 与独立端口队列。第 0 帧第 0 beat 在 E2 接受，对应原 RTL 写地址 0。E2+ `wr_ptr_commit_reg` 原版为 0、故障版为 1。E3+ 可见读指针和首级 valid 的差异。E4+ 独立端口 oracle 报 `VISIBLE_BEFORE_ELIGIBLE`，原版 `m_axis_tvalid=0`、故障版为 1，E10 才到原定 `last`。`verify` 保留 `check_failed`、JUnit、输出和逐沿产物。`wr_ptr_commit_reg/publish` 的关联来自同一刺激、沿前后证据与 RTL 行。故障版单步比较仍是 3 `MATCH`、2 `UNKNOWN`。[故障摘要和逐沿对照](result.json) · [关键沿](directed-excerpts.json)

## 实际使用路径与阻力

| 步骤 | 实际体验 |
| --- | --- |
| 从 skill 路由找能力 | `help --json`、命令 help 与具名 schema 都可执行。`inventory` 无需工作区模型，能核对构建文件。`replay` help 给出导入用法，支持的事务形态仍需阅读参考文件或逐项解析联合 schema。 |
| 从上游到可审阅候选 | `verify → import-yosys` 能核对 25 个引脚与方向。16 位原始导入只连出两条状态深度低位常量，仍给出几何与模型连接对应 `passed`。直接要求提交指针局部图，返回“局部范围必须选择当前层级已记录的寄存状态”。按源码补出 5 条显式状态更新及部分真实连接后，局部状态可用。第一次试验适配器误以为原始连接为空而中止，修正后保留原常量边。 |
| 候选与证据接续 | 用 `draft --open` 的候选 hash 和工作区 ID 核对，验证用副本经 API 保存草稿。首份展开绑定初始空草稿；为当前模型比较又各做一次展开。五个副本实际执行 **82 次 CLI 调用**，合计约 92 秒，其中含核验、图形报告、负例和关停，排除上游 pytest 与浏览器。`as_built/partial` 和 `DRAFT` 保留。 |
| 碰到 `UNSUPPORTED` | 现有 schema 提供级联单槽、旁路、单槽和双槽。试传明确的 RAM 帧语义得到 `SCHEMA_INVALID`，discriminator 无匹配。用实际 `verify` 的采样产物请求对应路径，CLI 返回 `COMMAND_FAILED`“未声明事务路径；先通过 preview/commit 更新 contract.transactionPaths”。回放列表为空。页面也提示先声明路径，实际需要能力边界或独立证据入口。 |
| 页面与图形 | 1440×1000 下，原版和故障均能用状态选择定位 `wr_ptr_commit_reg/publish`，访问源码 hash 与 `verify` 记录。故障运行显示 `check_failed`、输入仍匹配，原版来源文件在故障工作区显示已变化。查看记录需展开“核验记录与语义缺口 → 全部状态与行为证据”，首轮脚本漏开外层而超时。两例随后完整通过。 |

16 位帧样本补充后的总览有 2 个对象位置、13 条路由、9 处交叉和 2 条隐藏线名，最长线 1408，生成约 326 ms。提交指针局部图有 8 个对象位置、37 条路由、130 处交叉、0 条隐藏线名，最长线 4569，生成约 496 ms。两者的可见对象不同，读数反映投影范围和拥挤。当前图可定位控制与声明，逐 beat 穿过 RAM 的阅读任务需结合沿和源码才可完成。[浏览器记录](browser.json) · [16 位帧离线图](frame16.svg) · [图形原始指标](result.json)

## 优化优先级

| 优先级 | 优化及验收建议 |
| --- | --- |
| **P0 · 先做** | 在 skill 和机器 help 提供简短能力预检。把“可表达但未声明”和“RAM/帧语义超出能力”给出各自状态，页面空态提供独立 `verify` 证据入口。用本次未声明 FIFO 和一个合法但尚未登记的单槽路径核对，两例都有正确后续入口。 |
| **P1 · 高收益** | 提供可复用的 `verify → import → observe/conform` 清单起点。复用源文件、参数、端口和生产记录引用，仍逐项确认状态语义与新鲜度。用 16 位帧试用衡量减少的重复填表与重跑，并验证配置或源码变化后旧证据仍失效。给现状图显式的 RAM 缺口指向和“任务可完成性”，用“写地址 → 提交 → 读入管线”走查，保留真实关系。 |
| **P1 · 纳入下一轮验收** | 专测 11 位多指针比较预算。单状态和 `wreduce` 已复现 `UNKNOWN`，值得比较位交织变量排序或等价函数判定策略。固定同一输入和预算上界，要求四组正常指针得到可解释结果，提前提交得到可定位的反例，超限继续明确 `UNKNOWN`。 |
| **P2 · 能力扩展** | 确有交互需求时再引入版本化 FIFO 回放。以本次四组定向轨迹先冻结可核对的 RAM、提交、管线和 reset 事件，复用独立端口 oracle 校验身份与丢弃。原版 144 组保留上游分母，FIFO 原生范围逐步扩展。 |

任务草案可先补三项明确约定。锁定四个 pytest 配置 ID 和每配置 14 个上游用例的计数依据。单列 `DEPTH` 数据字、RAM beat、前一沿 `status_depth*` 与管线占用。对图形任务明确期望用户能定位写地址、提交和读入阶段，并单列 RAM 未表达时可交付的源码与轨迹证据。

## 复跑

从工具根目录加载 `env.sh`。按固定 tox 准备 Python 3.10 和可执行的 Icarus 11.0，Yosys 在 PATH。`rtlarch_axis_env` 与 `rtlarch_icarus_bin` 取本地实际目录。[环境准备](../../../examples/external-axis/benchmark/README.md#运行)

```bash
source ./env.sh
rtlarch_fifo_evidence="$PWD/docs/evidence/axis-fifo-skill-trial"
rtlarch_fifo_cli="$HOME/.agents/skills/rtl-architect/scripts/rtlarch"
rtlarch_fifo_trial=$(mktemp -d -t rtlarch-fifo-trial-XXXXXX)
rtlarch_fifo_upstream=https://raw.githubusercontent.com/alexforencich/verilog-axis/48ff7a7e2ef782cf778d47910cf85835c64b1bce
mkdir -p "$rtlarch_fifo_trial/upstream/rtl" "$rtlarch_fifo_trial/upstream/tb/axis_fifo"
for rtlarch_file in rtl/axis_fifo.v tb/axis_fifo/test_axis_fifo.py tb/axis_fifo/Makefile tox.ini COPYING; do
  curl --fail --show-error --location -o "$rtlarch_fifo_trial/upstream/$rtlarch_file" "$rtlarch_fifo_upstream/$rtlarch_file" || break
done
(
  cd "$rtlarch_fifo_trial/upstream" &&
  sha256sum -c "$rtlarch_fifo_evidence/frozen-sha256.txt" &&
  PATH="$rtlarch_icarus_bin:$PATH" SIM=icarus RANDOM_SEED=1 PYTHONHASHSEED=1 \
    "$rtlarch_axis_env/bin/python" -m pytest -c tox.ini -n 8 --tb=short -q --junitxml=../upstream-junit.xml tb/axis_fifo/test_axis_fifo.py
) &&
python3 -B "$rtlarch_fifo_evidence/run_trial.py" --upstream "$rtlarch_fifo_trial/upstream" \
  --junit "$rtlarch_fifo_trial/upstream-junit.xml" --out "$rtlarch_fifo_trial/cases" \
  --python "$rtlarch_axis_env/bin/python" --icarus-bin "$rtlarch_icarus_bin" --cli "$rtlarch_fifo_cli"
```

页面复跑使用上一步的输出和当前构建。`rtlarch_browser` 为已准备的临时 Playwright 1.56.1 目录，Chromium 需具备本机共享库。[浏览器依赖准备](../../../examples/external-axis/benchmark/README.md#页面复跑)

```bash
node "$rtlarch_fifo_evidence/browser.mjs" "$rtlarch_browser" "$rtlarch_fifo_trial/cases" \
  "$rtlarch_fifo_cli" "$rtlarch_fifo_trial/browser.json"
```

本次工具 2.0.0，构建 `70881737fec906e785d6f0459de9653bfa9fdcc24aee4ecb08a5b6f10452611d`，检查器 3，Node 24.18.1、npm 11.6.2、Yosys 0.68+206，Chromium 141.0.7390.37。实际完整运行目录为 `/tmp/rtlarch-fifo-trial-o5c9sQ`，结果中引用的相对路径以它为根。摘要、复跑脚本、原版 JUnit 和逐沿摘录随报告保留。所有模型和故障操作在临时副本中执行，运行后核对了工具根目录模型、布局和原版五文件的摘要。真实工作区无提交和批准。[实际 argv 与返回值](commands.json) · [skill、构建和输入身份](result.json)
