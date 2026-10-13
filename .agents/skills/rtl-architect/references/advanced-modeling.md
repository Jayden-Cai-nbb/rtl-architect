# 数组、局部信号与参数（IR 3）

用于已经核对源码的真实结构；不是自动 Verilog 导入器。生成前查询 `rtlarch schema model --json`。新增字段保持可选，旧 1/2/3 模型加载不会迁移文件或改变 hash。

## 一维叶实例数组

同构叶模块共用模块定义与合同，在模块上增加：

```json
{
  "instances": {
    "indexVariable": "z", "from": 0, "to": 255,
    "sourcePath": "top.g[{z}].pe",
    "overrides": {"123":{"OFFSET":492}}
  },
  "parameters": {"DATA_W":8,"OFFSET":0},
  "parameterBindings": {
    "DATA_W":{"scope":"parent","expression":"DATA_W"},
    "OFFSET":{"scope":"self","expression":"z * 4"}
  }
}
```

上例是模块片段。parent 作用域仅引用父模块参数；self 可引用当前参数和数组索引。索引变量不能与参数重名。from/to 为含端点的非负整数，最多 4096 个元素；当前不支持 subsystem 数组、多维/嵌套数组或不同元素拥有不同接口/合同。遇到异构元素拆分为独立定义或保留 partial；不能只给 z=0 节点加 ×256 标签而宣称建模完成。

连接端点加 `index:123` 或 `index:"all"`；数组端点必须明确索引。all→all 按双方各自索引升序配对且长度一致，普通 source→all 为广播。all→普通 target 会展开检查多驱动，不代表自动归约。每元素位宽、参数、必连位域和驱动冲突均参与验证。固定 slice 保留整数边界；规律性切片优先用下述 sliceMapping，不逐元素复制。

框图保留一个 ×N 节点，点开后可输入任意索引，查看真实路径、有效参数与接口；主图默认显示数组汇总；“检查此索引连线”按同一连接规则解析该元素的具体切片和广播，并高亮路径。退出检查恢复汇总，不平铺全部元素。`context --module pe --index 123 --workspace <项目> --json` 返回该元素解析参数/连接。改变共享定义影响全部元素，`set_instance_parameter` 只覆盖一个元素。两者都要 preview/commit；按模块和依赖范围重新复核，整体批准对应完整当前版本。

coverage.representedInstances 等于普通模块个数（含顶层）加数组各元素数量；节点数与展开数分开。展开数来自真实工程核对，不能把模型求和当源码 elaboration。数组建模不自动清空 partial、origin 或 unsupportedStructures。

## 参数与位宽

parameterBindings 的 key 必须已有 parameters 默认值。优先级：单元素 overrides > 显式 binding > 默认值。修改绑定使用 `set_parameter_binding`；binding=null 移除。直接 set_parameter 不覆盖已有 binding。width 支持整数、`{"param":"DATA_W"}`、`{"expr":"DATA_W * LANES"}`。

支持整数常量、参数名、括号、一元 `+ - ~`、二元 `+ - * / % << >> & ^ |` 和 `$clog2(...)`；常量可为十进制、0x、带位宽的 h/b/o/d 字面量。内部 BigInt 求值有 128 位/深度限制，最后须为 JSON 安全整数，位宽须 1..65536。拒绝除零、循环依赖、未知变量、溢出、非法移位；不使用 eval，也不执行 HDL/JS。

这是受限数学整数语言，不模拟 Verilog signed、四态值、上下文位宽和隐式截断。尤其 `/` 为整数除法，`~` 使用数学有符号整数补码语义；不能未经核对照抄含隐式转换的 RTL 表达式。未支持项保留求值后的数值与源码表达式证据，并记录传播限制。UI/context 报告声明、当前取值来源、有效值、直接使用者与传递路径；未声明的 RTL 依赖不会被自动发现。fifo/add_const 示例模板仍限定原参数，不接入数组或绑定。

### 有类型的参数直接引用

文件路径等字符串不参与算术，用 `{scope:"parent",reference:"ROM_FILE",type:"string"}` 直接传递；也支持 number/boolean 的同类型引用。目标 parameters 默认值、来源有效值和 type 必须一致。scope=self/parent 的规则不变；禁止隐式转型、字符串插值及文件读取。

