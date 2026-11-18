# 对象讨论与候选决策

本功能共用 workbench、已登记提案、study、verify 和原始 diff。页面不调用聊天模型或云服务，保存问题后仍由 Codex/操作者读取和处理。工作记录不改变硬件模型、模块确认或整体批准。

## 对具体对象提问

在 external-axis 临时副本中进入任一寄存级，显式打开状态范围，点击状态，再点击“对此提问”。状态规则表的每一行也有独立入口；需求在设计说明中，义务在模块行为约定中。问题头部显示作用域、完整实例路径和对象 ID。普通选择和提问不重新布局。

目标示例（版本值换为实际 modelHash）：

```json
{
  "modelHash": "实际模型的64位摘要",
  "moduleId": "stage0",
  "connectionIds": [],
  "object": {
    "kind": "update_branch",
    "scope": "stage0",
    "instancePath": [{"moduleId":"top"},{"moduleId":"stage0"}],
    "stateId": "stage0_data_q",
    "id": "load"
  }
}
```

`kind` 支持 local_state、update_branch、requirement、obligation；只有 update_branch 额外带 stateId。reset / otherwise 分别关联现有复位 / 保持规则。路径使用 IR 实例 ID，不是 rtlModule 定义名，也不猜测 HDL 层级路径。数组节点必须提供明确 index；不默认第一个元素。local state 仍遵守现有 IR 的 subsystem 作用域限制。

`rtlarch workbench --workspace 项目 --json` 返回 workbenchHash；写入 action 的 baseHash 使用这个摘要，target.modelHash 使用对象模型摘要。`rtlarch schema workAction --json` 可查询完整格式。候选目标还必须带匹配的 proposalId。

保存“继续工作”后，`rtlarch open --workspace 项目` 会核对 checkpoint 并恢复同一对象；分支恢复到对应规则行。新目标采取保守版本约束：任何 modelHash 变化都显示失效，即使修改发生在其他模块；保留历史，不按名称或当前同名对象重绑。需要核对新版本后显式建立新问题或继续位置。旧模块/连接记录仍可读取，旧文件不补 object 字段。

## 比较、预算与决策

1. 在“变更”中载入完整候选 A/B。只读比较分别计算版本、结构/未知记录及匹配该版本的已有实验，展示确定性摘要和完整原始 diff。
2. 需要持久关联时显式点击“登记 A/B 供预算与决策关联”。登记沿用 proposals/registered，不提交模型，不改变预览提交基线。
3. 在“讨论与继续 → 方案预算”为每个方案选择自己的候选，并填写配置、工作量及假设。计算仍是资源服务量下界；候选文件变更或改选新版本后，旧预算显示不适用，须另存新预算。
4. 在“决策记录”选择已有问题、两个候选、各自预算及实验，填写假设和风险。实验必须匹配该候选 hash 且声明输入新鲜；A 的运行不能挂到不同版本的 B。失败实验允许保留，不升级成通过。
5. 操作者填写选择理由后点击“我选择 …”。选择追加到决策记录，不自动提交、批准、标问题解决或反写 specification.decisions。需要改硬件时仍走 preview/commit 和独立审阅。

决策保存于 workbench 的可选 decisions 字段；旧文件不补空数组。每个选项保存 candidate.proposalId/modelHash、budget.studyId/optionId、assumptions、risks、experiments.runId/modelHash。预算继续保存在原 studies 中，每个候选方案增加可选 candidate 引用；只保留引用和条件化计算，不复制硬件模型。

已登记候选不可变。修订产生新的 ID/hash；旧预算仍是旧候选的历史记录，不会随新候选改名或换值。若当前提交基线、实验来源或产物变化，相应记录显示 STALE。未执行实验显示无证据；失败和未知仍可读。旧增量提案在基线不可用时不能重建，不借当前模型猜回旧版本。

摘要明确报告状态/更新、真实规则顺序、可解析位宽、显式 cast/截断、完整连接端点和位域。数组逐实例解析或无法求值时保留未知。摘要不从位置推断优先级，也不推导端到端性能；原始 diff 始终保留。

本地 author=user 只是选择记录，不认证身份。没有新的候选仿真器；只读评估不执行命令，需要实验时仍通过显式 verify 清单及临时候选工作区操作。页面只能关联本工作区已有、匹配模型版本的 verify 记录。

维护入口：`npm run check:work-objects` 和 `npm run check:decisions`，各自在临时工作区验证边界。后者的实验仅为 Node 记录隔离 fixture，不声称 RTL 通过。实际执行与浏览器截图见 [本轮报告](../../docs/evidence/object-collaboration/README.md)。
