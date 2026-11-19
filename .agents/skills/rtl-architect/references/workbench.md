# 对象讨论与继续工作

用 `resume` 查看待办、未解决问题、候选状态、验证和保存的下一步。服务不可用时用 `resume --offline` 或 `workbench --offline` 读取磁盘；改写前回到当前工作区服务。页面用 `open` 核对工作区、工具和页面构建。找到旧服务后只在需要继续该工作区且显式指定 `--restart` 时重启；先保留未提交输入。

## 从图中提问

点选模块、原始连接、关系束或状态，详情栏提供“对此提问”。分支、需求和义务也有自己的入口。图、详情、提问和继续位置使用同一版本化选择，带 modelHash、scope、精确实例路径和原始成员。跨层沿实际端点定位；同 RTL 定义的不同实例仍是不同对象。扩大追踪范围需要显式操作，普通点选保留布局。可拖动讨论面板并按工作区保存高度，证据详情按需展开。

用“保存问题”记录当前对象，草稿按对象保留。回到 Agent 后读取工作记录并答复；页面不会运行模型。按用户需要关联候选或验证证据，说明结论、成立条件和待核对项。Agent 答复等待用户核对，用户决定是否标记解决。

## 续接、版本与并发

通过“继续工作”保存当前对象、这一轮目标和下次可执行步骤。`rtlarch open --workspace "$workspace" --json` 返回工作区绑定的 reviewUrl。继续位置及讨论链接可带 `panel=work`、`checkpoint` 或 `thread` 等参数。保留完整地址，恢复的是所记录的版本、层级与分支。过期对象或候选保留历史；不按同名对象重绑。候选目标使用登记的 proposalId 与对应候选 hash。

CLI 提交有效的 `workAction`，外层 `baseHash` 取当前 `workbenchHash`。新选择可核对 `schema selection`，旧的 moduleId、connectionIds 或 object 记录仍可读取。沿用已保存的实际目标字段。回复用 `kind=reply` 及 threadId、author、text、modelHash，可带登记候选的 proposalId；Agent 的 author 为 agent。冲突时保留未发文字，重读后按当前记录继续。讨论动作和继续位置保存在 `architecture/workbench.json`，与模型、布局和批准各自独立。

在工具仓库根目录可运行这个临时演示。它读取实际版本、记录顶层问题并离线查看。

```bash
source ./env.sh
workspace=$(mktemp -d -t rtlarch-work-XXXXXX)
rtlarch help workbench --json
rtlarch schema workAction --json
rtlarch schema selection --json
rtlarch init --workspace "$workspace" --json
rtlarch workbench --workspace "$workspace" --offline --json > "$workspace/before.json"
python3 - "$workspace" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
state = json.loads((root / "before.json").read_text())
version = state["modelHash"]
scope = "top"
ref = {"modelHash": version, "scope": scope, "instancePath": [{"moduleId": scope}],
       "target": {"kind": "module", "id": scope}}
question = {"kind": "ask", "title": "顶层事务从哪条输入开始", "text": "请指出入口和第一个保存边界。",
            "target": {"modelHash": version, "moduleId": scope, "connectionIds": [], "selection": ref}}
(root / "ask.json").write_text(json.dumps({"baseHash": state["workbenchHash"], "action": question}))
PY
rtlarch workbench "$workspace/ask.json" --workspace "$workspace" --json
rtlarch resume --workspace "$workspace" --offline --json
rtlarch stop --workspace "$workspace" --json
```

预算和方案选择分别按[资源与存储预算](resource-budget.md)及[候选决策](decisions.md)。实际实验使用明确的 [verify 清单](verification.md)，由用户提供输入与运行范围。
