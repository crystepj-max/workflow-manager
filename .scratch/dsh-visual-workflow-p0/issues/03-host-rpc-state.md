# 03 · Host RPC 与运行状态

## 目标
Host 半暴露给 Client 的 Package-private RPC（harness.handle）：
- `templates.list()` → 内置模板元数据 + DSL JSON
- `workflow.validate(dsl)` → 校验结果
- `workflow.compile(dsl)` → 预览（节点/边/轮次摘要）
- `workflow.run({ templateId, taskId, issue, models, entry })` → 启动（内部：编译 → workflowEngine.start），返回 runId + 初始状态
- `workflow.state(runId)` → 运行状态快照（阶段/轮次/节点状态/最新报告摘要）

运行状态存内存（P0 不做持久化），供 Client 轮询。

## 验收
- 五个接口均可经 host.call 调用并返回合法 JSON
- run 启动后 state 可读到当前阶段与节点状态

## 依赖
02
