# 建设 · 完整功能开发 Portable Contract

> **版本**：**v0.1.5（2026-08-30 冻结，同日按 PR #115 Codex Review 多轮修复升 patch；§1–§6 由 #112、§7–§8 由 #113、§9 由 #114 依次落地；Run 级人工验收随 PR #115 进行）**
> **来源**：#102（epic，A1–A5 节为本契约的决断依据）、#103（本契约的任务 issue）
> **消费者**：DSH Execution Profile（#105）、External Coding Agent Profile（#104，Codex/Cursor）
> **纪律**：两个 Profile 只通过引用本契约工作，不得复制或分叉业务语义；本契约是 executor 中立的，只定义产品语义，不定义实现字段（实现字段由各 Profile 的 Adapter 映射）。

## 0. 定位

本契约冻结「建设 · 完整功能开发」工作流的**可移植业务语义**：固定主链、各 Stage 的输入/专业输出/Proof/回退根因、人工门边界、回退与升级规则、Outcome/Routing 兼容原则。

它**不是**：

- 一份 DSH Runtime 实现说明（Runtime 由 #77/#72/#73/#78/#93/#79 逐项落地）；
- 第二份 Workflow 业务定义（各 Profile 不得各自维护语义副本）；
- legacy `dev-workflow-2-0` 的改名（legacy 主链无 requirements/design 阶段，与本契约主链不同）。

冲突裁决顺序：本契约 > 各 Profile 私有说明 > 各执行器默认行为。与 #77/#72/#73/#78/#93 的正式 Runtime 能力收敛后，以正式 Runtime 语义为权威（见 §6.6、§9）。

## 1. 术语

| 术语 | 定义 |
|---|---|
| **Run** | 一次建设工作流的完整执行实例，对应一个 issue/逻辑任务（identity 字段见 §7） |
| **Stage** | 主链上的一个固定业务阶段（§3 的七者之一） |
| **Role** | 执行某个 Stage 专业工作的 agent 会话；只产出专业结果，不做路由决策 |
| **Controller** | Portable Profile 内驱动流程的控制器/runbook；解析专业结果并决定路由、挂起、升级 |
| **专业结果** | Role 对其 Stage 问题的结论、findings、证据的集合；是权威事实源 |
| **Proof** | 与专业结果绑定的可验证证据，必须关联实际验证的 workspace/branch/HEAD（字段见 §7） |
| **回退** | 已离开某 Stage 后，因后续阶段暴露问题而返回上游 Stage 重新产生成果 |
| **自动回退额度** | Run 级计数，限制 Controller 自动执行回退路由的能力（§4） |
| **挂起（AWAITING / WAITING_HUMAN）** | 流程暂停等待人工输入或决策；不是失败终态 |
| **升级** | 额度耗尽或完整性违约时，把决策权交还人工；专业结果原样保留 |
| **冻结基线** | 经人工确认后不再变动的产物版本；变动必须生成新 Revision 并重新确认 |

## 2. 固定主链与不变量

主链七阶段，顺序固定，任何 Profile 不得增删、改名或重排：

```text
requirements -> design -> dev -> review -> test -> human acceptance -> closeout
```

**不变量**：

1. **顺序固定**：review 先于 test（review 通过的 HEAD 才进入 test）；human acceptance 先于 closeout。
2. **独立证明者**：review 与 test 的执行会话必须独立于 dev 会话；允许顺序调用独立会话，禁止同一会话自证。
3. **Proof 绑定真实现场**：一切 Proof 必须绑定实际验证的 workspace/branch/HEAD（§7 定义字段）。
4. **无旁路**：不允许跳过 human acceptance 直接 closeout；不允许绕过 review/test 直接 acceptance（Profile 不得以工具限制为由取消独立证明）。
5. **挂起优于编造**：任何 Stage 信息不足、等待人工、额度耗尽时，流程挂起并保留原始专业结果；禁止编造、篡改或静默改写。
6. **一份语义**：两个 Profile 对上述全部语义只有本契约一个来源。

## 3. Stage 契约

每个 Stage 按四要素描述：**输入 / 专业输出 / Proof / 回退根因**。Role 只报告本 Stage 的专业结果；是否前进、回退、挂起由 Controller 依本节规则决定。

### 3.1 Requirements — 需求基线

