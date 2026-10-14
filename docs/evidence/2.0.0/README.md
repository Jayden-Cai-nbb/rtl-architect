# 2.0.0 本轮执行证据

2026-10-14，Node 24.18.1 / npm 11.6.2，固定本机 Yosys / Verilator。发布对象为通用工具与示例。真实项目不参与故障注入或自动批准。

| 记录 | 实际结果 |
|---|---|
| check.log | 完整 20 个维护入口通过；状态观察 16 组、外部 RTL 8 组 |
| external-final.log | 最终双级合同明确最小两拍后，外部样例 8 组再次通过 |
| reading-final.log / feedback-final.log | 最终走线代码另检阅读 11 组、真实反馈对应 8 组 |
| build.log / public-build.log | 两副本构建通过，保留现有 chunk 大小提示 |
| build-status.json / public-build-status.json | 两副本各自对应当前 2.0.0 源码；公开包元数据不同，指纹不同正常 |
| release.log | 从公开源码复制，重新 npm ci/build/install/open；没有复用旧依赖、本机 runtime 或 dist |
| rtl.log / workflow.log | 原始 RTL、自检超时负例、完整用户工作流通过 |
| comparison.json / diagram-quality.json | 同一五状态样例：46→28 交叉，6090.95→1323.2 共线长度，收起线名仍为 5；连接完整 |
| browser.json / reading-*.png / state-evidence-*.png | 1440×960、1100×820；主线初始可见，端口行、详情及逐状态证据正常，无页面异常 |
| skill-validation.log / protection.json / cleanup.json | skill 格式有效，真实文件未变，通用源码同步、临时资源清理 |

[离线阅读页面](reading/index.html) 使用正确的通用 signed_scaler 模型。状态面板截图来自临时外部 RTL 故障样例：两个级各加一，再只重测 valid/ready，数据差异必须继续显示且排序优先。截图不是正确实现通过证明，也不能作为其他项目的新鲜证据导入。

外部源固定提交见 [upstream.json](../../../examples/external-axis/upstream.json) 与 [使用方法](../../../examples/external-axis/README.md)。原版和修复后的独立队列接收 255、输出 254、复位取消 1；检查 187 个输出停顿采样沿。双级异或抵消案例说明事务通过与局部一致性不可互相替代。未测试禁用 sideband、其他参数和 REG_TYPE、初始化、完整 AXI 协议或顺序等价。

早期试验包括几何退化方案、测试脚本错误及源码修改后构建过期拒绝；修复后重新构建、执行相应检查，以上文件只保存成功验收。布局微调后又重跑阅读与反馈检查，并在最终构建重跑两尺寸浏览器；末轮状态观察/外部回归包含最终摘要与排序逻辑。

人类阅读速度和错误发现率未测量；几何、BDD、仿真和浏览器检查不能代替它们。这些文件记录发布前的本地检查；远端结果见 [GitHub Actions](https://github.com/Jayden-Cai-nbb/rtl-architect/actions)。
