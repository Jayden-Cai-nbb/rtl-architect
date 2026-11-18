# 有限下一状态逻辑锥

模型图来自 SignalValue AST 和 register.update，按原规则顺序生成选择器：同步复位优先、分支依次匹配、默认保持 Q。编号与规则表一致。每个 AST 节点通过现有 localSignalAnalysis 求位宽和 signedness；组合端点、切片、寄存器 Q/D 为位向量，不继承内部 signedness。复用 dependencyRoles 显示声明依赖角色，MUX 选择与数据端另按 AST 的实际位置标记。

图是带来源标识的只读派生结构，不写入 IR、layout、批准或 workbench。默认停止在上游 Q；点击 Q 后可显式展开该寄存器自身的 D 锥，沿前 Q 不会被替换成下一拍值。最多扩展 8 个上游状态，表达式 128 次、深度 24、单节点 64 操作数；达到预算显示边界。没有新增 HDL parser。

RTL 图只读取现有 observe-state 观察记录的 cells、参数及位连接，并显示记录路径、实例路径和 observedHash。未支持单元、缺失映射、过期证据和 X/Z 保持 UNKNOWN 边界。完整向量无法唯一对应时显示真实位清单；不猜切片来源。叶位可能来自输入或上游状态，产物不足以区分时明确保留边界。

RTL 产物没有统一的表达式结果 signedness 字段，所以运算节点显示 signedness UNKNOWN，同时保留 A_SIGNED / B_SIGNED 等实际参数。模型 AST 图的确定类型与观察图的未知分别显示。RTL Q 返回选择器的数据端标记 hold Q；复位角色不会从名字推断。两种图都不是工艺映射门级图，不证明完整顺序等价、初态或需求。

观察窗口始终保留原记录的结论和原因；MISMATCH 仍可查看有限结构，但不会因打开图而变成通过。

## 验收方法

- `scripts/check-state-cone.ts` 从展示图求值，对 typed-expressions 的 scaled_q、packed_value_q 穷举 256×16 输入，独立检查符号扩展、算术右移、低位截断、同步复位和保持；核对规则表与类型解析。
- state-updates 检查上游 out_valid 默认停止、显式展开，构造两条同时有效且写入不同值的规则检查优先级，并调用现有检查器生成/校验。
- unsupported 负例为脚本中明确构造的 `$mul` 观察输入：现有 observeState 返回 UNKNOWN，图只显示边界；另覆盖缺失映射和过期结果。该负例不是新增 HDL 提取器。
- 两个样例分别在临时副本使用原 elaboration 清单执行本轮 Yosys，再通过现有 evaluateStateObservation 生成观察快照，验证独立来源图。模型和批准不变。

页面入口：点击寄存器 → 查看模型下一状态逻辑锥；核验状态 / 全部状态与行为证据 → 查看 RTL 观察逻辑锥。普通图内选择只显示详情；显式展开才改变投影。

观察图的边界是展示范围限制，不反向修改比较结果。图形布局是有限分层展示，仍可能有交叉，长图需要横向和纵向滚动；没有宣称物理走线、周期或用户阅读效率通过。

走线复用现有 orthogonal 路由，在可终止 Worker 内生成；依赖关系不生成物理分叉点。选择仅更新高亮与详情，几何数据保持不变。端点角色放在目标节点内，长名称提供完整标题和详情。

追加的浏览器检查实际发现过展开竞态：[失败日志](browser-expansion-failure.log)、[页面异常](browser-debug.txt)。新投影先渲染而旧几何尚未清除时，新增节点取不到 position。已将 Worker 结果与投影对象绑定，切换时只使用相符的几何；复查同时覆盖展开和收回。保留这次失败，不将核心投影通过当作页面通过。

## 本轮浏览器审阅

在 typed-expressions 和 state-updates 临时副本中执行新的 verify / observe-state，然后使用临时安装的 Chromium 打开当前构建；没有使用真实项目服务或批准模型。

- [模型页面](model-page.png)、[完整模型锥](model-cone.png)：实际检查了 scaled_q 的 12 位 signed 符号扩展和算术右移、更新选择、低有效复位与保持，标签可辨。横向长图不能在单屏同时显示所有节点。
- [截断状态](packed-cone.png)：实际看到了 8 位输入先 sign_extend 到 12 位 signed，再算术右移，最后 truncate [7:0] 到 8 位 unsigned；保留与复位分别进入优先选择器。
- state-updates 的[默认范围](state-cone.png)与[显式展开](state-expanded-cone.png)：上游 out_valid 的 Q 没有被其 D 替代，两个 D 锥独立可追溯。展开图更长，有交叉与重复的表达式出现位置，需要滚动；不把这些显示节点计为 RTL 实例。
- [RTL 观察窗口](rtl-cone.png)：独立来源、记录路径、实例和 observedHash 可见，运算结果 signedness UNKNOWN 与输入/上游状态边界保留。该截图记录当前滚动窗口，右侧部分需滚动查看。
- [最终浏览器记录](browser.json)：没有页面异常，点击表达式前后节点位置一致，显式展开和收回均通过。图内选择与规则表共存；根工作区及两个样例的模型和布局字节摘要未改变。

几何完整性由 typed-expressions 两个模型锥的逐线段避障断言检查；关键标签由实际截图审阅，二者分别记录。阅读拥挤仍表现为较长路径和滚动，未量化用户阅读速度。unsupported 的本轮验收为脚本语义/来源检查，尚未进行独立页面视觉审阅。

## 本轮执行记录（2026-11-16）

先构建，再顺序执行完整 `npm run check` 和 `npm run rtl:test`，均已取得退出 0 的工具结果。完整回归包含旧 hash、证据新鲜度、失败注入、状态更新、观察、数值类型、external-axis 和阅读任务；其原始日志随临时会话消失，未伪造补写。`rtl:test` 只证明 tiny-stream 初始 fixture，不证明任意架构模型一致性。

完整回归后补充观察窗口的结论文字、MISMATCH 断言，并修复浏览器发现的展开竞态；最终重新构建、运行 `check:state-cone` 和临时浏览器检查，均退出 0，分别见 [构建](build.log)、[专项检查](cone.log)、[浏览器记录](browser.json)。构建保留现有较大 chunk 警告。远端 CI、发布检查和独立 `check:workflow` 本轮未执行。

本轮专项检查的 Yosys 观察快照：[typed-expressions](typed-expressions-observed.json)、[state-updates](state-updates-observed.json)。浏览器使用另一次临时执行的记录：[typed-expressions](typed-expressions-browser-observed.json)、[state-updates](state-updates-browser-observed.json)。这些是临时副本中的新执行，不是样例目录的历史验证，也没有提升模型批准。截图仅描述当次审阅；派生证据文件不成为另一份可编辑硬件模型。