- **目的**：把 issue/原始需求加工为可执行需求，经人工确认后冻结为 baseline，成为后续全部 Stage 的唯一范围依据。
- **输入**：issue/需求原文与全部评论、仓库现状、既有契约/ADR、既往分析产物。
- **专业输出**：requirements baseline——含三要素（任务目标 / 涉及范围 / 验收标准）与澄清决策记录；无法得出的要素必须显式标注「缺失 + 补齐建议」，不得编造。
- **Proof**：baseline 文档（带版本标识）+ 人工确认记录（确认人、时间、被确认版本）。
- **回退根因**：本 Stage 是**需求/范围类问题的根因汇入点**——接收下游一切需求类回退；被回退后生成新 Revision，重新走人工确认。
- **完成判定**：baseline 通过人工确认（Decision Record：`BASELINE_CONFIRMED`，见 §5），形成冻结版本。
- **挂起条件**：三要素存在缺口且无人可问 → 挂起（`awaiting-human-input`），保留缺口清单，等待人工补齐后重入。

### 3.2 Design — 方案设计

- **目的**：在冻结 baseline 范围内产出可执行方案与决策点清单。
- **输入**：冻结的 requirements baseline。
- **专业输出**：design package——方案、受影响模块/接口/数据、风险、未决问题清单、`decision_required` 标记（true/false + 判据命中说明，判据见 §5.2）。
- **Proof**：design package；（条件门触发时）对应的 Human Decision Record。
- **回退根因**：发现 baseline 缺陷、歧义或范围变化 → 回 **Requirements**（生成新 Revision，不直接修改 baseline）；本 Stage 同时接收下游一切设计类回退。
- **完成判定**：package 完整，且 `decision_required=true` 时决策已记录。默认自动推进，不设固定人工门。

### 3.3 Dev — 开发实现

- **目的**：在隔离 workspace 中按冻结方案实现，自验满足验收标准。
- **输入**：冻结 design package + 隔离 workspace（独立 branch/worktree，规则见 §7）。
- **专业输出**：实现（代码/文档）+ dev handoff（改动摘要、自验记录与结果、影响面说明）。
- **Proof**：实现与自验记录绑定 work_branch + current_head。
- **回退根因**：开发中的内部迭代（实现问题自修复）**不算回退**（#73：节点内部 REVISE 不计额度）；本 Stage 接收下游一切实现类回退。
- **完成判定**：自验通过且 dev handoff 完整。

### 3.4 Review — 独立审核

- **目的**：由独立会话审核实现与冻结方案/baseline 的一致性。
- **输入**：dev handoff + 实际 workspace/branch/HEAD。
- **专业输出**：review proof——结论（approve / request-changes）、逐条 findings、**每条 finding 的根因分类**（dev / design / requirements）、verified branch/HEAD。
- **Proof**：review proof 绑定 verified workspace/branch/HEAD；审核会话与开发会话独立（不变量 2）。
- **回退根因**：request-changes 时按每条 finding 的根因路由：实现 → **Dev**、设计 → **Design**、需求 → **Requirements**；未标注或确实无法分类的 finding，默认由 **Dev** 承接（Dev 判断属设计/需求问题后可再报告，由 Controller 按新根因再次路由，仍消耗该次回退额度）。
- **完成判定**：approve 且 review proof 落盘。

### 3.5 Test — 独立测试

- **目的**：由独立会话验证行为满足 baseline 验收标准。
- **输入**：review 结论为 approve 的 HEAD 所对应 workspace。
- **专业输出**：test proof——执行结果、与验收标准的逐条映射、执行环境、失败项根因分类（dev / design / requirements）、verified branch/HEAD。
- **Proof**：test proof 绑定**实际执行验证**的 HEAD，不得引用未验证的 HEAD。
- **回退根因**：与 §3.4 相同的根因路由规则。
- **完成判定**：baseline 全部验收标准有对应通过结果，test proof 落盘。

### 3.6 Human Acceptance — 人工验收

- **目的**：人工对交付成果做正式业务签收。这是主链上唯一的固定人工业务节点；**AI 不代签**。
- **输入**：acceptance package——requirements baseline + design package + dev handoff + review proof + test proof（+ Integration Checkpoint 结果，规则见 §7）。
- **输出**（人工，非 Role）：acceptance decision——accept / reject（reject 必须附 feedback 及其根因指向）。
- **Proof**：acceptance proof——验收人、结论、时间、verified HEAD。
- **回退根因**：reject 按 feedback 根因路由（默认 **Dev**；暴露设计/需求问题按根因回对应 Stage）。**人工打回不消耗自动回退额度**，但计入 Run 历史。
- **特殊语义**：人工知情接受未完全满足 baseline 的结果时，使用 `USER_ACCEPTED`（#72），不得改写 baseline 制造 PASS。
- **完成判定**：accept（或 USER_ACCEPTED）记录落盘，产生 acceptance proof。

### 3.7 Closeout — 收口

