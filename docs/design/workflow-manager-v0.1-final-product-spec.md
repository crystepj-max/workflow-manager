# Workflow Manager v0.1 正式工作流产品规格与实施拆解

> 状态：统一审查定稿基线  
> 日期：2026-08-30  
> 范围：建设 / 优化 / 诊断 / 探索四套正式工作流，以及共享 Blueprint、Logical Run、角色、版本、人工交互、模型配置和执行入口能力。

## 1. 产品定位

Workflow Manager 是一套可配置、可运行、可干预、可恢复、可追溯的工作流系统，而不只是可视化串联 Agent 的流程编辑器。

四套正式 Built-in Workflow 代表四种解决问题机制：

1. **建设 · 完整功能开发**：正式、完整或较高风险的功能建设；
2. **优化 · 快速迭代**：目标基本明确的小型优化、文档/配置/Prompt 等快速修改；
3. **诊断 · 缺陷修复**：先建立根因证据，再修复和回归；
4. **探索 · 多视角探索**：复杂开放问题，多视角独立研究后综合与评估。

它们不是“复杂度四档”。用户选择模板的核心问题是“我现在面对哪一种问题”。

## 2. 产品七层模型

### 2.1 Workflow Asset

长期资产分为 Workflow（Built-in / Custom）与 Role（Built-in / Custom）。Built-in 是系统当前维护的正式标准；被新标准取代的历史试验资产迁移为 Custom，不继续占据 Built-in 身份。

### 2.2 Workflow Blueprint

Blueprint 至少定义 nodes / edges、role bindings、provider / model bindings、node goals、input / output schema、Business Outcome Routing、Completion Mapping、Human Decision rules、automatic rollback budget、fan-out / aggregation 与 formal artifact declarations。

核心规则：**Node 只报告专业结果，Blueprint 负责解释结果并决定流向。** Node 不得通过 `next_node` 等字段耦合拓扑。

### 2.3 Invocation / Skill

当前正式入口仍以 Skill / Chat 为核心。未来插件侧如增加“使用此工作流 / 运行”等入口，也只能作为新的 Invocation Adapter，最终进入同一个 Logical Run Runtime，不能形成第二套运行体系。

### 2.4 Logical Workflow Run

一个 Logical Run 代表用户从开始到结束的一次完整任务，不等同于底层 Workflow Engine 的一次 `start()`。同一 Run 可以包含多个 Execution Segment，以及 WAITING_HUMAN、PAUSED、BLOCKED、Snapshot Revision、Guidance、Decision 等事件。

### 2.5 Run Snapshot

Run 创建时冻结 Workflow、Role、Provider / Model 与关键运行配置。v0.1 运行中只允许修改 Provider / Model，并产生 Snapshot Revision；只影响当前 Run，不修改来源 Workflow 或其他 Run。

### 2.6 Run Lifecycle

框架固定以下 Lifecycle，不开放自定义：

`READY / RUNNING / WAITING_HUMAN / PAUSED / BLOCKED / COMPLETED / STOPPED / FAILED`

仅 `COMPLETED / STOPPED / FAILED` 为终态。

### 2.7 Formal Records / Provenance

正式记录分为：输入/基准、成果、证明/决策。Formal Record 不覆盖修改；变化产生 Revision，并记录依赖的具体 Record Revision 与产生时的 Snapshot / Provider / Model。

## 3. Workflow 三层结果模型

### 3.1 Workflow Lifecycle

表示整个 Logical Run 的运行状态，仅由框架定义。

### 3.2 Node Business Outcome

表示 Node 自己的专业判断和路由依据，例如：

- 优化 Evaluator：`PASS / OPTIMIZE / CONFIRM`
- 探索 Evaluator：`PASS / NEEDS_RESEARCH / INSUFFICIENT`
- Review：`APPROVE / REQUEST_CHANGES`

框架可提供 Preset，但不能强制字段固定叫 `outcome`。自定义 Workflow 可配置自己的结果字段路径和枚举。

技术执行成功与业务 Outcome 必须分离：Agent 正常返回合法结构化结果，不代表业务结果必须 PASS。

### 3.3 Completion Type

