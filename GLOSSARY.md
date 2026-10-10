# Workflow Manager

本词汇表统一本仓库的工作流、任务对象和 Multica 任务状态用语，重点区分任务状态、运行记录与执行环境。Multica Task 的状态以 Multica 为准；本地 dev-flow 根据状态安排计划并交给本地 Agent 施工。

## 仓库与工作对象

**Multica Task**：在 Multica 中登记和维护的任务，包含任务内容、状态及负责人等信息；Multica 是其状态和状态变更的权威来源。
_Avoid_: GitHub Issue、本地任务卡

**GitHub Issue**：GitHub 上的任务或缺陷记录，可作为需求来源；它与 Multica Task 是不同系统中的独立记录。
_Avoid_: Multica Task

**本地任务卡**：仓库中用于记录本地任务内容和交付信息的文件或登记项；它不替代 Multica 的任务状态。
_Avoid_: Multica Task

**工作流（Workflow）**：由蓝图定义的一组有顺序和分支关系的步骤，用来完成一类任务。
_Avoid_: 运行、任务

**工作流运行（Workflow Run）**：针对一项任务从启动到结束的一次完整工作流执行；一次运行可以包含多个引擎执行片段。
_Avoid_: 执行片段、单次引擎调用

**执行片段（Execution Segment）**：工作流运行中的一次底层引擎执行；同一工作流运行可因暂停或人工决策而包含多个执行片段。
_Avoid_: 工作流运行

**Agent**：负责执行任务中某一项具体工作的 AI 执行者。
_Avoid_: Runtime、模型

**Runtime**：运行 Agent 的执行环境。Runtime 表示任务在哪里执行，不等同于 Agent、模型或工作流运行。
_Avoid_: Agent、模型、Run

**dev-flow**：本地的任务计划与分派流程；它读取 Multica Task 状态，安排开发计划，并把符合条件的工作交给本地 Agent。
_Avoid_: Multica 状态管理

## Multica Task 状态

**状态分组**：Multica 界面用于归类和排序任务状态的栏目，例如「未开始」「已开始」「已完成」「已关闭」；分组本身不是任务状态。
_Avoid_: 状态、状态流转

**待规划（`backlog`）**：任务仍在整理或等待安排，尚不进入本地开发计划。
_Avoid_: 待办、排队中

**待办（`todo`）**：任务已具备进入计划的资格；dev-flow 核对任务定义和依赖后，可安排本地 Agent 接手。
_Avoid_: 待规划、进行中

**进行中（`in_progress`）**：任务已开始由 Agent 施工。
_Avoid_: 待办、审核中

**审核中（`in_review`）**：任务已交付，正在等待人工审核；自动施工流程暂停。
_Avoid_: 进行中、已完成

**已阻塞（`blocked`）**：任务因外部依赖或条件未满足而无法继续。若改由其他 Runtime 接手，应先由 Multica 记录接管和状态变化，再由 dev-flow 根据更新后的状态重新安排。
_Avoid_: 进行中、失败

**已完成（`done`）**：任务已完成并按任务约定收口。
_Avoid_: 审核中、已取消

**已取消（`cancelled`）**：任务已被决定停止，不再安排施工。
_Avoid_: 已完成、已阻塞
