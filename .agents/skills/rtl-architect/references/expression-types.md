# 位宽、符号与转换

在比较负数、扩展/打包数据、移位或审查溢出时读取。使用同一 `SignalValue` AST；不要用 sourceText 或接口名称暗示类型。查询实际 `schema model`，变更仍通过提案。

端点、切片、常量和拼接是无符号位向量。即使实际 RTL 引脚声明 signed，模型读取该端点时仍需显式转换；局部组合输出的端点也遵守这个边界。运算结果的位宽与 signed 由 AST 推导，不在旧模型补默认字段。

```json
{
  "kind":"cast", "mode":"sign_extend", "width":12, "signed":true,
  "value":{"kind":"endpoint","endpoint":{"moduleId":"top","interfaceId":"sample"}}
}
```

`mode` 指定怎样改变位，`signed` 指定结果怎样参与后续运算，两者独立：

| mode | 约束与行为 |
|---|---|
| reinterpret | 等宽，不改位，只改变符号解释 |
| zero_extend | 严格增宽，高位补 0 |
| sign_extend | 严格增宽，高位复制输入最高位 |
| truncate | 严格减宽，只保留低位；其他位域用切片 |

二元算术、位运算、比较的两个操作数必须等宽、同 signed；MUX 两个数据臂也相同。混合类型会被拒绝，先按设计意图转换。加减在操作数宽度取模；先加后扩展与先扩展后加可能得到不同结果。负常量写成等宽二进制补码位模式再 reinterpret 为 signed，不能写未定宽的负数字符串。

`<<` / `>>` 补零，`>>>` 在左操作数 signed 时复制符号位，否则补零。结果保持左操作数的位宽与 signed，移位量必须 unsigned、可不同宽；移位量大于等于左操作数宽度时仍遵守补位规则。`reduce_and / reduce_or / reduce_xor` 是一元逐位归约，输出 1 位 unsigned；比较和逻辑运算也输出 1 位 unsigned。

评审时先给用户一个能区分意图的数值例子，例如 `8'h80` 按 signed 是 −128，算术右移一位为 `8'hc0`，逻辑右移为 `8'h40`。把转换顺序、舍弃的位以及溢出行为写清楚，再用 [状态提取与比较](state-observation.md) 和实际场景核验。图中状态更新表及 Spec 会显示“符号扩展”“截取低位”等操作，追踪保留其输入依赖。

这是一组明确的二态运算规则，不是完整 SystemVerilog 类型推导或四态解释器。不能靠声明 signed 消除 X/Z、不明确的范围、未映射状态或前端缺口；这些继续保留 UNKNOWN。不要为匹配待验 RTL 而改变独立设计期望。
