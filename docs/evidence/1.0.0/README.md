# 1.0.0 验证材料

> 历史验证摘要。发布整理已移除重复截图、临时状态快照和生成包；下文描述当时执行情况，当前验收见 [2.0 记录](../2.0.0/README.md)。可运行源码和复现命令保留在 examples/ 与 scripts/。

仅包含公开通用样例，不含真实 Turbo 模型、合同、截图或验证记录。

- workflow.json：从 examples/rtl-intake 原始 RTL 开始，展开、导入、临时用户保存、讨论/答复、候选、检查点、服务重启、实际仿真、来源失效的计时与结果。含生产源码构建摘要。
- browser.json：Chromium 140 的实际交互项目、构建摘要及窗口尺寸。
- discussion.png / budget.png / review.png：packet-pipeline 架构示例的讨论、预算和按影响复核。该示例无对应行为 RTL。
- runs.png：rtl-intake 的实际 Verilator 自检记录。输入后续变化时浏览器失效提示也经过检查。
- narrow.png：1100×820 窗口的工作台。

复现：npm run build、npm run check、npm run rtl:test、npm run check:workflow。浏览器验证使用临时 Playwright/Chromium 与中文字体；未新增项目依赖或测试框架。自动检查中的提交和确认仅用于临时工作区。

截图是验收材料；交互须运行 rtlarch open，不能把截图或历史 HTML 当成当前服务。
