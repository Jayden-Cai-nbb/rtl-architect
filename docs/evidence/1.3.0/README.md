# 1.3.0 本机验收记录

只包含通用样例、维护检查及方法，不包含真实用户项目资料。

- [完整检查](checks.log)：全部 13 个维护入口通过。
- [最终证据链验收](assurance.log)：后续边界修正后独立复跑，25 组通过。
- [本机构建](build.log)、[公开工作副本构建](public-build.log)、[RTL fixture](rtl-fixture.log)、[skill 校验](skill.log)。
- [上下文测量](context.json)：内容体积与纯函数耗时分别报告，不声称端到端提速。
- [浏览器结果](browser.json)、[状态与候选隔离](states.json)、[中文小窗口截图](assurance-small.png)、[候选提示](candidate.png)。

`check:assurance` 用真实 Yosys 和 Verilator：正常 FIFO、数据损坏、背压期间错误推进、复位后输出异常、测试未排空、无事务、DEPTH 变化、错误端口/类型/实际层级连线、缺映射和输入闭包等。模型保存、故障注入都在临时目录；运行后清理。监视器被生成或成功编译不等于义务通过。

实际支持范围见 [升级说明](../../UPGRADE-1.3.md)。本地文件记录没有签名认证，输入闭包由作者声明，未把模拟仿真当作形式或器件证明。
