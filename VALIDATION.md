# 公开源码验证

2026-10-10，在独立公开源码副本上完成以下验证。未带入真实 RTL 项目的模型、合同、截图、批准或历史验证材料。

| 验证 | 结果 |
|---|---|
| `npm run build` | TypeScript 检查与 Vite 生产构建通过；保留现有大 chunk 提示 |
| `npm run check` | 8 个入口、75 组检查通过，包括模型、提案、还原、数组、阅读布局与离线交付 |
| `npm run rtl:test` | tiny-stream 自检通过：接收 1134，输出 1125，复位取消 9；TIMEOUT 负例按预期失败 |

环境为 Linux/WSL、Node 24.18.1、npm 11.6.2、Verilator 5.053 开发版本。验证时复用了本机已安装的锁定依赖；没有在全新机器上重新下载依赖或验证原生 Windows/macOS。

首次克隆必须先 `npm ci`、`npm run build`，再运行完整检查或启动服务；部分检查需要构建后的页面。首次在未构建的副本上运行检查时，服务按预期报告页面缺失；完成构建后重新运行全部检查通过。

公开版仅调整发布说明、许可证、包元信息与已排除历史材料的链接，功能源码和通用 RTL 示例保持不变。本次没有重新执行浏览器图形回归。RTL 自检只覆盖 tiny-stream fixture，不证明其他设计或架构模型的 RTL 一致性，也不替代综合、STA、formal 和器件验收。

## 复现

准备固定版本的 Node/npm、Python 3，以及 Verilator 和 C++ 构建工具后，在仓库根目录运行：

```bash
source ./env.sh
npm ci
npm run build
npm run check
npm run rtl:test
```

所有自动检查中的提交、确认和导出均使用临时工作区。