报告保留“默认值 / 绑定 / 单元素覆盖”的区别。ROM_FILE→INIT_FILE→ROM_FILE 的跨层传递可以追踪；没有显式绑定就报告“当前模型没有下游绑定”，不要说“RTL中必定未使用”。相同名称不产生依赖关系。

## 位域与真实局部驱动

signal 端点可以带 `"slice":{"msb":7,"lsb":4}`。端点必须属于当前 scope 或直属子模块，位域不得越界。目标同一端口不同位域可以分别驱动，但不能重叠；required 端口留下任何未连接位会提示。rv 不支持位切片。

作用域内部 assign/控制寄存器用模型顶层 localSignals，不虚构模块实例：

```json
{
  "id":"ram_control", "scope":"top", "name":"RAM control", "width":8,
  "description":"由真实 assign 的输入低四位和常量组成",
  "evidenceIds":["assign_control"],
  "driver":{"kind":"comb","value":{"kind":"concat","parts":[
    {"kind":"endpoint","endpoint":{"moduleId":"top","interfaceId":"control_in","slice":{"msb":3,"lsb":0}}},
    {"kind":"constant","width":4,"value":"0xa"}
  ]}}
}
```

parts 从高位到低位。局部输出连接的来源为 `{"moduleId":"top","interfaceId":"ram_control","local":true}`，不是伪造的父层输出接口。表达式 endpoint 只能读取本 scope 的 signal source；数组读取需具体索引。constant 有显式 width，value 为非负十进制/0x/0b 字符串，溢出拒绝，不能用 X/Z 随意填常量。

局部表达式也支持 `{kind:"operator",operator:"&",operands:[...]}`。运算符为 `& | ^ ~ && || ! + - mux`；mux 为 condition/true/false，condition 宽度1、两个分支同宽；位运算/加减操作数同宽，结果同宽；逻辑运算结果宽度1。工具核对依赖和位宽，不仿真表达式数值、不证明 HDL 等价。

真实寄存驱动用 `{kind:"register",inputs:[端点...],sourceText:"真实过程及源码说明"}`。作用域需有时钟，inputs 要完整列出读取依赖。sourceText 是保留的源码语义，工具不综合/执行，不承诺可完整表达任意 always；仍有无法表达行为时保留 partial 和限制。局部组合依赖环会拒绝，寄存器反馈可表示；这不构成全 RTL 组合环/CDC/RDC 证明。

需要准确区分写入值、更新条件及优先级时，可按 [状态更新闭环](state-updates.md) 增加可选 `driver.update`；整向量同步规则经同一模型生成更新表、追踪和仿真监视器。旧输入集合不自动升级。

寄存更新条件、数据与控制对齐及存储响应按 [时序方法](timing.md) 核对。参数或数组元素差异可能改变周期行为，不能只传播位宽后沿用未经核对的延迟；当前共享合同无法表示的元素差异应明确列出。

`update_local_signals` 替换完整局部信号数组，与 connect/disconnect 可同批预览。界面点局部节点可读驱动与源码证据，连线编辑器可选局部 source、索引和切片；复杂 AST 的修改交给 AI 提案，尚无图形表达式编辑器。

### 数组切片映射

端点可用 sliceMapping 替代固定 slice：

```json
{
  "id":"cnu_data", "scope":"pro",
  "from":{"moduleId":"pro","interfaceId":"packed_data",
    "sliceMapping":{"arrayModuleId":"cnu","stride":30,"offset":0,"width":30}},
  "to":{"moduleId":"cnu","interfaceId":"data","index":"all"}
}
```

数组索引 z 对应 lsb=z×stride+offset，msb=lsb+width−1；这是受限整数仿射映射，不能填写任意 HDL/JS。arrayModuleId 必须是此连接的数组端点；范围来自该数组，使用实际索引而非序号。all→all 仍按各自索引顺序配对。一个端点不能同时有 slice 和 sliceMapping。