- **目的**：只整理、冻结、交付；不重新开发、测试或审查。
- **输入**：通过的 acceptance proof + 本 Run 全部记录。
- **专业输出**：closeout summary——交付清单、冻结记录、**验收决议（`accept` / `user_accepted`，必须保留）**、遗留事项。
- **Proof**：closeout summary + 最终集成结果（PR 编号 / merge commit 至少其一）。
- **回退根因**：**无回退出口**。若发现交付物与 Proof 不符，属完整性违约，升级人工处理，不作为回退。
- **完成判定**：交付完成，Run 归档（记录保留要求见 §7/§8）。`user_accepted` 是合法交付决议：Completion 权威事实以 closeout 保留的验收决议为准，不得把「知情接受的异常交付」洗成普通交付（对齐 #72 与 v0.1 规格 Completion Type）。

## 4. 回退与升级语义

### 4.1 根因路由

| 根因分类 | 回退目标 | 典型来源 |
|---|---|---|
| 需求/范围问题 | Requirements（§3.1） | review/test 发现范围错、验收标准错、baseline 歧义 |
| 设计问题 | Design（§3.2） | review/test 发现方案不可行、接口不成立 |
| 实现问题 | Dev（§3.3） | review request-changes、test 失败的常规缺陷 |

判定纪律：**产生 findings 的 Role 必须给出根因分类**（这是专业结果的一部分）；Controller 按分类路由，不重估专业判断。同一 findings 允许多根因并存，但**一次回退只执行一条回退边、消耗 1 点额度**：Controller 按根因优先级选择本次回退目标（requirements > design > dev，先修上游）；其余 findings 原样保留在记录中，由回退重做后的下一轮 review/test 复验（边级计数语义对齐 #73 与设计原则 11 的 `countRound`）。

### 4.2 自动回退额度

- 默认额度：**3 / Run**（语义对齐 #73：额度统一解释为自动回退额度，限制的是 Controller 的自动路由能力）。
- 计数原则：
  - 首次执行任何 Stage 不计；
  - review / test 触发的回退边：**消耗额度**；
  - Dev 内部迭代（自修复）：不计；
  - 挂起（AWAITING / WAITING_HUMAN / PAUSED）不计；
  - 技术重试（会话崩溃、工具故障重跑）不消耗业务额度；
  - 人工触发（Decision / Acceptance 打回）不消耗自动额度，但显式记录；
  - Human Decision 之后额度是否追加/重置，必须在 Decision Record 中显式记录，不得隐式恢复。

### 4.3 额度耗尽行为

额度耗尽且最新专业结果仍要求回退时：

1. 原 Outcome **原样保留并持久化**，不篡改、不降级为失败；
2. Controller 不执行该自动回退边；
3. Run 进入挂起：`WAITING_HUMAN`，reason = `MAX_ROUNDS_REACHED`（对齐 #77/#73；**不是** legacy 的 `FAILED_MAX_ROUNDS` 终态）;
4. 人工决策包必须展示：原 Outcome、历史尝试、剩余问题、继续的成本/收益/风险、可选方向（接受当前结果 / 追加额度 / 按根因回退 / 停止 / 派生新 Run）。

### 4.4 升级（区别于回退）

两类事件走升级而非回退：额度耗尽（§4.3）与完整性违约（Proof 与交付物不符、Closeout 发现证据链断裂）。升级保留全部现场，决策权交人工。

## 5. Human Decision 与 Human Acceptance 边界

### 5.1 概念边界（对齐 #72）

| 维度 | Human Decision（受控人工决策） | Human Acceptance（人工验收） |
|---|---|---|
| 回答的问题 | 系统不能替用户做的**方向取舍**：选哪个选项、如何处理 | 交付成果**是否通过/完成** |
| 在主链中的位置 | Stage 内的门（非独立业务节点）：requirements 的固定确认门、design 的条件门、额度耗尽等升级门 | 主链第六阶段的固定业务节点 |
| 触发 | 固定门必然触发；条件门命中判据才触发；升级时必然触发 | 到达即触发，唯一且必须 |
| 记录 | Decision Record（不可覆盖），注明选项与理由 | Acceptance Proof（验收人/结论/时间/HEAD） |
| 打回语义 | 结果枚举如 `BASELINE_UPDATED`：目标/范围/硬要求改变 → 回 Requirements 生成新 Revision | reject 打回，按 feedback 根因路由 |
| 挂起表现 | WAITING_HUMAN（持久化要求见 #72，映射见 §7/§8） | WAITING_HUMAN |

### 5.2 Design 条件门判据

`decision_required=true` 当且仅当命中下列之一（Role 报告命中情况，Controller 据此挂起，不重估专业判断）：

1. 存在多个可行方案且权衡实质（成本/风险/架构方向），又无既有决策或契约可引用；
2. 方案引入新的对外契约、新依赖或破坏性变更；
3. 方案与既有决策/契约冲突，或需要推翻既有决策；
4. 出现安全、数据、权限等高风险面的新决策点。

