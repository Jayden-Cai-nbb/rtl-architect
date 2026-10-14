# 有符号缩放：位宽、移位与标志

模型版本：`2cd22e38e8248095a270a45eb113ea2d37b9edd87872ccb66ecbd362c886f4bf` · 草稿

使能时采样 signed 8 位数据，同时保存 12 位算术缩放、低位打包、逻辑右移与标志。

> 本文与框图由同一 IR 生成；布局不参与合同。结构检查不构成 RTL 一致性、CDC/RDC 或形式证明。

## 设计需求

ID | 需求 | 关联模块 | 验收条件
--- | --- | --- | ---

## 设计决策

## 这份模型覆盖到哪里

实例路径：模型表示 1，源码记录 1。
连线：当前模型已记录 44 / 45 个端口位的连接，仍有 0 个必连端口待补；源码端口位总数未知。
局部驱动 5 项；显式参数绑定 0 项；行为证据 0 项。数量只描述已记录内容，不表示已经覆盖全部 RTL。

## 有符号缩放寄存级 · top

局部信号（非 RTL 子模块）：
ID | 位宽 | 驱动 | 说明
--- | --- | --- | ---
scaled_q | 12 | scaled <= extended_sample >>> shift; | 符号扩展到 12 位后算术右移；同步复位优先，使能无效保持。
packed_value_q | 8 | packed_value <= 8'(extended_sample >>> shift); | 明确截取算术结果低 8 位；同步复位优先，使能无效保持。
logical_value_q | 8 | logical_value <= $unsigned(sample) >> shift; | 按无符号位向量逻辑右移；同步复位优先，使能无效保持。
negative_q | 1 | negative <= sample < 8'sd0; | 按有符号数判断负值；同步复位优先，使能无效保持。
parity_q | 1 | parity <= ^sample; | 输入的逐位异或归约；同步复位优先，使能无效保持。
状态 符号扩展到 12 位后算术右移 · 条件装载寄存器
按表从上到下匹配，第一个成立的条件生效；条件和右值均取有效时钟沿前值。规则为模型声明，来源与本次仿真需独立核对。
优先级 | 条件（沿前） | 写入值（沿后）
--- | --- | ---
1 | top.rst_n = 0 | 12bit(0)
2 | top.enable | (符号扩展→12 位有符号(top.sample) >>> top.shift)
3 | 以上条件均不成立 | 保持原值
状态 明确截取算术结果低 8 位 · 条件装载寄存器
按表从上到下匹配，第一个成立的条件生效；条件和右值均取有效时钟沿前值。规则为模型声明，来源与本次仿真需独立核对。
优先级 | 条件（沿前） | 写入值（沿后）
--- | --- | ---
1 | top.rst_n = 0 | 8bit(0)
2 | top.enable | 截取低位→8 位无符号((符号扩展→12 位有符号(top.sample) >>> top.shift))
3 | 以上条件均不成立 | 保持原值
状态 按无符号位向量逻辑右移 · 条件装载寄存器
按表从上到下匹配，第一个成立的条件生效；条件和右值均取有效时钟沿前值。规则为模型声明，来源与本次仿真需独立核对。
优先级 | 条件（沿前） | 写入值（沿后）
--- | --- | ---
1 | top.rst_n = 0 | 8bit(0)
2 | top.enable | (top.sample >> top.shift)
3 | 以上条件均不成立 | 保持原值
状态 按有符号数判断负值 · 条件装载寄存器
按表从上到下匹配，第一个成立的条件生效；条件和右值均取有效时钟沿前值。规则为模型声明，来源与本次仿真需独立核对。
优先级 | 条件（沿前） | 写入值（沿后）
--- | --- | ---
1 | top.rst_n = 0 | 1bit(0)
2 | top.enable | (重解释→8 位有符号(top.sample) < 重解释→8 位有符号(8bit(0)))
3 | 以上条件均不成立 | 保持原值
状态 输入的逐位异或归约 · 条件装载寄存器
按表从上到下匹配，第一个成立的条件生效；条件和右值均取有效时钟沿前值。规则为模型声明，来源与本次仿真需独立核对。
优先级 | 条件（沿前） | 写入值（沿后）
--- | --- | ---
1 | top.rst_n = 0 | 1bit(0)
2 | top.enable | 归约异或(top.sample)
3 | 以上条件均不成立 | 保持原值
类型：subsystem · 父层级：顶层 · RTL：signed_scaler
时序 · 时钟：clk（上升沿） · 复位：rst_n（同步，低有效）

