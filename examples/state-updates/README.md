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
