# 硬件对象选择与讨论恢复

修改前在临时 external-axis 副本点击完整图的 `middle_tdata`。侧栏只显示通用提示和连接编辑入口，信号详情未出现。切到总览并点击 `boundary_m_axis_tdata` 后，图选中输出关系，讨论仍显示 `middle_tdata`。在输入寄存级选择第二个状态 `stage0_valid_q` 后离开并返回，局部图仍按该状态生成，下拉却显示 `stage0_data_q`。[修改前实测](before.json)

修改前的 `rtlarch open` 恢复地址带 `checkpoint=1`、`module=stage0` 和 `panel=work`。在 1440×1000 和 1100×800 均能定位到原 `load` 分支，但详情遮罩挡住了问题输入框，画布高度均为 0。

## 对象身份与界面

- `SelectionRef` 绑定模型 hash、图所在层级、实例路径，以及关系的原始连接或依赖成员。状态分支保存状态 ID 和分支 ID。图、详情、问题和继续位置引用同一对象。旧讨论仍按已有 ID 和版本读取。
- 点击和选择原始成员只更新选择。显式追踪维护自己的范围，退出后回到原任务。跨层定位由当前端点确定目标层级和原始连接。
- 状态规则在详情栏内显示，继续位置直接定位活动分支。源文件、表达式依赖和核验明细需要时可展开。讨论高度由拖动条或方向键调整，按工作区保存在 `.rtlarch/work-dock.json`。
- 同一个对象的草稿独立保留。点 B 后输入 B 的问题，回到 A 可继续 A 未发送的草稿。

## 最终验收

| Chromium 窗口 | 画布高度，修改前 → 后 | 冷恢复后保存的讨论高度 | 同屏操作 |
| --- | ---: | ---: | --- |
| 1440×1000 | 0 → 347 px | 286 px | 输入、已保存讨论、活动分支、选中状态与相邻状态 |
| 1100×800 | 0 → 209 px | 224 px | 输入、已保存讨论、活动分支、选中状态与相邻状态 |

两个窗口均走完 A 与 B 的分别提问、进入子层并从同一端口返回、连接 B 的继续位置、状态下拉跨层返回，以及分支的 checkpoint 和讨论链接。拖动前后比较实际渲染的节点位置和路径。展开证据和扩大追踪时保持相同的提问对象。旧记录在新页面恢复到同一状态和分支，旧文件字节一致。[浏览器输出](browser.json) · [1440×1000](1440-checkpoint.png) · [1100×800](1100-checkpoint.png) · [旧记录恢复](legacy.json)

## 重跑浏览器验证

从工具根目录运行。使用临时 Playwright 环境和本机 Chromium 运行库。脚本为各窗口尺寸创建独立工作区，用 CLI 打开和停止服务，结束后清理工作区。

```sh
source ./env.sh
npm run build
browser_check=$(mktemp -d -t rtlarch-browser-check-XXXXXX)
npm --prefix "$browser_check" --cache "$browser_check/npm-cache" install --no-save --no-audit --no-fund playwright@1.56.1
export PLAYWRIGHT_BROWSERS_PATH="$browser_check/browsers"
"$browser_check/node_modules/.bin/playwright" install chromium --only-shell
node scripts/check-selection-browser.mjs "$browser_check" "$browser_check/results"
```

脚本通过实际鼠标命中图中连接，核对保存的问题和版本，并使用 CLI 生成的完整恢复地址重进。分支恢复时冷启动服务。图形位置和走线路径来自浏览器渲染，当前对象、输入框、讨论和分支由实际视口命中核对。

最终构建通过。整套检查的首次串行运行收到 SIGTERM，随后在最终源码上分组运行标准 27 个维护入口和 `rtl:test`，均以 0 退出。工具根目录的模型与布局 SHA-256 一致，浏览器样例的模型字节与批准状态一致。临时服务和浏览器环境已清理。[浏览器脚本](../../../scripts/check-selection-browser.mjs) · [构建日志](build.log) · [维护与 RTL 检查日志](check.log)
