# 从真实状态更新读懂可停顿加法级

随附 RTL 来自通用 tiny-stream 的 add_const，未改变功能。模型固定 DATA_W=8、CONST=3，由源码逐行整理更新规则；没有自动 HDL 行为提取。保持 as_built/partial，不自动批准。

把此目录复制到自己的临时目录，在副本执行（检查器输出须为新目录）：

```bash
rtlarch checks bindings.json checks --workspace . --json
rtlarch verify verification.json --workspace . --json
rtlarch assurance --module top --workspace . --json
rtlarch open --workspace . --json
```

页面点击“输出数据寄存器”：复位时清零；s_ready && s_valid 时写入输入加三；其他情况保持。再看“输出有效寄存器”：它在 s_ready 时写入 s_valid，更新条件与数据寄存器不同。“数据从哪里来”和“什么时候更新”分别突出写入值与控制路径，点击 update_rtl 回到实际 always_ff。

图上的条件装载标签来自规则结构，规则不自动声称通过。运行 verify 后，在“本层行为与参数 → 行为约定 → 核验状态”查看本次状态监视结果；这不授予架构批准。生成检查器在有效沿采样，在相反沿比较，要求复位、装载、保持均被触发。TB 在非采样沿驱动并避开比较沿结束。

特别安排先保存输入 5，再让输入 9 等待下游：如果 DUT 在背压期间误写，就会把应保持的结果 8 改成 12。相同输入重复写入可能掩盖此错误，仅统计保持分支不足以验证它。维护脚本还在临时副本注入错误数据、保持、复位与优先级，故障源码不会留在示例里。

本例验证整向量同步状态规则，不证明完整 RV 协议、任意参数或所有序列等价。输入闭包和引脚映射仍需作者核对；已有普通输入集合继续显示为角色未知。真实项目修改应经过提案审阅。

## 1.6 覆盖与检查依据

此例仍是 as_built / partial：通过表示还原规则在本次输入下与 RTL 一致，不表示原始需求已验收。`assurance --json` 及页面“行为约定 → 核验状态”可查看分支、复位、保持的命中/缺口与检查依据。缺少激励会返回 coverage_incomplete；常量能证明不可达时单独列出原因。

工具维护新增 `npm run check:reliability`：在临时副本检查无条件计数器、优先级竞争，以及“已批准加五期望 vs 错误加三实现”。不修改本例权威文件，不自动批准用户设计。版本更新后使用新目录重新运行 checks 并更新 verification.json 的路径；旧生成检查器不会冒充当前规则。

<a id="observe-state"></a>

## 从 RTL 提取状态并比较（1.7）

在工具根目录、Node/npm 与 Yosys 已就绪时，把通用样例复制到临时工作区。以下操作不改原样例或真实项目：

```bash
source ./env.sh
rtlarch_demo_dir=$(mktemp -d /tmp/rtlarch-state-demo-XXXXXX)
cp -R examples/state-updates/. "$rtlarch_demo_dir/"
rtlarch verify "$rtlarch_demo_dir/elaboration.json" --workspace "$rtlarch_demo_dir" --json > "$rtlarch_demo_dir/elaboration-result.json"
python3 - "$rtlarch_demo_dir" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
mapping = json.loads((p / 'state-mapping.json').read_text())
mapping['runId'] = json.loads((p / 'elaboration-result.json').read_text())['id']
(p / 'state-mapping.json').write_text(json.dumps(mapping, indent=2))
PY
rtlarch observe-state "$rtlarch_demo_dir/state-mapping.json" --workspace "$rtlarch_demo_dir" --json
rtlarch open --workspace "$rtlarch_demo_dir" --json
```

打开返回的 reviewUrl，选顶层模块，在“行为约定 → 核验状态 → RTL 状态比较”查看两个寄存器的单步更新匹配。展开每项看从 RTL 提取的更新表达式与源码位置。本例是 **as_built 还原一致性**，不代表独立设计需求验收。

要先发现尚未建模的状态，将临时映射的 mappings 设为 []，重新 observe-state；这会列出状态及支持缺口，不声称设计匹配。要试差异，在临时副本中把 RTL 的 CONST 默认值 3 改为 5，保留模型期望，再运行 verify、更新 runId、observe-state：应返回 MISMATCH 和具体反例。**不要把期望也改成 5 来消除差异**。改源码但未重新展开时，旧结果会显示过期。

差异命令返回非零退出码；这表示比较有差异或未知，详细 JSON 仍完整输出。整个过程不自动保存提案或批准。单步反例不证明旧状态可达；原有仿真监视器继续检查真实运行场景。范围与限制见 [状态提取说明](../../.agents/skills/rtl-architect/references/state-observation.md)。
