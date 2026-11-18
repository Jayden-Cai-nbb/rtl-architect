# 逻辑锥交叉与长线优化

本轮在前一轮[引用共享与阅读操作](../state-cone-refinement/README.md)基础上，只调整派生几何，不新增或删除投影节点和关系，不修改 AST、规则、IR、modelHash、layout 或批准。

## 改动

`stateConeDiagram` 原来把所有输入、Q 和常量集中到最左列，按构造顺序堆叠，短控制支路因此横跨整图。现在保留原布局作基线，再有限尝试两种布局：按真实依赖让短支路靠近最早使用者；根据邻接端口位置做四轮双向排序与不重叠压紧；其中一个候选还调整输入端口的显示顺序。每个端口的 ID、消费者、角色、位宽和规则编号保持不变，位置不代表运算次序、分支优先级或周期。

所有候选都复用现有 `routeEdges`。从 `quality.ts` 抽出共用 `geometryQuality`，原架构视图的指标口径不变。候选必须无节点重叠、无穿块、无未路由关系，并且严格交叉数、最长单条线、总线长和共线重叠长度全部不高于当前方案，至少一项改善，才替换基线。

若基线几何本身失败，则优先接受几何完整的候选；未路由边造成的低线长没有比较意义。本轮五个基线均几何完整，表中改进全部满足四项指标不变差的门槛。

最多 64 个节点 / 96 条关系时评估三个候选（含基线）；超过预算只使用原布局。选择与缩放不进入优化输入，仍在可终止 Worker 内绘图。不增加电气分叉点，不把依赖当物理网络，不通过删除或隐藏连接改善数字。

## 同源改前改后测量

单位为画布像素；“最长”仅指**单条依赖线**的曼哈顿长度，不是逻辑关键路径或 STA。交叉采用已有质量检查中的严格正交线段相交口径；共线长度另报，因此 0 交叉不自动等于所有读图歧义消失。

| 模型 / 范围 | 节点 / 关系（不变） | 交叉前→后 | 最长单线前→后 | 总线长前→后 | 共线长度前→后 |
| --- | --- | ---: | ---: | ---: | ---: |
| typed / scaled_q | 13 / 12 | 6→0 | 1970→257 | 7261→1954 | 136→0 |
| typed / packed_value_q | 14 / 13 | 4→0 | 2340→257 | 8879→2039 | 158→0 |
| state-updates / out_data | 20 / 20 | 16→1 | 3408→1360 | 16572→4690 | 292→32 |
| state-updates / 展开 out_valid | 26 / 29 | 42→4 | 3684→1288 | 28982→8480 | 1982→218 |
| external-axis / stage0_data_q | 6 / 5 | 3→0 | 738→242 | 1770→784 | 22→0 |

[改前记录](before.json)、[改后记录](after.json)包含模型 hash、尺寸、耗时和候选指标；同名详细 JSON 保存来源明确的投影和绘图结果，供复现证据查看，不作为独立可编辑硬件模型。

本轮测量中五个图均无节点重叠、穿块和未路由关系。额外候选增加绘图耗时，展开图单次约 28→105 ms；这不是稳定性能基准。图宽没有缩短；external-axis 高度略增（504→542），以换取交叉与线长降低。没有声称所有尺寸或性能都改善。

## 视觉对照及边界

| 页面 | 改前 | 改后 |
| --- | --- | --- |
| typed 截断状态 | [已测基线](typed-expressions-packed_value_q-0-before.png) | [当前 Worker](typed-expressions-packed_value_q-0-after.png) |
| state-updates 展开状态 | [已测基线](state-updates-out_data-1-before.png) | [当前 Worker](state-updates-out_data-1-after.png) |
| external-axis 状态 | [已测基线](external-axis-stage0_data_q-0-before.png) | [当前 Worker](external-axis-stage0_data_q-0-after.png) |

改前截图使用本轮修改前保存的几何，通过当前同一个 StateCone 组件回放；没有伪称旧版本服务在本轮重新运行。改后是当前 Worker 实际生成，浏览器逐条对照路径与测量产物。完整 SVG 截图直接取同一组件的 SVG，不另写绘图器。1440×1000 的实际页面另见 [typed](typed-expressions-packed_value_q-0-page.png)、[state-updates](state-updates-out_data-1-page.png)、[external-axis](external-axis-stage0_data_q-0-page.png)。

实际审阅：typed 的 sign_extend → 算术右移 → truncate 及各节点 signedness 可辨；state-updates 的保持、复位与两个消费者可追踪，优先级仍按明确编号；external-axis 的 ready Q、data Q 与 D 仍独立。端口位置可能重新排列，data:0 / data:1 / select 的文字角色没有变化。

残余问题：共享 Q/复位输入仍可能跨多列；展开图保留 4 处交叉及 218 px 共线重叠。大图不尝试这些候选，且最优布局没有保证。零交叉小图仍需要缩放阅读文字，不等于硬件正确、覆盖完整或用户阅读速度通过。partial、UNKNOWN、MISMATCH 和来源标识保持。

预算限制了额外候选次数，不保证任意大图实时完成；Worker 仍可随范围切换或关闭终止。

## 本轮验证

[构建](build.log)和[逻辑锥专项](cone.log)已通过。专项增加精确节点/关系/端口/角色保留、路径起终点、正交性、全部候选不劣化门槛、确定性、五组固定 DAG、预算和环负例；沿用数值穷举、规则优先级和真实 Yosys 观察检查。

[最终浏览器记录](browser.json)通过：三类样例全部路径与测量一致，选择与缩放不重排，页面无异常，受保护模型/布局摘要不变。首次 external-axis 自动双击导航超时，未到该案例图形验收，保留[日志](browser-navigation-failure.log)和[失败记录](browser-failure.json)；改用明确“进入内部”操作后复查通过。没有因此改动产品导航。

本轮先构建，再顺序完成完整 [npm run check](check.log) 和 [npm run rtl:test](rtl.log)，整条命令退出 0。rtl:test 只验证 tiny-stream 初始 fixture，并包括超时负例，不证明任意架构模型一致性。本轮未运行远端 CI、发布检查或独立 check:workflow。所有页面与新验证均使用临时副本，不批准真实项目。

最终[验证状态](validation.json)确认五组改前改后的完整投影内容相同，模型 hash 和受保护文件摘要不变。三个临时服务已[停止](cleanup.log)，本轮临时样例、浏览器及依赖已清理。
