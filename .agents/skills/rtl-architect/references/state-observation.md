# 从真实 RTL 发现状态并核对更新

先选用户关心的一小段控制或数据状态，核对源码与实际构建配置。`observe-state` 使用成熟 HDL 前端的展开产物，不解析 sourceText，也不从信号名字猜 enable/reset。输出是只读派生证据；设计模型仍是唯一权威。

## 最短路径

1. 读取实际 filelist、include、宏、参数、顶层、生成脚本和数据文件。把影响结果的文件列入 `verify` inputs，命令参数保存完整配置，工具提供 versionArgs。不明确的闭包写 partial。
2. 用 stage=elaboration 的显式 `verify` 清单运行 Yosys：读取实际 RTL → hierarchy → proc → check → write_json。读取 SystemVerilog 受前端语言支持限制；不要自动执行陌生脚本。保留 proc 后的 $dff、字级单元及源码属性；不要默认 opt/techmap。若 proc 产生控制条件不可能选中的 X 分支，可显式运行 opt_muxtree 并记录命令；它只删除不可能选中的 MUX 输入，不能用 setundef 或任意值替换有效路径的 X。
3. 查询 `schema stateObservation`，填本次 runId、产物相对 runDir 的路径 netlist、top、相对 top 的 instancePath（顶层为 []）。先用 `mappings: []` 发现该作用域状态、宽度、时钟、源码位置和支持缺口。
4. 需要比较时填 mappings：moduleId、localSignalId、真实 state、clock，以及 signals 的 `{endpoint,pin}`。pin 为该 RTL 作用域内的完整名称；被检查状态只用 state 映射，其他端点映射为等宽输入或同域寄存器。组合模型必须内联，不能用同名 RTL 中间信号替代期望。
5. `observe-state mapping.json --workspace <项目> --json` 保存新报告。`assurance` 与网页“行为约定 → 核验状态 → RTL 状态比较”按每个声明状态显示最新结论、覆盖缺口、反例及源码；局部重测或仅发现不会隐藏别处失败。先讲清一个差异的行为后果，再按用户问题展开其他状态。

可直接运行的清单位于工具 `examples/state-updates/elaboration.json`、`state-mapping.json`。示例 runId 是占位符，必须替换为实际 verify 返回值。有映射时 UNKNOWN/MISMATCH 均返回非零退出码；空映射仅表示完成发现，不能当成设计匹配。

## 如何解释结果

| 结果 | 含义与下一步 |
|---|---|
| MATCH | 对显式映射寄存器，所有二态输入/旧状态组合的单步函数相同；继续检查未映射状态、跨周期行为及真实场景 |
| MISMATCH | 位宽、采样沿或单步函数不同；函数差异附具体输入、旧状态、期望下一拍值与 RTL 值。先核对映射，再用仿真回放；反例状态能否到达未证明 |
| UNKNOWN | 输入闭包、版本/映射不完整，或运算/四态/时钟/资源预算超出支持范围；按具体原因缩小范围或使用项目原有验证 |
| STALE | 模型、源码、配置或展开产物已变化；重新展开和比较，不更新摘要来复用旧通过 |

从现有 RTL 还原出来的模型，即使 MATCH 也只是还原一致性。验证设计承诺时保留原需求与已审阅规则；观察不符时不能反抄 RTL 使检查变绿。比较报告记录当时本地审阅依据，事后批准需要重新比较。需求文字与规则是否对应仍由人核对。

## 明确边界

在各显式实例内独立支持完整向量 `$dff` 和直接输入时钟。逻辑包括 MUX、可证明选择互斥的 PMUX、位/逻辑/归约运算、加减、比较及 $shl/$shr/$sshl/$sshr 字级移位；保留 Yosys 的位序、符号和扩展/截断参数。模型表达式的显式转换与 signed 规则见 [数值类型](expression-types.md)。同步复位、使能、优先级和保持通过实际 D 端逻辑比较；不按 RTL 语句外形猜语义。

X/Z、异步单元、锁存、跨时钟、未知/多驱动、组合环、未支持运算均不近似判过。不还原所有微架构，不证明初始状态、四态行为、可达性、完整时序等价或 STA。综合前端已经降低的行为不能反推成精确原始语句；源码位置用于核对，不能把同一过程行号当作完整证明。

每向量最多 256 位、单状态输入逻辑最多 256 单元，布尔函数最多 50,000 节点 / 500,000 次递归运算；每报告最多 16 个实例作用域，总计发现 64 状态、映射 32 状态，截断明确显示。超过预算缩小作用域；不会自动隐藏复杂部分或改变架构批准。

## 多实例与升级

v1 保留；v2 使用 `{schemaVersion:2,runId,netlist,top,scopes:[{instancePath,mappings}]}`。每个映射明确对应模型 moduleId/localSignalId；实例路径、物理状态别名和模型对象不能重复映射。同一定义的不同实例有独立作用域，内部 bit ID 不代表跨实例同网。不做跨层逻辑锥拼接。

2.0 比较器升级后，旧记录显示 STALE；重新 verify/observe-state，不删除历史或自动提升批准。assurance 最多读取最近 100 份记录，找不到的声明状态保持未比较；空映射发现不算通过，缺失实例路径会失败。汇总分母是有 update 的模型寄存器，另看已扫描 RTL 作用域的状态总数；不是全设计覆盖率。

参考工具 `examples/external-axis/README.md`：固定 MIT 上游、双实例、独立事务队列和故障/修复。局部状态差异可以在端到端抵消，不能仅凭某一项绿灯宣称实现正确。
