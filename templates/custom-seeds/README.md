# 历史自定义工作流种子

本目录存放已退出「正式内置」身份的工作流蓝图（见 #82）：

- `default-workflow` — 默认工作流
- `dev-workflow-2-0` — 开发工作流 2.0

## 对用户意味着什么

- 仍可安装、生成、出现在模板库中，但**不再标为系统内置**（可覆盖、可删除）。
- 正式内置蓝图只在上级目录 `templates/*.json`（当前为「建设 · 完整功能开发」等）。

## 生成

`npm run generate` 会同时编译：

1. `templates/*.json`（正式内置）
2. `templates/custom-seeds/*.json`（本目录种子）

产物仍写入 `.generated/<id>/`，供插件列表与技能安装使用。
