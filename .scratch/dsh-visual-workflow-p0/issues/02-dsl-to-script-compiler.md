# 02 · DSL → workflow script 编译器

## 目标
把合法 DSL 编译为 workflow 工具可执行的 JS script 源码（字符串产物）：
- 节点 → `agent(prompt, { schema, label, provider, model })` 调用序列
- 边 → 控制流：success 边接下一节点；failure 边接打回目标；同一来源的 success/failure 双出口编译为 if 分支
- `control.maxAttempts` → for 循环上限；`control.maxRounds` → 外层轮次
- `output.schema` → agent schema 校验；`successCondition` → 结构化判定后路由
- `manualCheck: true` 节点 → 编译为返回 `AWAITING_HUMAN` 状态（脚本外人工裁决后以 entry 续跑）
- 超限 → 自动回调度归因（复用既有语义）

## 产出
- 编译器函数：`compileDsl(dsl, ctx) -> { script, phases, warnings }`
- 单测样例：开发工作流 2.0 图编译产物与手写版 dev-workflow-2.0.mjs 行为对照

## 验收
- 编译产物经 workflowEngine.start 可执行
- 打回边、9 轮上限、manual_check 暂停语义与图一致

## 依赖
01