检查全部元素的范围、方向、位宽、驱动重叠及缺口；规则本身的 ID 始终保留，查看元素时派生具体切片。0/123/255 应分别核对，代表索引通过不代替全部元素校验。实例数组多维等边界未扩展。

请求按 UTF-8 字节计量，上限8 MiB，CLI/浏览器发送前检查，服务器也强制检查；REQUEST_TOO_LARGE 返回 actualBytes/limitBytes。超限先查重复展开、冗长字段和误带附件，不拆成会暂时破坏连接的多个提交。45条×256索引规则应保留为45条规则，不必写成11520份 JSON。小请求通过不代表模型完整。

## 审阅、证据和候选比较

端口用 group 关联模块上的 interfaceGroups：`{id,label,category,description}`。category 为 data/request/response/writeback/configuration/clock_reset/control/other。description 说明按什么设计含义分组；原始端口仍是权威，不合造新协议。旧模型只有 group 时仍可显示，但不会凭名字自动隐藏。

主图只布局真实直属模块；层级外框上的接口组不是子模块。点击模块突出相邻关系，点击连接束逐条检查真实 ID；选中信号临时标出端口与内部驱动，其余关系淡化。configuration/clock_reset 类关系可默认折叠并保留计数和入口，选中后展开；control 不自动隐藏。反馈保留箭头和独立回线路径。

寄存状态及驱动模块的局部组合逻辑默认可见，其余内部信号按需展开。“内部状态与运算”显示全部已建模表达式；“原始连接”逐条核对端点。完整名称及路径在提示/详情中保留。每个层级记住本次会话的位置、视口、选择和展开状态；退出检查不重新布局。这些显示状态不进入模型 hash，也不写回旧 layout。跨层只能通过真实边界继续追踪，没有内部记录时显示缺口。

evidence 和 unsupportedStructures 可附 targets：

- `{kind:"module",moduleId:"pe"}` / `{kind:"contract",moduleId:"pe"}`
- `{kind:"parameter",moduleId:"pe",itemId:"DATA_W"}`
- `{kind:"interface",moduleId:"ram",itemId:"we"}`
- `{kind:"connection",itemId:"ram_write"}`
- `{kind:"local",moduleId:"top",itemId:"ram_control"}`

目标必须真实存在。targets 仅表达关联，不参与推断根因。需要归因时在 unsupportedStructures 项增加 causes：`[{issueCodes:["REQUIRED_UNCONNECTED"],moduleId:"cnu",interfaceId:"data",scope:"pro",indices:{from:0,to:255},bits:{lsb:0,msb:29}}]`。issueCodes 与模块必须明确；其他范围按需要限定。诊断的全部缺失位域须落在声明范围内才归因。无匹配时保留原类别，源码冲突/复位未知不能只凭模块关联归到导入缺口。问题按模块、端口、索引区间汇总，展开后分页；原始总数保留。点击证据只读项目内声明文件，显示行号并比较实际 SHA-256；拒绝目录外或逃逸符号链接。

候选 A/B 的完整 Model 文件用 `rtlarch compare A.json B.json --json` 或变更面板的“比较两个候选模型”。这是只读差异，不启动服务、不覆盖提案，不把旧候选 hash 当作当前提交基线。正式 draft/preview/commit 始终绑定工作区当前 hash。


unsupportedStructures 可选 category：not_imported / unsupported / source_unknown / missing_asset，分别对应未导入、工具表达限制、源码未知和验证资产缺失。不分类的旧条目显示“尚未分类”，不按措辞猜分类。

coverage 可选 assessments，键为 portBits/localDrivers/parameterBindings/behavior；每项 `{status:"complete"或"partial"或"unknown",expected:整数或null,detail,evidenceIds:[]}`。不要为好看的百分比填分母。工具派生的是当前模型位域使用数（父子边界分别计数），不是全 RTL 网表完整率；删切片会影响对应统计。声明 complete 需要依据，缺口/未知仍阻断确认；实例数量吻合不会解除其他维度的限制。

页面版本信息同时显示服务版本、登记候选的创建版本、ID/hash、输入摘要及提交状态。旧登记文件没有 createdWith 时显示未知，不倒填0.6；新服务提供旧候选页面并不表示模型已经迁移。
