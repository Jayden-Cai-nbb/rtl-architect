# 1.4.0 通用硬件视图实测

2026-10-13，在本机 Linux/WSL 运行；所有页面与操作位于临时通用工作区，不包含真实用户 CPU/Turbo 材料。

- [完整维护检查](check.log)：14 个入口；新视图检查 18 组，既有证据链检查 25 组。
- [维护副本构建](build.log) / [公开副本构建](public-build.log)：TypeScript/Vite，保留大 chunk 提示。
- [真实 RTL 仿真](rtl.log)：原 tiny-stream fixture 与 TIMEOUT 负例；不是新模型的行为等价检查。
- [skill 格式检查](skill.log)。
- [实际浏览器结果](browser.json)：Chromium 140，三模式状态/表达式范围、模式位置与视口恢复、追踪中切换模式、连续 20 次选择几何稳定、无新增 Worker、SVG 实际下载、RV 反向成员、窄窗口无页面溢出。

## 页面与导出

| 阅读任务 | 页面 | 实际下载 SVG |
|---|---|---|
| 真实加常数级的寄存边界 | [架构通路](architecture.png) · [放大阅读](architecture-reading.png) | [架构 SVG](architecture.svg) |
| 输入可接受条件与加法表达式 | [内部状态与运算](microarchitecture.png) | [内部 SVG](microarchitecture.svg) |
| 原端点与每条模型连接 | [原始连接](signals.png) | [原始 SVG](signals.svg) |
| 独立状态检查 | [窄窗口](audit-small.png) | — |
| 原生 RV 的反向 ready | [通道详情](rv-members.png) | — |

例子来自 [hardware-views](../../../examples/hardware-views/README.md) 与已有 tiny-stream/path。前者有实际 RTL 依据，但保留 partial，寄存器输入集合不表达完整的数据/使能角色；后者展示原生 rv 模型协议声明，不冒充已经证明的引脚映射。

截图可以看到交叉、局部收起的线名和全图比例下的小字；应通过“阅读大小”、平移和点击继续核对。几何通过不是人工可读性通过，没有宣称自动消除所有拥挤或识别任意硬件结构。全套检查后修正了追踪检查点覆盖模式切换的交互边界，最终浏览器回归另行执行。