表示一个 `COMPLETED` Run 以什么业务原因完成，例如 `EVALUATION_PASSED / USER_ACCEPTED / INSUFFICIENT / DELIVERED / COMPLETED_OBSERVING / NO_FIX_NEEDED`。

权威事实来自终态 Node 的结构化结果；Run 层只镜像摘要用于搜索、筛选和看板。

## 4. 全局设计原则 R1–R6

展开定义、四套模板方法论与新增角色/模板检查清单见长期方法论文档 [`workflow-design-principles.md`](workflow-design-principles.md)（#71）。本节只保留本版本规格需要的摘要。

1. **R1**：Node 报告专业结果，不报告 next node；
2. **R2**：Blueprint 把 Business Outcome 映射为路由；
3. **R3**：Formal Record 使用不可覆盖 Revision；
4. **R4**：Proof 绑定具体输入/成果 Revision；旧 Proof 保留，但对新版本变为 stale；
5. **R5**：失效按真实依赖判断，不机械重跑全部下游；
6. **R6**：每次 Run 冻结 Workflow / Role /关键配置；v0.1 当前 Run 只允许 Provider / Model Snapshot Revision。

同时遵循：角色能力化、节点场景化；执行与独立证明分离；问题返回真正根因来源；不确定性是一等信息；Human Decision 是框架能力；机器结构英文、正式用户文档中文；Invocation 与 Runtime 分离；收口是质量循环终点。

## 5. Lifecycle 与异常路径

### WAITING_HUMAN

用于系统已经知道需要人做什么决定的场景，例如需求基线确认、最终验收、Evaluator `CONFIRM`、自动回退额度耗尽。

达到额度后进入：

`WAITING_HUMAN + reason=MAX_ROUNDS_REACHED`

而不是 `FAILED_MAX_ROUNDS`。

**关键规则：自动回退额度限制的是自动流转能力，不得改写已经形成的 Node Business Outcome。**

### PAUSED / Run Guidance

PAUSED 表示条件具备但用户主动暂停。支持 Safe Pause、Interrupt 和多轮 Guidance。普通 Guidance 不改变正式 Baseline；若用户改变目标、范围或硬要求，必须回负责 Baseline 的业务节点生成新 Revision。

### BLOCKED

系统想继续但必要外部条件缺失，例如 Provider quota、鉴权失效、模型不可用、测试环境不可用。可恢复后继续同一个 Logical Run。

### FAILED

只用于无法安全恢复的框架/运行完整性错误。

### OBSERVING

OBSERVING 不是 Lifecycle。缺陷可 `COMPLETED` 后显示“已完成 · 观察中”；复发创建新缺陷 Run，不重新打开旧 Run。

## 6. Snapshot、Model Override 与 Preflight

Built-in Workflow 原始结构只读，但用户可以保存 Provider / Model Override：

`Built-in Workflow + User Override -> Effective Workflow -> Run Snapshot`

修改 Node、Edge、Role、Goal、Schema、Outcome Routing、Human Decision、回退规则或拓扑时，必须“基于此模板创建自定义工作流”。

v0.1 不做静默 Backup Provider / Failover。模型不可用时：

`BLOCKED -> 用户修改当前 Run Provider/Model -> Snapshot Revision -> Probe -> Resume`

验证分两层：Static Validation + Runtime Preflight Probe。Probe 只验证当前 Provider / Model 能否完成最小真实调用，不评价回答质量，也不能替代产品模式真实 E2E。

## 7. Formal Record / Proof Chain

系统自动记录 logical_run_id、node / attempt、snapshot revision、record revision、dependencies、actual provider/model、Node Outcome 与相关 Decision / Guidance。

示例：

`Requirement R1 -> Design D1 -> Implementation I1 -> Review RV1 -> Test T1`

若产生 `Implementation I2`，RV1/T1 仍保留为 I1 的历史证明，但不能证明 I2。

探索增加 Targeted 专家证据时保留原专家结果，只重新生成依赖旧证据集合的 Synthesis / Evaluation。

## 8. 12 个正式 Built-in Role

通用：

