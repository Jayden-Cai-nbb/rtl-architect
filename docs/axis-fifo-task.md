# axis_fifo 独立任务草案

目标是用 RAM 地址与帧提交边界解释 beat 从接受到消费的路径，并保留复位取消和策略丢弃的证据。使用 `alexforencich/verilog-axis` 的固定提交 `48ff7a7e2ef782cf778d47910cf85835c64b1bce`。单独锁定 RTL、原测试、Makefile、`tox.ini`、许可证和 seed，先跑原测试，再确定原生回放的阶段性分母。原版 pytest 由 4 种数据宽度、6 种 RAM 管线与输出 FIFO 组合、6 种帧与丢弃策略组成，共 144 组。[RTL](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_fifo.v) · [原版参数矩阵](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/tb/axis_fifo/test_axis_fifo.py#L421-L461)

第一阶段建议选择 16 位与 32 位、`RAM_PIPELINE=1`、`OUTPUT_FIFO_ENABLE=0` 的四个原生回放目标。模式分别为普通无丢弃，以及启用 `FRAME_FIFO`、`DROP_OVERSIZE_FRAME`、`DROP_BAD_FRAME` 的帧模式，保持 `DROP_WHEN_FULL=0`、`MARK_WHEN_FULL=0`。原生场景先保持 `pause_req=0`。原版暂停、额外输出 FIFO 与剩余策略的测试结果保留，各自记录原生能力边界。[配置依赖与地址宽度](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_fifo.v#L55-L156)

| 验收任务 | 必须能观察到什么 |
| --- | --- |
| 多槽与计数 | 显式映射存储深度、地址位数、写指针、提交指针、读指针、RAM 读和输出管线。分开 RAM 占用、已提交占用及管线在途。测空、满、地址回绕、同沿合法读写与最长阻塞。用实际 ready/valid 说明满时能否接受 |
| 帧边界 | 入口握手给 beat 编号，按 `last` 划分帧。逐 beat 保留所有启用字段。在选择的帧模式下核对正常帧提交前隐藏、提交后按序消费，坏帧和超长帧回滚，以及随后好帧仍可达。采集 `status_*`，区分提交、丢弃、消费和复位取消 |
| 故障与证据 | 在临时副本注入地址回绕或提前提交故障，选能检出的独立测试。保留最早差异的帧/beat、地址、指针或管线阶段。上游测试、结构、状态比较、事务回放、图形任务分别报告 |

下一阶段再处理无超长丢弃时的部分帧提交、满时丢弃或标记、暂停握手及额外输出 FIFO。为帧和存储寻址定义独立版本与映射，既有 `axis_register` 的 v1/v2 记录仍属于原模型与场景。该草案供下一轮审阅和冻结，本轮执行范围是 `axis_register`。[写入及提交逻辑](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_fifo.v#L235-L345) · [读取和输出管线](https://github.com/alexforencich/verilog-axis/blob/48ff7a7e2ef782cf778d47910cf85835c64b1bce/rtl/axis_fifo.v#L347-L430)