未命中 → 自动推进，不打扰用户（#72：默认自动推进，不得因一般不确定性随意升级）。

### 5.3 决策包要求

任何 Human Decision 必须向决策者提供：目标、当前状态、决策点、候选项、各选项的成本/收益/风险/影响、推荐理由（对齐 #72）。决策缺失或超时 → 保持挂起，**不得由 AI 代答**。

### 5.4 禁止事项

- 禁止 AI 代签 Decision Record 或 Acceptance Proof；
- 禁止改写 baseline / Outcome 制造 PASS（含用 `USER_ACCEPTED` 以外的任何方式表达「知情接受」）；
- 禁止把本应回 Requirements 的范围变更当作 Design/Dev 内部决策处理（Human Decision ≠ 修改 Baseline）；
- 禁止将 Acceptance 当 Decision 用（跳过验收直接做方向裁决），或反之。

## 6. Outcome / Routing 兼容原则

### 6.1 Producer / Router 分离

- **Role = Outcome Producer**：只报告本 Stage 专业结果（结论、findings、根因分类、证据）；
- **Controller = Router**：解析专业结果，依 §3/§4 决定前进、回退、挂起、升级；
- **Role 不得输出 `next_node` 或任何拓扑目标字段**；路由意图只能由 Controller 判定。

### 6.2 专业结果与流程状态两层分离

- 合法的非 PASS 专业结果（review 的 request-changes、test 的失败项、design 的 decision_required）**不是 failure**，不得为适配执行器状态机而篡改；
- 技术执行失败（会话崩溃、工具不可用）与业务结果区分记录；
- 专业结果（Node Result）是权威事实源；Run 层只镜像 Completion 摘要（对齐 #77）。

### 6.3 本契约的专业结果基元

建设主链各 Stage 的专业结果必须可归纳为以下基元（Bootstrap 期间 Controller 可用自有枚举表达，但必须可无歧义映射）：

| Stage | 专业结果基元 |
|---|---|
| requirements | baseline-ready（待人工确认）/ awaiting-human-input（缺口挂起）/ revised |
| design | package-ready / decision-required / requirements-issue（根因回退报告） |
| dev | handoff-ready / blocked（受阻说明）/ design-issue / requirements-issue |
| review | approve / request-changes（逐条 finding 带根因分类） |
| test | pass / fail（逐项带根因分类）/ blocked |
| human acceptance | （人工）accept / reject / user-accepted |
| closeout | delivered |

两类易混结果在此明确：`blocked` 基元仅用于**可恢复的外部/技术条件**（环境不可用、Provider 额度、鉴权失效等），不是业务失败；业务性受阻必须以 `decision-required` 或根因报告表达。节点的业务 `blocked` 结果不等于 Run Lifecycle 的 `BLOCKED` 状态（对齐 workflow-design-principles §3.2/§3.3）。closeout 的 `delivered` 必须携带验收决议（`accept` / `user_accepted`），它是 Completion 的权威事实来源（§3.7）。

### 6.4 路由动作基元

Controller 的路由动作限定为：`proceed`（前进）/ `rollback(<stage>, <root-cause>)`（回退，受额度约束，一次一条边）/ `await-human(<reason>)`（挂起等人工决策）/ `hold(<reason>)`（Run 进入 `BLOCKED`：可恢复外部/技术条件，不消耗额度，条件恢复后重入同一 Stage）/ `escalate`（升级）。`blocked` 专业结果路由到 `hold`；额度耗尽时 `rollback` 不可用，唯一出路是 `await-human(MAX_ROUNDS_REACHED)`。

### 6.5 悬空禁止

每个可路由的专业结果都必须有明确去向（前进、回退、挂起、升级之一），不得出现「规格提到了结果，但没有任何 route」的悬空状态（对齐 #77）。

### 6.6 与 #77 正式 Runtime 的收敛

#77（Business Outcome Routing 与 Completion Mapping）落地后：

- §6.3/§6.4 的基元映射为正式 Outcome field path + route + `countRound` 声明（是否消耗额度，对齐 #73）；
- 字段命名以 #77 实现为权威，本契约只保留产品语义；
- 映射必须完整且不丢历史（Bootstrap 期间的 Run 记录仍可追溯）。

---

## 7. Portable Run / Workspace Contract

### 7.1 Portable Run Identity（最小字段集）

每个 Run 自始至终携带以下最小身份字段（与 #103 列举一致）；七类交接记录的信封全量内嵌它（§8.2）：

