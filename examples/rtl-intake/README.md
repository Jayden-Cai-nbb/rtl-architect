# 从原始 RTL 开始的通用流程

这里刻意不提供架构 JSON。两个寄存级分别加 1、加 2，同步低有效复位，valid 与数据同行；8 位结果按模 256 运算。TB 检查有效事务、气泡、回绕及中途复位。没有 ready 背压，不能直接套用到停顿流水线。

将此目录复制到一个新的实验目录，进入目录。准备固定 Node/npm、Yosys、Verilator、Python 3 和 C++ 编译环境，安装并构建 rtl-architect 后：

```bash
rtlarch open --init --workspace . --json
yosys -Q -T -p 'read_verilog -sv rtl/stage.sv rtl/stream_top.sv; hierarchy -top stream_top; proc; write_json netlist.json'
rtlarch import-yosys inputs.json candidate --workspace . --json
rtlarch draft candidate/model.json --workspace . --open --json
```

打开 draft 返回的 reviewUrl，查看候选。导入器保留真实层级和明确直接连线；内部运算、时序及行为未知，输出是 as_built / partial，不能直接批准交接。在临时实验工作区通过“保存草稿”提交，随后可在图上提问、由 Codex 读取 context 并答复、保存继续位置。

```bash
rtlarch verify verify.json --workspace . --json
rtlarch resume --workspace . --json
rtlarch open --workspace .
```

verify 的 moduleIds 是已保存导入模型的 top；日志和二进制放入每次独立的 evidence/runs 目录。结果只证明本样例自检，不能让部分导入模型自动变完整。

修改 stage.sv 后：

```bash
rtlarch import-impact candidate/import.json --workspace . --json
rtlarch runs --workspace . --json
```

两个 stage 实例需要重新核对，旧运行显示输入已变化。重新展开并导入到新目录，比较新旧模型；不重新手抄层级或用旧日志冒充本次执行。

完整自动化复现（始终使用临时工作区）：在工具仓库运行 `npm run check:workflow`。可追加 `-- /tmp/new-workflow-report.json` 保存新报告。自动化中的提交仅模拟实验用户保存，不允许 skill 在真实项目自动确认。
