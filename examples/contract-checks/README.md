# 可核验 FIFO

独立通用样例，复用 tiny-stream 的 rv_fifo RTL，不包含真实用户代码。需要已安装的 Node 环境、Verilator、C++ 工具链和 Yosys。以下在**复制到临时目录的样例**中执行；真实项目模型仍经提案保存。

```bash
rtlarch context-index --workspace . --offline --json
rtlarch context --module top --purpose implementation --workspace . --offline --json
rtlarch checks bindings.json ./checks --workspace . --json
rtlarch verify verify.json --workspace . --json
rtlarch verify elaborate.json --workspace . --json
# 把上一步实际返回的 id 填入 mapping-template.json 的 runId，另存 mapping.json。
rtlarch conform mapping.json --workspace . --json
rtlarch assurance --module top --workspace . --json
rtlarch open --workspace . --json
```

页面进入顶层模块详情 → 行为约定 → 核验状态，点击刷新读取本次证据。checks 输出必须是新目录；再次生成用 checks-v2，并修改 verify.json 的路径。

三项承诺：输出背压时保持，复位后首个采样输出为空，FIFO 原样按序输出且测试结束排空。TB 在下降沿驱动，监视器在上升沿、NBA 更新前采样，至少触发一次每项场景。仿真通过不意味着所有输入、时序或器件实现都已证明。

完整自动验收在工具根目录 `source ./env.sh && npm run check:assurance`：正常运行；数据损坏；停顿时错误推进；复位输出错误；测试未排空；无事务；DEPTH 从 4 改 8 后旧证据失效；重新展开发现参数不符；更新 RTL 后匹配；缺闭包或映射时 UNKNOWN。所有改动发生在临时工作区。
