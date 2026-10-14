# 1.7.0：把 RTL 状态观察接到设计规则

本轮落实评审路线中的“有限状态语义提取”。此前规则主要靠 Agent 阅读 RTL 后填写，再通过场景监视器核对；现在可直接从当前展开产物发现寄存器及下一拍逻辑，将观察与设计声明分开保存和比较。

## 已实现

- `verify` → `observe-state` → `assurance` 共用已有输入、工具版本和产物摘要链，不增加新的执行服务或生产依赖。
- 空映射可发现状态；显式映射后比较二态单步函数。等价的不同表达形式可以匹配；函数不同时给出输入、旧状态与两个下一拍值。
- 保存位序、单元类型、宽度/符号参数、选择逻辑、源码位置、模型/映射摘要与比较时审阅依据。观察不反写模型。
- 网页按状态显示匹配、差异、未知和过期，展开可读更新表达式与源码位置。反例可直接用于下一步仿真。
- 模型 AST 增加等宽无符号 `== != < <= > >=`，比较结果 1 位。Spec、模型校验、监视器与单步比较共用该定义；旧模型无字段迁移。

先试 [通用真实 RTL 示例](../examples/state-updates/README.md#observe-state)。Agent 工作步骤见 [状态提取与比较](../.agents/skills/rtl-architect/references/state-observation.md)。

## 为什么选择这个范围

本轮复用已有 Yosys 展开链。官方文档给出了 [JSON 位连接格式](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cmd/index_backends.html#write-json-write-design-to-a-json-file)、[寄存器单元](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cell/word_reg.html)及[字级算术参数](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cell/word_binary.html)。实现使用实际安装版本产生的网表验收，后续可增加其他成熟前端适配器。

比较器使用有预算的规范布尔函数；逐位保留宽度与符号规则，比较完整单步函数，不把 AST 不同直接当作行为不同。它只对显式支持的单元给出结果，未驱动网络不会被悄悄当作自由输入。PMUX 必须证明选择互斥，否则 UNKNOWN。

输入与旧状态作为自由变量：MATCH 覆盖它们的所有二态组合；MISMATCH 的某个旧状态可能实际不可达。二者均不等于完整时序等价。初始化、四态、跨时钟、存储阵列和器件性能仍需各自验证。模型尚无 signed/fourState 类型体系，不能宣称完成任意 SystemVerilog 语义导入。

## 继续推进的顺序

下一步应在这条链上补充更多真实设计的支持/未知样本、跨层级映射与明确的类型转换，再以固定硬件模式评估布局约束。复杂图阅读质量、任意微架构理解和完整可达性尚未解决；不能把本轮函数匹配当成这些问题已经完成。

验证记录见 [VALIDATION](../VALIDATION.md) 与 [1.7 本轮证据](evidence/1.7.0/README.md)。本轮不迁移真实用户项目，也不自动提交批准。