| 字段 | 语义 |
|---|---|
| `run_id` | 本 Run 的稳定标识，Profile 生成，Run 存续期不变 |
| `issue_or_task_identity` | 驱动本 Run 的 issue/任务标识 |
| `workspace_id` | 本 Run 的隔离 workspace 标识 |
| `repository` | 目标仓库 |
| `base_ref` | 起点 ref（如 main） |
| `base_commit` | 起点 commit（开工时 target 的 HEAD） |
| `work_branch` | 本 Run 的工作分支 |
| `current_head` | 工作分支当前 HEAD，随 Run 推进更新 |
| `stage` | 当前 Stage（§3 七者之一） |
| `attempt` | 当前 Stage 执行轮次（从 1 起） |

映射承诺：#79（Logical Run / Snapshot）落地后，`run_id` 映射 `logical_run_id`，其余字段映射 Snapshot 对应字段；映射必须可追溯，历史 Dogfood Run 不得因字段调整而丢失（#103 纪律：调整需有映射，不丢历史）。

### 7.2 Workspace 规则

- 默认 **`ISOLATED_WRITE`**（消费 #93）：每个 Run 使用独立 branch + 独立 worktree；禁止在共享 main cwd 中直接开发；
- 同一 Run 的 requirements/design/dev/review/test/accept 记录引用**同一 workspace lineage**（同一 `workspace_id` + branch 谱系）；
- 多 Agent 并行时不同 Run 的 workspace 相互隔离，避免同片代码混写；跨 Run 合流走 Integration Checkpoint（§7.3）；
- Profile 差异只允许存在于 workspace 的创建/清理机制，不允许存在于隔离语义本身。

### 7.3 Proof 绑定与 Integration Checkpoint

- Proof 绑定沿用仓库既有命名：`verified_branch` / `verified_head`（对齐 equivalence-checklist 维度 5 约定）；workspace 关联由信封 `run.workspace_id` 承载（§8.2）；Proof 只对 `verified_head` 有效；
- **Integration Checkpoint**：最终集成（PR/merge）前执行——若 target 已前进（`base_commit` 之后 target 有新提交），必须 sync 后**重跑受影响的 Proof**（至少 review/test；acceptance package 重组后才可签收）；
- checkpoint 结果记入 acceptance package 的 `assembled.integration_checkpoint`（§8.3）。

### 7.4 与 #93 的映射声明

`ISOLATED_WRITE` 与 workspace/branch 隔离是 #93 Workspace/Resource Isolation 的 Bootstrap 前身：#93 Runtime 落地后，隔离强制职责移交 Runtime，`workspace_id` 映射 #93 的 workspace 标识；本节语义不与 #93 最终模型冲突，字段以其为权威。

## 8. Portable Handoff / Evidence Package

### 8.1 七类记录

两个 Profile 在每个 Stage 产出的可审计交接/证据包使用统一 schema：

| 记录类型 | 产生 Stage | 作用 |
|---|---|---|
| `requirements_baseline` | requirements | 冻结需求基线 + 人工确认记录 |
| `design_package` | design | 方案 + 决策点 + Decision Record |
| `dev_handoff` | dev | 改动摘要 + 自验记录 |
| `review_proof` | review | 独立审核结论 + findings（带根因分类） |
| `test_proof` | test | 独立测试结果 + 验收标准映射 |
| `acceptance_package` | human acceptance | 证据汇总 + 人工验收决策 |
| `closeout_summary` | closeout | 交付清单 + 集成结果 + 保留声明 |

这七类是 #78 Formal Records 的**兼容前身**：#78 落地后，Revision/依赖链/证明失效以 #78 为权威，本节记录映射过去，不丢历史。

### 8.2 统一信封

每份记录 = 信封 + payload。信封字段：

| 字段 | 语义 |
|---|---|
| `record_type` | 七者之一 |
| `record_version` | 记录 schema 版本（当前 v0.1.5） |
| `created_at` | ISO 8601 时间 |
| `produced_by` | 产生者 Role/会话标识 |
| `run` | §7.1 portable run identity 全量内嵌 |

信封保证每份记录自带 run/workspace/source HEAD 关联（#103 要求）；`record_type` 与 `run.stage` 必须按 §8.1 的映射一一对应（如 `review_proof` 记录的 `run.stage` 必须为 `review`）。

### 8.3 payload 要素

必选/可选字段以 §8.4 schema 为准；语义要点：

