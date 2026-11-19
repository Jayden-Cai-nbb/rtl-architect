# RTL Architect 2.1.0

2.1 增加回放能力预检、源文件展开复用及可追溯阅读步骤，并改进多指针的有限二态单步比较。现有模型、布局和回放映射继续使用原格式。新模型的阅读步骤仍经提案保存，独立于几何检查和批准。

## 回放能力

```bash
rtlarch help replay --json
rtlarch replay --semantics registered_skid --workspace . --json
rtlarch replay --semantics addressed_frame_fifo --workspace . --json
```

预检返回 `DECLARED`、`NOT_DECLARED` 或 `UNSUPPORTED`，可加 `--module ID` 指定范围。清单导入缺路径时返回 `REPLAY_PATH_NOT_DECLARED`，超范围返回 `REPLAY_UNSUPPORTED`。网页按同一规则提示，可手工选择语义。地址化 RAM FIFO 及帧 FIFO 继续使用 `verify` 保存独立端口队列、JUnit 与采样产物。网页的独立仿真记录保留失败和历史运行状态，回放记录仍使用检查器 3。

## 复用一次展开

在工具目录加载环境。以下命令复制现有 `state-updates` 公开样例，将来源清单加入既有 Yosys 配方。

```bash
source ./env.sh
rtlarch_review=$(mktemp -d -t rtlarch-review-XXXXXX)
cp -R examples/state-updates/. "$rtlarch_review/"
python3 - "$rtlarch_review" <<'PY'
import json
from pathlib import Path
import sys

workspace = Path(sys.argv[1])
inputs = dict(top='add_const', configuration='8-bit add-3 fixture',
              parameters=dict(DATA_W=8, CONST=3), defines=[], includeDirs=[],
              files=['rtl/add_const.sv'], assets=[])
(workspace / 'inputs.json').write_text(json.dumps(inputs))
profile = json.loads((workspace / 'elaboration.json').read_text())
profile['elaborationInputs'] = 'inputs.json'
profile['inputs'] += ['inputs.json', 'source-elaboration.json']
(workspace / 'source-elaboration.json').write_text(json.dumps(profile))
PY
rtlarch verify "$rtlarch_review/source-elaboration.json" --workspace "$rtlarch_review" --json > "$rtlarch_review/run.json" &&
python3 - "$rtlarch_review" <<'PY'
import json
from pathlib import Path
import sys

workspace = Path(sys.argv[1])
run = json.loads((workspace / 'run.json').read_text())
(workspace / 'import-input.json').write_text(json.dumps(dict(schemaVersion=2, runId=run['id'], netlist='state.json')))
PY
rtlarch import-yosys "$rtlarch_review/import-input.json" "$rtlarch_review/imported" --workspace "$rtlarch_review" --json
rtlarch observe-state "$rtlarch_review/imported/state-discovery.json" --workspace "$rtlarch_review" --json
```

`elaborationInputs` 声明命令只依赖源文件配置。输入闭包须登记清单和实际编译文件，且排除已保存模型、生成合同和服务状态。导入 v2 复用生产运行、顶层、核对过的数字参数、实际层级和端口对应。`conformance.json` 与 `state-discovery.json` 是审阅起点，时钟、复位和状态仍显式核对。空映射返回状态发现。

草稿保存后，在映射用 `reuseElaboration: true` 复用同一网表。新比较记录含 `producerModelHash`、当前 `modelHash` 及 `reusedElaboration`。改动配置、输入或网表须重新展开。原始运行保持原模型依据，已保存的仿真与批准继续按各自的 hash 核对。

## 按阅读任务查缺口

展开产物中的真实存储可以生成源码定位和未还原读写关系。按源码明确声明 `provenance.readingTasks` 后，网页可定位每步对象、原始链接及证据。用 `diagram-quality --task overview --reading-task <ID>` 检查当前投影能否跟读。所需对象或关系未显示、存储尚未表达时，报告保留实际缺口。未声明任务的 `taskEvidence` 为 `unassessed`，几何结果仍按原标准报告。SVG 和离线包带同一份阅读记录。

## 比较器升级

`yosys-proc-bdd-v3` 交织不同向量的同权位，减少多指针比较中的布尔函数开销。节点与计算预算保持，超限仍为 `UNKNOWN`。2.0 及更早的状态比较继续可读并标记 `STALE`，在当前来源上运行 `observe-state` 可生成新比较。有限比较、反例可达性、器件时序与批准各有证据。

[原 `axis_fifo` 试用基线](evidence/axis-fifo-skill-trial/README.md) · [版本验证索引](../VALIDATION.md)
