# 固定上游 RTL：双实例流寄存器

上游为 [alexforencich/verilog-axis](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_register.v)，固定提交 `48ff7a7e2ef782cf778d47910cf85835c64b1bce`。`vendor/axis_register.v` 原样保留 MIT 许可；摘要、参数和来源见 `upstream.json`。

`rtl/axis_pair.sv` 串接两个 REG_TYPE=1 简单寄存级，8 位数据、禁用 sideband；会插入空拍，不是每拍吞吐的 skid buffer。模型还原每级 data/valid/ready 三项状态；没有数据复位，valid/ready 同步高有效复位。模型保持 as_built / partial，不声称独立需求已批准。

复制整个示例到工作目录，再使用工具入口：

```bash
rtlarch open --workspace <样例副本> --json
rtlarch verify <样例副本>/elaboration.json --workspace <样例副本> --json
# 将 state-mapping.json 的 runId 替换为 verify 返回的实际 id
rtlarch observe-state <样例副本>/state-mapping.json --workspace <样例副本> --json
rtlarch verify <样例副本>/verification.json --workspace <样例副本> --json
rtlarch assurance --workspace <样例副本> --json
```

网页双击寄存级进入内部状态；选择状态查看更新条件、优先级与保持。行为约定中的核验面板显示逐状态证据；局部重测不会抹掉另一实例的失败。

v2 清单用 `scopes: [{instancePath: ["stage0"], mappings: [...]}, ...]` 明确每个实例。两个实例即使共用相同参数化定义，也分别核验；不拼接跨实例逻辑锥。RTL 内禁用 sideband 寄存器仍出现在发现总数中，但未映射，不计为模型匹配。

前端显式运行 `proc; opt_muxtree`，仅移除 MUX 控制条件不可能选中的分支，避免把降级过程产生的不可达 X 当成有效更新。不运行该 pass 时，valid/ready 继续 UNKNOWN；有效路径中的 X 也不会判过。TB 是独立事务队列，检查有界场景的数据、顺序、背压保持及复位取消，不使用模型生成期望。

维护入口 `npm run check:external-axis` 自动在临时目录检验固定来源、原版、双级异或抵消、加一故障、局部重测及修复。记录分别说明局部函数与事务仿真结论；不证明初值、禁用 sideband、其他 REG_TYPE、任意参数、完整协议或顺序等价。
