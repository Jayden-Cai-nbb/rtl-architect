# 有符号缩放：真实 RTL 与显式类型

`signed_scaler` 在 enable 时采样 8 位 signed 数据：符号扩展至 12 位后算术右移，同时输出低 8 位、逻辑右移值、负数标志和异或校验。同步低有效复位清零；禁用时保持。移位量为 0..15。模型保持 as_built / partial；通过检查不代表满足独立用户需求或完整时序等价。

`architecture/model.json` 是可直接打开的阅读样例。选择状态，更新表会显示转换顺序，输入追踪保留 sample、shift、enable、rst_n 的不同角色。用 `sample=8'h80, shift=1` 阅读：scaled=-64、packed_value=8'hc0、logical_value=8'h40、negative=1、parity=1。

随附独立 layout 用原生 parallel 约束排列五个同沿状态，保存了阅读视野。可平移查看下面的状态，左下角“全图”恢复总览。没有模块重叠或穿框，但扇出仍有交叉和收起的线名；按状态追踪阅读，不能把几何通过当作可读性验收。

使用工具根目录的 `bin/rtlarch`。建议先复制整个样例到临时工作目录，将下面 `<样例副本>` 替换为绝对路径：

```bash
cd <样例副本>
rtlarch open --workspace . --json
rtlarch verify elaboration.json --workspace . --json
# 把 state-mapping.json 中 runId 替换为本次 verify 返回的 id：
rtlarch observe-state state-mapping.json --workspace . --json
rtlarch checks bindings.json checks --workspace . --json
rtlarch verify verification.json --workspace . --json
rtlarch assurance --workspace . --json
```

`checks` 输出目录须未存在。第二次生成用新目录并相应修改 verification 输入。TB 显式实例化生成的监视器，穷举 256×16 个输入组合，另外覆盖复位、保持；有独立整数参照。需要 Yosys、Verilator 和 C++ 构建工具。

工具维护运行 `npm run check:expression-types`：除本样例外，还核对 25 个独立 RTL 表达式、嵌套溢出与转换次序，注入把算术右移改成逻辑右移、把负数比较改成无符号比较的故障。每次在新临时目录运行并清理，不修改样例权威文件。