- **requirements_baseline**：三要素 + **整体 `outcome`**（`baseline_ready` / `awaiting_human_input` / `revised`，§6.3 基元）+ `gaps`（缺失必须显式，不得编造）+ 澄清决策 + 状态机 `draft` → `confirmed`（`confirmed` 必须含 `baseline_revision` 与人工确认记录，且**无残留 gaps、验收标准非空、goal/scope 非空**；`draft` 不得作为下游冻结输入）；`outcome=awaiting_human_input` 必须带非空 `gaps`，`outcome=baseline_ready` 必须无残留 gaps；
- **design_package**：summary + **整体 `outcome`**（`package_ready` / `decision_required` / `requirements_issue`，§6.3 基元）+ `decision_required` 标记；门状态机两态：**命中条件门且未决 ⇒ `outcome=decision_required`**（schema 双向约束）且必须附非空 `decision_required_reasons`（§5.2），Controller 必须挂起不得放行；**人工决策记录后 ⇒ 翻转为 `package_ready`**，Decision Record 作为过门证据保留在该 package 上（schema 仅允许 Decision Record 出现在命中条件门的 package 上）；`requirements_issue` 为根因上报，由 Controller 按 §4.1 路由；
- **dev_handoff**：改动摘要 + **整体 `outcome`**（`handoff_ready` / `blocked` / `design_issue` / `requirements_issue`，§6.3 基元）+ 自验清单；`outcome=blocked` 必须附 `blocked_reason`（供 `hold(<reason>)` 路由与恢复判定）；`outcome=handoff_ready` 要求自验清单非空且无 fail/blocked 项（§3.3 完成判定）；`design_issue`/`requirements_issue` 为根因上报，由 Controller 按 §4.1 路由；
- **review_proof / test_proof**：结论 + 逐项 findings（带根因分类 dev/design/requirements，§4.1）+ `verified_branch`/`verified_head` + `independent_session=true`（不变量 2，review 与 test 同样要求）；条件约束：`request_changes`/`fail` 必须至少含一条 finding；`pass` 必须带非空且逐项全 pass 的验收映射；`blocked` 必须带 `blocked_reason`（供 `hold(<reason>)` 路由与恢复判定，§6.4）；
- **acceptance_package**：`assembled`（**五类前置记录引用**：baseline / design package / dev handoff / review proof / test proof + checkpoint 结果）+ 人工决策状态机（`awaiting_decision` → `decided`，两态字段互斥；`decided` 必含 `verified_branch`/`verified_head`；`reject` 必含 `feedback` 与 `rejection_root_cause`；AI 不得代签）。Controller 在**呈递或签收前**必须校验证据链：① 各引用记录 `record_type` 与产生 Stage 正确；② 普通 `accept` 要求 review `verdict=approve` 且 test `verdict=pass`；**`user_accepted` 例外**——允许携带 fail/blocked 证据链知情接受，但必须附 `feedback` 说明接受的差异（§3.6 特殊语义，不得伪造测试证据）；③ 全部引用同 Run / 同 workspace lineage；④ 各 Proof `verified_head` 与当前 HEAD 一致（否则按 §7.3 重跑）；⑤ 引用 baseline `status=confirmed` 且无残留 gaps；⑥ 引用 design `outcome=package_ready`（命中过条件门的必须已带 Decision Record）；⑦ 引用 dev `outcome=handoff_ready`；⑧ test `acceptance_mapping` 与引用 baseline 的验收标准逐条**完整且无重复**对应（防漏测项；`user_accepted` 场景下该项为「完整映射 + 已知差异说明」）——任一不满足即不得呈递或签收；
- **closeout_summary**：交付清单 + 集成结果（PR / merge commit 至少其一）+ **`acceptance_package_ref`（必须指向已 `decided` 的验收包）** + `acceptance_outcome`（保留 `user_accepted` 异常到收口）+ `records_retained=true`。Controller 归档前双重校验：① 引用包 `status=decided`；② 引用包 `decision` ∈ {`accept`, `user_accepted`} 且与 `acceptance_outcome` 一致——引用包 `decision=reject` 时**不得归档**，按 §3.6 打回根因路由。

### 8.4 Schema、示例与机械校验

- Schema：`docs/design/construction-workflow/handoff.schema.json`（JSON Schema draft-07）
- 示例：`docs/design/construction-workflow/examples/01…07-*.json`（七类各一；取材于本契约开发 Run 的真实场景，其中 review/test/acceptance/closeout 为 **schema 演示值**，不代表本 Run 已发生对应的独立审核、测试或人工签收记录）。示例链统一绑定到 **v0.1.1 内容完成点 HEAD（`c8d8625`）**：patch 级修订不前移示例链的 HEAD 绑定（各记录 `record_version` 随 schema 升级，但 `run.current_head`/`verified_head` 保持钉扎），仅 major/minor 语义变更时重新生成示例链
- 机械校验（可执行验证）：

```bash
npm_config_cache=.scratch/npm-cache npx --yes ajv-cli@5 validate \
  -s docs/design/construction-workflow/handoff.schema.json \
  -d "docs/design/construction-workflow/examples/*.json"
```

### 8.5 保留要求

