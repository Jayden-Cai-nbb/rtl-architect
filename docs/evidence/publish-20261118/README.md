# GitHub 更新整理 · 2026-11-18

基于远端 main 的 2aacd4ff0b70db44538ef728df9f95f071c7af42 整理更新。本地维护目录没有可用 Git 历史，因此使用独立克隆保留真实远端历史。

保留远端 LICENSE、发布版 package 元数据、忽略规则及既有历史文档。同步新版源码、维护检查、通用示例和对应的八组专题证据；未重新加入本地旧版本重复截图、私人研究笔记、运行环境或真实项目工作区。文件导航见 ../../REPOSITORY.md。

本轮实际执行 git diff --check、暂存文件范围核对和 npm run check:release。干净安装检查从 lockfile 安装到独立临时目录，构建、skill 安装、带空格工作区、页面服务和模型不变检查通过，详见 release.log。驱动检查使用的 node_modules 链接没有进入提交，受检副本没有复用依赖、dist 或 runtime。

预算等功能的此前完整维护检查见 ../storage-budget/README.md 等专题报告；这些历史执行没有改称本轮重新运行。远端 CI 结果以 GitHub Actions 为准。包版本仍为 2.0.0，本轮不创建 Release 或标签。