1. `requirements` — 需求分析
2. `designer` — 方案设计
3. `dev` — 开发
4. `review` — 审核
5. `test` — 测试
6. `evaluator` — 评估
7. `accept` — 验收助手
8. `closeout` — 收口

专业：

9. `diagnose` — 缺陷诊断
10. `orchestrator` — 探索统筹
11. `researcher` — 专家研究
12. `synthesizer` — 综合分析

旧 `dispatcher` 迁移为 Custom Role。共享 Role 不代表共享 Node Outcome Schema；例如优化和探索都使用 evaluator，但各自评价契约与枚举由节点定义。

## 9. 四套正式 Built-in Workflow

### 9.1 建设 · 完整功能开发

`需求分析 -> 方案设计 -> 开发 -> 独立审核 -> 独立测试 -> 人工验收 -> 收口`

- 需求最终确认是强 Human Gate；
- Dev -> Review -> Test 固定顺序；
- 实现 / 方案 / 需求问题分别返回真正上游；
- 上游正式变化只让依赖它的 Proof 失效；
- 自动回退额度默认 3；
- Human Acceptance 是正式业务阶段。

### 9.2 优化 · 快速迭代

`目标确认 -> 执行 -> 评估 -> 收口`

- 目标确认生成并冻结 evaluation contract；
- 执行采用最小必要修改并保护已满足部分；
- Evaluator 只输出 `PASS / OPTIMIZE / CONFIRM`；
- `OPTIMIZE -> execute` 消耗自动回退额度；
- `RECONFIRM_REQUIRED` **不是 Evaluator 裁决**。当执行节点发现冻结的 evaluation contract / Baseline 因新事实、约束或环境变化已不再可执行时，由执行节点输出 `RECONFIRM_REQUIRED`；
- `RECONFIRM_REQUIRED -> 目标确认`，`countRound=false`，重新确认/修订 evaluation contract；
- Completion 区分 `EVALUATION_PASSED / USER_ACCEPTED`；
- 自动回退额度默认 3。

### 9.3 诊断 · 缺陷修复

`缺陷诊断 -> 修复 -> 审核 -> 回归验证 -> 收口`

- 先诊断、后修复；
- 原始 feedback signal 贯穿诊断、修复、回归；
- 证据不足且不可复现时 BLOCKED，不猜根因；
- 修复问题回修复，证据推翻根因回诊断；
- 修改后必须重新审核和回归；
- 默认无独立人工验收；
- 默认自动回退额度具体数值尚未最终确认，推荐 3 但未锁定。

### 9.4 探索 · 多视角探索

`探索统筹 -> 专家研究(Fan-out 3–5) -> 综合分析 -> 结论评估 -> END`

- Orchestrator–Workers + Synthesis + Evaluation；
- 第一轮专家上下文隔离；
- 专家区分事实 / 推断 / 未知并提供证据、反证、假设、不确定性；
- Synthesis 构建共识 / 分歧 / 证据地图，不多数投票；
- Evaluator 输出 `PASS / NEEDS_RESEARCH / INSUFFICIENT`；
- `INSUFFICIENT` 是合法完成；
- 后续研究只做 TARGETED，新证据必须重新 Synthesis / Evaluation；
- 不增加 Closeout Agent；
- **总研究轮次最多 3 轮，包含首次 BROAD**；
- 自动流程最多为 Round 1 BROAD + Round 2 TARGETED + Round 3 TARGETED；
- 因初次执行不计自动回退额度，最多只有 **2 次 `NEEDS_RESEARCH -> orchestrate` 自动回退**；
- 第 3 轮后不得自动启动第 4 轮；
- 如果第 3 轮 Evaluator 仍输出 `NEEDS_RESEARCH`，必须保留该 Outcome，并进入 `WAITING_HUMAN + reason=MAX_ROUNDS_REACHED`；**不得为了结束流程把它改写成 `PASS` 或 `INSUFFICIENT`**；
- Human Decision 展示三轮研究历史、未解决缺口、继续研究的价值 / 成本 / 风险。用户可接受当前不确定性并受控完成、停止，或基于新目标 / 新范围派生新 Run。

## 10. Built-in / Custom 迁移