Closeout 归档时，七类记录与全部 Proof 必须保留并可按 `run_id` 检索（对应 closeout 的 `records_retained`）；删除或清理归档记录属完整性违约，走 §4.4 升级，不作为回退。

## 9. 一致性矩阵、引用规范与冻结

### 9.1 关联 issue 一致性矩阵

| 关联 issue | 方向要点 | 契约对齐位置 | 差异说明 |
|---|---|---|---|
| #71 全局《工作流设计原则》 | 已落地：`docs/design/workflow-design-principles.md`（原则 10 人工验收业务阶段、原则 11 自动回退额度、Run Lifecycle、Node Outcome / Completion Type） | §3.6/§3.7（原则 10）；§4.2/§4.3（原则 11 同义）；§6.3/§6.4（Lifecycle `BLOCKED` 与节点业务 `blocked` 的区分、Completion 权威事实）；§8 | 无冲突：本契约是该原则在「建设」模板上的业务实例化；通用措辞以原则文档为权威，实现字段以各 Runtime issue 为权威 |
| #77 Business Outcome Routing | 技术执行与业务结果分离；Producer/Router 分离；禁止 `next_node`；Node Result 权威；额度耗尽保留原 Outcome | §6 全节；§4.3 耗尽行为（`WAITING_HUMAN + MAX_ROUNDS_REACHED`） | 兼容 shim 而非分叉：Bootstrap 期 Controller 使用 §6.3/§6.4 基元枚举驱动；#77 落地后按 §6.6 映射为正式 field path + route + `countRound`，字段名以 #77 为权威 |
| #72 受控人工决策 | Decision（方向取舍）与验收（是否通过）解耦；默认自动推进；决策包要素；Decision Record 不可覆盖；`BASELINE_UPDATED` 回基线；`USER_ACCEPTED` 不改写 baseline | §5 全节；§3.1 固定门；§3.2 条件门；§3.6 `USER_ACCEPTED` | 无冲突：本契约把 #72 框架能力实例化到建设主链固定位置（requirements 确认门 + design 条件门），不设独立 Decision 业务节点，符合「Decision 是框架能力」原则 |
| #73 自动回退额度 | 额度统一解释为自动回退额度；路径显式声明是否消耗；初次执行/内部 REVISE/WAITING_HUMAN/技术重试不计；人工触发显式记录；额度只限制自动路由 | §4.2 计数原则；§4.3 耗尽行为 | 无冲突：契约默认额度 3 来自 #102 决断；`countRound` 等字段名由 #73 实现定，契约只保留产品语义 |
| #78 Formal Records / Provenance | 正式记录版本、依赖链与证明失效 | §8 全节；§7.1 映射承诺 | 兼容前身而非平行模型：七类记录是 #78 的轻量前身；#78 落地后 Revision/依赖链/证明失效以 #78 为权威，映射迁移不丢历史 |
| #93 Workspace / Resource Isolation | Logical Run 工作区与共享资源隔离 Runtime | §7.2 `ISOLATED_WRITE`；§7.4 映射声明 | Bootstrap 先行：以 Profile 层 worktree/branch 纪律提前实现隔离语义，不等 #93 Runtime；#93 落地后强制职责移交 Runtime，`workspace_id` 映射其 workspace 标识 |

补充关联：#79（Logical Run/Snapshot）在 §7.1 有映射承诺（`run_id` → `logical_run_id`）；#102 A1–A5 为上表全部行的共同决断源。

**结论：六个关联 issue 逐项对齐，无未解释冲突。**

### 9.2 双 Profile 引用规范

1. DSH Profile（#105）与 External Profile（#104，Codex/Cursor）**只通过引用本契约获得业务语义**：Stage 语义、Role 职责、Handoff/Proof 类型、workspace/HEAD 要求、回退根因、Human Acceptance 规则；
2. 禁止任一 Profile 复制契约正文片段到自身文档后独立维护；引用允许摘要 + 指向本文件小节锚点；
3. 禁止 Profile 私有扩展业务语义：执行器差异只允许存在于调用/挂起/恢复/工具映射（Adapter 层）；认为语义不足时，走 §9.3 修订本契约，而不是在 Profile 侧先做；
4. External Profile 的 runbook（#104）是「如何把契约映射到 Codex/Cursor 工具环境」的说明，不是第二份业务定义；
5. 发现某 Profile 行为与本契约冲突时，以本契约为准裁决（§0 冲突裁决顺序）。

### 9.3 冻结与修订规则

