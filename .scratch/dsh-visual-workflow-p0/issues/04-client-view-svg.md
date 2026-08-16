# 04 · Client 只读图 + 模板列表（settings.section）

## 目标
在 Web UI 的 settings.section 注册「工作流」页：
- 模板列表（内置：开发工作流 2.0）
- 选中模板 → 只读 SVG 流程图：手写分层 DAG 布局（拓扑分层 + 层内排序），节点显示 id/角色/模型；success 边与 failure（打回）边颜色区分；$end 终态节点
- 「运行」按钮：输入 taskId/issue 引用 → host.call('workflow.run') → 展示 runId 与状态轮询结果（文本摘要，P0 不做染色看板）

## 约束
- plain JS + React.createElement（useState/useEffect），SVG 元素手写，无第三方库
- 样式走 theme CSS 变量（styles.insert 仅注入局部 CSS）

## 验收
- settings 面板出现「工作流」入口；模板可见；SVG 图分层正确无重叠
- 点运行后流程在会话内执行（进度可见），状态轮询返回阶段信息

## 依赖
03