正式 Built-in Workflow 只保留四套新标准。

历史 `default-workflow` 与 `dev-workflow-2-0` 迁为 Custom Workflow；旧 `dispatcher` 迁为 Custom Role。迁移应保留用户引用、Skill 兼容和历史可追溯性。

Draft PR #70 已关闭且未合并；`feat/multi-perspective-exploration` 仅作为 #81/#82 实现素材库。允许选择性复用探索 Prompt / Schema 思路，但不得 reopen/rebase #70，也不得整包 cherry-pick 旧 success/failure 路由、10-role registry 或旧数量测试。

## 11. UI / 交互边界

当前真实路径仍是：模板库 -> 编辑器 -> 保存生成/更新 Skill -> Chat 调用 Skill。

#75 负责正式 UI/交互架构。必须保证 Lifecycle / Node Outcome / Completion Type 分层表达；一个 Logical Run 跨多个 Execution Segment 仍显示为一个 Run；Chat / Skill / 插件入口共享同一 Runtime。

## 12. 实施依赖

### Phase A — Blueprint / 结果 / 证明契约

- #71 全局工作流设计原则
- #77 Business Outcome Routing / Completion Mapping
- #72 Human Decision
- #73 自动回退额度 / countRound
- #78 Formal Records / Provenance
- #69 多格式 Formal Artifact

### Phase B — Logical Run Runtime / 发布底座

- #79 Logical Run / Execution Segment / Lifecycle / Snapshot Revision
- #80 Pause / Interrupt / Guidance / Resume
- #74 Preflight Probe
- #40 legacy engine-run persistence 已由 PR #50 完成；Logical Run persistence 在 #79 基于既有持久化层演进
- **#53 开发模式 / 产品模式双轨与发布闸门**

### Phase C — 正式资产 / Invocation

- #58 Built-in / Custom Role Library 基础能力已完成
- #81 12 个正式 Built-in Role
- #82 四套正式 Built-in Workflow + 历史模板迁移 + Built-in Model Override
- #83 Skill / Chat Invocation -> Logical Run Runtime

### Phase D — UI

- #75 整体 UI / 交互架构，定稿后再拆前端施工任务。

## 13. 发布门槛

四套正式模板进入 Built-in 并发布 v0.1 前至少满足：

- Blueprint 能表达专业 Outcome、自定义结果字段与 Completion Mapping；
- 合法业务结果不再伪装成 failure；
- 每个正式 Outcome 明确 producer + field path + route；
- Human Decision 可等待 / 恢复并持久化 Decision Record；
- 自动回退额度可按业务回退路径独立计数；
- 额度耗尽时保留原 Node Business Outcome 并转 WAITING_HUMAN；
- Logical Run 可跨多个 Execution Segment 保持同一 Run；
- Run Snapshot 冻结，v0.1 当前 Run 只允许 Provider / Model Revision；
- Preflight Probe 可实际验证当前模型；
- Formal Records / Revision / dependency 可追溯；
- 12 Roles 与四套 Workflow 正确生成 / 更新 Skill；
- 旧 Built-in 资产完成兼容迁移；
- **#53 发布闸门完成：开发态不是发布证据，正式发布必须重新生成正式产物、完整重启 DSH，并在产品模式完成真实 E2E。**

## 14. 当前未决项

仅保留：**诊断模板默认自动回退额度的具体数值**。推荐 3，但实施前必须明确确认。

探索轮次已经锁定：总研究轮次最多 3，首次 BROAD 计入总数，最多 2 次自动 `NEEDS_RESEARCH -> orchestrate` 回退；第 3 轮仍 NEEDS_RESEARCH 时保留 Outcome 并转人工。

## 15. 历史 Issue / 文档边界

- #3 已审计并关闭为 Historical / Superseded；当前正式产品总览由 #76、UI 由 #75 承接；
- #64–#68 已 superseded，不再作为施工依赖；
- #40 保持 completed，不重新打开；
- `CONTEXT.md` 与旧“开发工作流 2.0”文档当前继续描述 main 的兼容实现，待 #77/#79 等新语义真实进入 main 后再同步重写，避免文档先于代码。
