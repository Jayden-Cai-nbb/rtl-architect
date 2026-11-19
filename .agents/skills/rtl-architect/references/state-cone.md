# 下一状态逻辑锥

先问要解释哪个寄存向量、哪条更新分支及哪个实例。进入对应作用域，点击状态，在详情栏展开“模型下一状态逻辑”，再点“查看模型下一状态逻辑锥”。它从模型 AST 投影 D 端逻辑，显示 Q 的沿前值、复位、优先级 MUX、保持及显式转换。移位量和位宽、符号、截断按模型节点核对。未声明 `register.update` 的输入集合继续是未分角色的依赖；`sourceText` 供核对，工具不会执行它。

普通选中查看成员和来源。上游 Q 是时序边界；只有显式操作才查看它自己的 D 值，当前状态仍使用该上游沿前 Q。到达节点、边或宽度预算时保留 UNKNOWN 和边界。状态范围投影显示局部结构，逻辑锥显示 D 端表达式。页面提供锥，CLI 没有独立的 `state-cone` 命令。

若要核对 RTL，读[状态观察](state-observation.md)。`verify` 展开当前源码和配置后，用 `observe-state` 发现或映射真实向量，再在“核验状态 → RTL 状态比较”打开 RTL 观察锥。报告各自的实例路径、映射、时钟、来源与边界。比较的是合法域内的二态单步函数；差异反例另看可达性，MATCH 仍需场景测试。缺产物、无映射、X/Z、跨域或未知单元时，保留原缺口。显式位宽语义见[数值类型](expression-types.md)，规则作者见[状态更新闭环](state-updates.md)。

在工具仓库根目录查询可用格式并打开有声明规则的临时样例。

```bash
source ./env.sh
workspace=$(mktemp -d -t rtlarch-cone-XXXXXX)
cp -R examples/state-updates/. "$workspace/"
rtlarch help observe-state --json
rtlarch schema stateObservation --json
rtlarch open --workspace "$workspace" --json
```

用返回的 reviewUrl 点选 `out_data` 并打开模型锥。完成后可用 `rtlarch stop --workspace "$workspace" --json` 停止此临时服务。仅打开图没有运行 RTL 仿真或比较。
