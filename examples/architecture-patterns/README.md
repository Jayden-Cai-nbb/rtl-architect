# 六类 RTL 架构阅读样例

六类样例的 RTL 位于本目录；按下方命令生成当前版本的离线阅读页，可放大端口、点线追溯并查看质量检查。旧生成包不随仓库重复发布。

| RTL | 阅读重点 |
|---|---|
| `pipeline.sv` | 两个真实寄存实例，分区不是额外流水级 |
| `fork_join.sv` | 加一与取反并排，结果在异或处汇合 |
| `arbiter.sv` | 两个使用方、A 优先授权及数据汇合；授权向使用方返回 |
| `shared_ram.sv` | 两个异步读口共用一个 16×8 RAM，单写口沿时钟更新，无复位 |
| `accumulator.sv` | 旧状态回到加法，enable 时沿时钟写回，8 位截断 |
| `fifo.sv` | 单槽的占用/数据状态及反压反馈，消费与替换可同沿发生 |

这些是随工具维护的可综合 RTL，不含用户工程。模型由 `scripts/architecture-patterns.ts` 按源码手工映射，保留 as_built / partial；它不是自动提取器。检查用独立 Yosys 展开核对顶层实例类型及每条已声明物理连接的端点位网；派生表达式有明确映射。内部行为、所有时序与存储冲突没有因此得到证明。

从工具根目录复现，先准备固定 Node/npm 和可用的 `yosys`：

```bash
source ./env.sh
npm run check:layout-constraints
# 输出目录须不存在；保留这次运行的六个离线包及质量记录：
RTLARCH_LAYOUT_EVIDENCE=/tmp/rtlarch-reading-example npm run check:layout-constraints
```

检查覆盖三种视图、声明约束、未排下线名、选择几何稳定，以及错误引用、过期布局和手动破坏约束。样稿中的交叉数与语义缺口继续显示；使用者能否正确回答阅读问题，需实际试用，不由测试代答。