### 职责
使能时采样 signed 8 位数据，同时保存 12 位算术缩放、低位打包、逻辑右移与标志。

### 行为合同
最小延迟：1 周期。有效沿前输入在该沿后更新；按相邻采样沿计 1 周期。
背压：无 ready/valid；enable=0 时全部寄存器保持。
复位：posedge clk 同步低有效 rst_n，全部状态清零。

不变量：
- 移位量为 0..15，超宽算术右移保留符号，逻辑右移补零。
- signed 是表达式解释，端口/状态存储仍为位向量。

验证计划：
- 穷举 256 个输入编码和 16 个移位量，另测复位与保持。
- 比较显式状态映射，保留二态单步与实际场景证据的边界。

可执行验证义务（声明不等于通过）：
- scaled_update · 符号扩展到 12 位后算术右移（state_transition）；需求：未关联
- packed_value_update · 明确截取算术结果低 8 位（state_transition）；需求：未关联
- logical_value_update · 按无符号位向量逻辑右移（state_transition）；需求：未关联
- negative_update · 按有符号数判断负值（state_transition）；需求：未关联
- parity_update · 输入的逐位异或归约（state_transition）；需求：未关联

未决问题：
无

### 参数
参数 | 值
--- | ---

### 逻辑接口
接口 | 角色 | 协议 | 解析宽度 | 必连
--- | --- | --- | --- | ---
sample | consumer | signal | 8 | 否
shift | consumer | signal | 4 | 否
enable | consumer | signal | 1 | 否
clk | consumer | signal | 1 | 否
rst_n | consumer | signal | 1 | 否
scaled | producer | signal | 12 | 否
packed_value | producer | signal | 8 | 否
logical_value | producer | signal | 8 | 否
negative | producer | signal | 1 | 否
parity | producer | signal | 1 | 否

### 邻接及内部连接
ID | scope | 来源 | 目标
--- | --- | --- | ---
scaled_out | top | top.local:scaled_q | top.scaled
packed_value_out | top | top.local:packed_value_q | top.packed_value
logical_value_out | top | top.local:logical_value_q | top.logical_value
negative_out | top | top.local:negative_q | top.negative
parity_out | top | top.local:parity_q | top.parity

## 设计未决问题

## 校验问题
- 现状还原仅供审阅和保存草稿；转为实现设计须另提方案并审阅：1 项
  - top：1 项（AS_BUILT_READ_ONLY）
- 架构为不完整投影，不能批准或导出实现合同：1 项
  - top：1 项（PARTIAL_MODEL）
- limits: 只核对有限二态状态更新；未证明四态、初始状态和任意时序需求。：1 项
  - top：1 项（SOURCE_UNRESOLVED）

## 来源与覆盖

根据现有 RTL 还原 · 尚未完整
范围：固定 8 位输入 / 12 位缩放 / 4 位移位量的五个完整寄存器
配置：Standalone signed_scaler; no parameters or includes
输入摘要：`0b7424483adcb3cf6f860754c70cc6fdbf2d3cd170a115fc717a1bc719761cfe`
展开实例：1 · 已表示实例：1 · 展开模型实例：1 · 定义节点：1 · 连接：5

> 实例数量吻合不代表连线和行为已经核对完整。下列缺口会阻止实现交接。

### 未表达结构
ID | 类型 | 关联模块 | 限制 | 证据
--- | --- | --- | --- | ---

### 事实、推断与冲突
ID | 分类 | 发现 | 证据
--- | --- | --- | ---
limits | unknown | 只核对有限二态状态更新；未证明四态、初始状态和任意时序需求。 | 

### 实际验证记录
目标 / 批次 | 阶段 | 结果 | 执行时间 | 输入摘要 / 工具 | 命令 | 说明 | 证据
--- | --- | --- | --- | --- | --- | --- | ---

### 源码与结果证据
ID | 来源 | 位置 / 符号 | SHA-256
--- | --- | --- | ---
rtl | code | rtl/signed_scaler.sv | 0b7424483adcb3cf6f860754c70cc6fdbf2d3cd170a115fc717a1bc719761cfe
