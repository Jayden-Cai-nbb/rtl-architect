# 比较候选并记录用户决策

先冻结同一输入配置、工作范围和待决定的问题。A/B 各用完整模型，`compare` 只读语义差异和硬件影响；与当前工作区提交基线分别记录。图形使用固定层级、任务和布局来源核对。两版方案的时延、资源、风险和验收差异应能说明哪项选择会改变实际行为。

在页面“讨论与继续 → 决策记录”关联已有问题。两个选项各保存登记的 `proposalId` 与 `modelHash`、假设、风险，以及可选预算或实验。预算绑定该选项的 studyId/optionId；实验用独立 verify runId 与模型 hash，按来源新鲜度核验，保留失败和过期。旧候选或改版预算需要重新评估，原记录留存。不能把预算下界或另一候选的结果用于本候选的验收。

查询 `schema decision` 可看输入。CLI 通过 `workbench` 提交包有 `baseHash` 和 `action` 的文件，登记动作是 `kind=decision`。选择动作 `kind=choose_decision` 只在用户明确选择并给出理由时记录，旧选择按时间保留。记录选择和提交架构是不同操作，后者仍按[提案约定](proposal-guide.md)由用户核对。

在工具仓库根目录核对差异入口。示例只修改临时候选 B 的职责展示名称，比较输出可核对其影响范围。

```bash
source ./env.sh
workspace=$(mktemp -d -t rtlarch-decision-XXXXXX)
cp examples/packet-pipeline/model.json "$workspace/a.json"
python3 - "$workspace" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
model = json.loads((root / "a.json").read_text())
model["modules"][0]["name"] += "（候选 B）"
(root / "b.json").write_text(json.dumps(model, ensure_ascii=False))
PY
rtlarch help workbench --json
rtlarch schema decision --json
rtlarch compare "$workspace/a.json" "$workspace/b.json" --json
```