- 本版冻结标记：**v0.1.4，2026-08-30**（#112 → #113 → #114 三工单依次落地整文档冻结后，同日按 PR #115 Review 修复升 patch 至 v0.1.4，见下方版本历史）；
- 修订必须：① 在本节追加版本历史行（版本、日期、动机、关联 issue）；② 与受影响 Runtime issue（#77/#72/#73/#78/#79/#93）重新对齐矩阵（§9.1）；③ 先改契约、后改 Profile，禁止 Profile 先行分叉；
- Runtime 字段调整纪律（继承 #103）：#77/#78/#79/#93 落地导致的字段命名调整，必须提供**新旧映射**且历史 Dogfood Run 可追溯，不丢历史；
- 冻结解除条件：仅当主链结构、人工门、额度语义任一发生变化时升 major 版本；措辞/示例修正升 patch。

版本历史：

| 版本 | 日期 | 变更 | 关联 |
|---|---|---|---|
| v0.1 | 2026-08-30 | 初版冻结：主链语义、Run/Workspace、七类交接包、一致性矩阵 | #112 #113 #114 |
| v0.1.1 | 2026-08-30 | Codex Review 修复：`blocked` 路由（`hold` → Run `BLOCKED`）、`USER_ACCEPTED` 保留到 closeout、多根因单边回退计数、schema 九处条件收紧、示例链一致性修正 | PR #115 Review |
| v0.1.2 | 2026-08-30 | Codex Review 修复（二/三）：dev/design 增加整体 `outcome` 基元与一致性双向约束、`handoff_ready` 自验非空约束、closeout 引用决策一致性规则、`record_type`↔`run.stage` 绑定、示例链 decided 修正 | PR #115 Review |
| v0.1.3 | 2026-08-30 | Codex Review 修复（四/五）：requirements 整体 `outcome` 基元与缺口条件、confirmed 分支完整性收紧（无 gaps、要素非空）、全部 `verified_*` 绑定非空约束、acceptance 证据链五项 Controller 校验 | PR #115 Review |
| v0.1.4 | 2026-08-30 | Codex Review 修复（六）：证据链校验扩展上游完成态（baseline confirmed / design package_ready / dev handoff_ready）与验收映射完整覆盖、acceptance `verified_head` 补非空（上轮尾逗号漏网）、Run identity 8 字段与签名/引用/集成标识类字段全面非空约束 | PR #115 Review |
| v0.1.5 | 2026-08-30 | Codex Review 修复（七）：design 门状态机改两态——未决 ⇒ outcome=decision_required，已决 ⇒ 翻转 package_ready 并保留 Decision Record 作过门证据（消除已决 gated package 永久无法验收的死锁）；user_accepted 例外通道——允许 fail/blocked 证据链知情接受但必须附 feedback 说明差异（§3.6 路径可达，无需伪造证据） | PR #115 Review |

### 9.4 #103 九条验收清单证据映射

| #103 验收标准 | 证据小节 |
|---|---|
| 一份共享 Portable Contract 完整覆盖建设主链 | §2（主链与不变量）+ §3（七 Stage） |
| 明确各 Stage 输入、专业输出、Proof、回退来源 | §3.1–3.7（每节四要素） |
| 明确 Human Acceptance 与 Human Decision 边界 | §5.1–5.4 |
| 明确 worktree/branch/HEAD/Integration Checkpoint | §7.2、§7.3 |
| 明确 Dogfood portable run identity | §7.1 |
| 明确七类交接/证据包 | §8.1–8.5 |
| 与 #71、#77、#72、#73、#78、#93 无产品语义冲突 | §9.1（逐项矩阵，无未解释冲突） |
| DSH/External Profile 只引用本 Contract，不复制语义 | §0 纪律 + §9.2 |
| #105 可直接消费，不重新定义语义 | §9.5 |

### 9.5 #105 可消费性核验

#105「DSH Dogfood 验收」11 项逐项对应契约小节：

| # | #105 验收项 | 契约小节 |
|---|---|---|
| 1 | Requirements baseline + 人确认 | §3.1 + §5.1（固定门） |
| 2 | Design | §3.2 |
| 3 | Dev 在独立 worktree | §3.3 + §7.2 |
| 4 | Review 独立验证 | §3.4 + §2 不变量 2 |
| 5 | Test 独立验证 | §3.5 |
| 6 | Human Acceptance | §3.6 |
| 7 | Closeout | §3.7 |
| 8 | 至少 1 条业务打回路径 | §4.1 + §4.2（review/test 回退消耗额度） |
| 9 | branch/HEAD Proof | §7.3 + §8.3 |
| 10 | Integration Checkpoint | §7.3 + §8.3（`assembled.integration_checkpoint`） |
| 11 | 最终 PR/merge 按仓库规则执行 | §3.7（Closeout 交付集成）+ §7.3 |

**结论：#105 可直接引用本契约执行 Bootstrap Run，无需重新定义建设工作流语义。**
