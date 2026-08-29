# 工作流设计原则

> 定位：Workflow Manager 的长期方法论权威。后续新增或调整内置角色、内置模板、Blueprint 能力与 Runtime 语义时，应引用本文，而不是在单个 Issue 里重新发明原则。
>
> 需求源：[issue #71](https://github.com/crystepj-max/workflow-manager/issues/71)
>
> 与 v0.1 产品规格的关系：本文回答 **为什么这样设计、以后如何继续设计**。v0.1 的具体角色清单、四套流程实例、Lifecycle 枚举落地与实施依赖，见 [PR #84](https://github.com/crystepj-max/workflow-manager/pull/84) 的 `docs/design/workflow-manager-v0.1-final-product-spec.md`（合入 `main` 前以该 PR 为准）。规格中的原则摘要应回指本文；本文引用规格中的已决实例，不把实施清单复制成第二份规格。
>
> Current vs Target：`CONTEXT.md` 与旧「开发工作流 2.0」文档描述 **当前 main 的兼容实现**。在对应能力进入 `main` 之前，不得把 Target 语义写进 Current 文档。实现合入后必须同步 Current 文档，避免两套口径静默并存。

## 1. 文档定位与适用范围

本文约束：

- 正式 Built-in Workflow 与 Built-in Role 的设计；
- Blueprint / 节点 / 边 / 交接 / 证明链的产品语义；
- Human Decision、自动回退额度、Run Lifecycle、Completion Type 等框架级交互与结果模型的设计口径；
- 历史试验资产升级为正式标准，或降级为用户资产时的迁移原则。

本文不替代：

- 具体 Blueprint 字段与校验规则（见 `docs/design/blueprint-schema.md` 与后续契约 Issue）；
- 某一版本的实施拆解与发布门槛（见 v0.1 产品规格与 [#76](https://github.com/crystepj-max/workflow-manager/issues/76)）；
- 运行时、编译器、UI 的实现方案（由 [#72](https://github.com/crystepj-max/workflow-manager/issues/72)、[#73](https://github.com/crystepj-max/workflow-manager/issues/73)、[#77](https://github.com/crystepj-max/workflow-manager/issues/77)–[#83](https://github.com/crystepj-max/workflow-manager/issues/83) 等能力 Issue 承接）。

适用范围：产品设计、模板作者、角色作者、Blueprint 契约与 Runtime 设计。用户可见的正式文档遵循第 8 节的中英文分层；机器结构遵循英文稳定枚举。

## 2. 全局工作流设计原则

下列 18 条是跨模板、跨版本应持续遵守的原则。编号用于引用（例如「见原则 11」），不表示优先级。

### 原则 1 — 角色能力化，节点场景化

Role 定义长期稳定、可复用的能力本质。Node 定义该角色在当前工作流、当前任务中的目标、输入、约束、检查重点和完成条件。

仅因场景不同，不新增高度重复角色。例如不应分别创建「功能开发 / Bug 修复 / 快速开发」或「功能测试 / 回归测试」；应复用 `dev` / `test` / `review` / `evaluator` 等基础能力，由节点赋予场景化职责。

只有所需能力本质不同、无法由现有角色通过节点约束合理表达时，才新增内置角色。判断标准见第 10 节。

### 原则 2 — 执行与独立证明分离

不让同一个执行者同时承担最终证明自己正确的责任。执行者可以自检，但不能成为自己成果的唯一最终证明者。

按问题类型使用独立 Review、Test、Evaluator 或 Human Acceptance。独立证明的具体形态由模板决定，不是所有模板都必须堆齐全部质量节点。

### 原则 3 — Node 报告专业结果，Blueprint 决定流向

Node 只产出专业结果，不输出 `next_node`，也不应知道工作流拓扑。

Node 返回结构化专业结果；Blueprint 将 Business Outcome 映射到下一节点、回退、Human Decision 或 END。框架能力由 [#77](https://github.com/crystepj-max/workflow-manager/issues/77) 承接。

这是 R1 / R2 的正式表述。

### 原则 4 — 技术执行结果与业务结果分离

Agent 正常完成一次调用并返回合法 Schema，不代表业务结果必须 PASS。

`OPTIMIZE` / `CONFIRM` / `NEEDS_RESEARCH` / `INSUFFICIENT` / `REQUEST_CHANGES` 等都是合法业务结果，不能为了迁就二态路由而伪装成技术 failure。

### 原则 5 — 问题返回真正根因来源

失败不是工作流终点。质量节点发现问题后，应携带明确反馈返回能够真正消除根因的最近上游，而不是机械地全部打回「开发」。

典型映射：

| 问题性质 | 返回 |
|---|---|
| 实现问题 | `dev` / execute / repair |
| 方案问题 | `designer` |
| 需求或基线问题 | `requirements` / 目标确认 |
| 根因判断问题 | `diagnose` |
| 研究覆盖问题 | `orchestrator` |

修订后必须重新经过所有因本次变化而失效的下游质量节点。失效范围按原则 7 的真实依赖判断。

### 原则 6 — 正式记录不可覆盖，变化产生 Revision

Formal Record 的正式输入、成果、证明都使用不可覆盖 Revision。新变化产生新版本，旧版本保留历史事实。

实施时优先「快照 / 记录修订」，禁止无痕覆盖。框架能力由 [#78](https://github.com/crystepj-max/workflow-manager/issues/78) 承接。这是 R3 的正式表述。

### 原则 7 — Proof 绑定具体版本，失效按依赖判断

Proof 必须能说明自己证明的是哪些具体输入 / 成果 Revision。

上游发生实质变化后：旧 Proof 不删除，也不是历史上「错误」；但如果它依赖旧版本，就不再能证明当前版本。

失效按真实依赖判断，不机械重跑或删除所有下游。例如探索增加 Targeted 专家证据时，原专家观点保留，仅重新生成依赖该证据集合的 Synthesis / Evaluation。

这是 R4 / R5 的正式表述。

### 原则 8 — 不确定性是一等信息

未知、推断、证据不足、不可稳定复现、观察中等必须显式表达。不得为了推进流程把不确定结论包装成确定事实。

工作流可以在明确记录剩余不确定性的前提下继续推进、受控结束或进入后续跟踪。`INSUFFICIENT` 可以是合法 Completion，而不是失败，也不是伪装成失败。

### 原则 9 — Human Decision 是框架能力，不是通用角色

Human Decision 用于系统不能代替用户完成的重大取舍、风险接受、最终签字或自动回退额度耗尽。它不是通用业务角色，也不是每个模板都必须出现的固定业务节点。

统一口径：

- 与节点的自动 / 人工验收方式解耦；
- 自动节点只有命中明确声明的条件时才升级人工，不得随意打扰用户；
- 必须提供完整决策上下文、候选方案、成本、收益、风险、影响及推荐理由；
- 用户的结构化选择应决定后续流向并持久化为 Decision Record；
- Human Decision 本身不等于修改业务 Baseline；若用户改变目标、范围或硬要求，应返回负责基线的业务节点产生新 Revision。

框架能力由 [#72](https://github.com/crystepj-max/workflow-manager/issues/72) 承接。

### 原则 10 — Human Acceptance 是业务阶段，只在需要的模板出现

Human Acceptance 是正式业务阶段（人最终签字），不是框架默认节点。例如「建设」具有强制人工最终业务验收；「优化 / 诊断 / 探索」按风险与模板定义决定是否出现等价的人工确认，不得为了形式一致而给所有模板增加同一个验收节点。

### 原则 11 — `maxRounds` = 自动回退额度

`maxRounds` 不表示「所有失败、重试、等待和重新确认的总次数」，而表示系统允许自动跨节点返回上游、重新产生成果的业务回退额度。

统一语义：

- 初次执行不计；
- 只有声明为业务自动回退的跨节点路径，按边级 `countRound` 决定是否消耗；
- 节点内部 REVISE 不计；
- `WAITING_HUMAN` / `PAUSED` / `BLOCKED` 不计；
- 技术失败重试不得因为使用了回退路径就自动消耗业务额度；
- 额度耗尽进入 `WAITING_HUMAN` 且 reason 为 `MAX_ROUNDS_REACHED`，**不是** `FAILED_MAX_ROUNDS`。系统必须展示完整上下文、历史尝试、剩余问题、风险、成本 / 收益和可选方向。

边级是否计数由 [#73](https://github.com/crystepj-max/workflow-manager/issues/73) 承接。

探索模板的特殊映射已锁定：总研究轮次最多 3 轮（含首次 BROAD），因此最多 2 次 `NEEDS_RESEARCH -> orchestrate` 自动回退。

### 原则 12 — Workflow Lifecycle、Node Outcome、Completion Type 三层分离

三者不得压进单一 status 字符串。

1. **Workflow Lifecycle**：整个 Logical Run 的运行状态，由框架固定，见第 3 节。
2. **Node Business Outcome**：节点自己的专业判断和路由依据，可由模板或自定义工作流定义。
3. **Completion Type**：说明一个 `COMPLETED` Run 以什么业务原因完成；权威事实来自终态节点的结构化产出，Run 层只镜像摘要。

自定义工作流允许配置结果字段路径与完成字段映射。框架能力由 [#77](https://github.com/crystepj-max/workflow-manager/issues/77) 承接。

### 原则 13 — Run 启动时冻结 Snapshot

每个 Logical Run 启动时冻结 Workflow、Role、Provider / Model 和关键运行配置，生成本 Run 可追溯 Snapshot。

v0.1 运行中只允许修改 Provider / Model，并生成 Snapshot Revision；只影响当前 Run，不反向修改来源工作流或其他 Run。保存到角色库 / 模板库的后续修改只影响未来 Run。

为保证审计性，实施应采用「快照修订」而不是无痕覆盖，并记录每次节点执行实际使用的快照 / 模型版本。这是 R6 的正式表述。Runtime 由 [#79](https://github.com/crystepj-max/workflow-manager/issues/79) 承接。

### 原则 14 — Guidance、Baseline Change、Control / Decision 分离

运行中用户纠偏分三类，不得混用：

- **Guidance**：补充上下文、纠正执行方向，不改变正式 Baseline；形成 Guidance Record。
- **Baseline Change**：改变目标 / 范围 / 硬要求，必须回基线节点产生正式 Revision，并按原则 7 重新判断下游证明。
- **Control / Decision**：Pause、Resume、停止、接受、追加回退额度等运行控制或人工决策。

`PAUSED` 可用于用户主动补充上下文和纠偏。框架能力由 [#80](https://github.com/crystepj-max/workflow-manager/issues/80) 承接。

### 原则 15 — 收口是质量循环终点，收口与事项关闭分离

进入收口意味着当前工作流的业务质量循环已经结束。所有返工、重新确认、重新审核、重新测试和重新评估必须发生在收口之前。

收口只负责整理事实、形成最终记录、完成交付和保留遗留事项，不得产生未经重新验证的新正式成果。收口过程中发现的新问题、风险或优化机会应如实记录，并建议新建独立任务，而不是重新打开当前工作流。

「收口」与「关闭」不是同一概念：

- 收口：当前这一轮 Workflow Run 的质量循环已经完成；
- 关闭：该事项以后是否仍需长期跟踪。

**持续观察不是 Workflow Run Lifecycle，也不是 Agent 节点。** 工作流可以以 Completion Type / 后续跟踪信息表达「已完成 · 观察中」；当前 Logical Run 已完成，观察期复发应创建新的缺陷 Run，而不是重新打开旧 Run。最终观察期限和事项关闭时机由人决定。

不是所有模板都必须为了形式一致而增加独立收口 Agent；但所有模板都必须遵守统一的完成 / 终止协议，以及「完成后不再产生未经验证的新成果」。

### 原则 16 — 公共系统元数据 + 专业业务 Schema

框架统一记录 logical run、node、attempt、snapshot revision、依赖 Record、实际 provider / model、裁决、证据、风险、不确定性、未解决事项、已发生的重要人工决定、后续流向及理由等公共交接元数据。

节点 Output Schema 保留自己的专业业务结构。不同模板不应被强行压缩成一份包含大量空字段的超级 Schema。

四类专业业务包的典型内容见第 8 节。

### 原则 17 — 机器结构英文，正式用户文档中文

机器结构使用英文，稳定、便于校验、路由和兼容；正式文档使用中文，便于用户理解、确认和追溯。

- JSON Schema 字段、枚举、路由条件、机器状态使用稳定英文；
- 需求基线、方案报告、执行报告、审核报告、测试报告、诊断报告、研究报告、决策说明、收口报告等正式用户产物使用中文；
- 不依赖解析 Markdown 文本完成机器路由。

### 原则 18 — Built-in 只代表当前正式标准

正式发布后的「内置工作流 / 内置角色」代表系统当前推荐和维护的标准，不应长期保留已被新标准取代的试验资产占据内置身份。

已确认的本轮迁移口径：

- `default-workflow` / `dev-workflow-2-0` 在正式四套模板落地时转为 Custom Workflow，不再作为系统内置模板；
- 当前已有内置角色若与新的正式基础角色能力相同，则由新的正式角色替换 / 升级；
- `dispatcher` 转为 Custom Role，不再占据正式内置身份；
- 迁移应尽量保留用户既有引用、Skill 触发兼容和历史运行可追溯性，不因「正式化」直接丢失旧资产。

Built-in Workflow 结构只读；用户可以持久覆盖 Provider / Model。修改 Node、Edge、Role、Goal、Schema、Outcome Routing、Human Decision、回退规则或 Topology 时，必须基于该模板创建 Custom Workflow。由 [#82](https://github.com/crystepj-max/workflow-manager/issues/82) 承接。

## 3. 生命周期、节点裁决与完成类型

### 3.1 Logical Run 与 Execution Segment

一个 Logical Run 代表用户从开始到结束的一次完整任务，不等同于底层引擎的一次 `start()`。人工等待、暂停、阻塞、模型切换和恢复仍属于同一个用户级 Run。底层执行片段是 Execution Segment。由 [#79](https://github.com/crystepj-max/workflow-manager/issues/79) 承接。

Invocation 与 Runtime 分离：当前 Skill / Chat 仍是正式运行入口；未来插件侧入口若增加，只能作为新的 Invocation Adapter，共享同一 Logical Run Runtime，不得形成第二套运行体系。由 [#83](https://github.com/crystepj-max/workflow-manager/issues/83) 承接。

### 3.2 固定 Run Lifecycle

框架固定以下状态，不开放自定义：

`READY` / `RUNNING` / `WAITING_HUMAN` / `PAUSED` / `BLOCKED` / `COMPLETED` / `STOPPED` / `FAILED`

仅 `COMPLETED` / `STOPPED` / `FAILED` 为终态。

口径：

- 可恢复的外部 / 技术条件问题进入 `BLOCKED`（例如 Provider 额度、模型不可用、鉴权失效、测试环境不可用）；
- 不可安全恢复的运行完整性错误才进入 `FAILED`（例如状态损坏、必要 checkpoint 无法恢复）；
- 达到自动回退额度进入 `WAITING_HUMAN`（`MAX_ROUNDS_REACHED`），不是 `FAILED`；
- `OBSERVING` 不是 Lifecycle 值。

### 3.3 Node Business Outcome

节点允许定义自己的专业语义，例如：

- `PASS` / `OPTIMIZE` / `CONFIRM`
- `PASS` / `NEEDS_RESEARCH` / `INSUFFICIENT`
- `APPROVE` / `REQUEST_CHANGES`
- `READY` / `BLOCKED`（此处 `BLOCKED` 是节点业务结果，不是 Run Lifecycle）

这些是节点业务结果和路由依据，不应被直接当成整个工作流的生命周期状态。框架可提供常用 Outcome Preset，但不能把字段硬编码为单一 `outcome`。

### 3.4 Completion Type

用于说明工作流为什么完成或以何种业务结论完成，例如评估通过、用户接受、证据不足、已完成 · 观察中等。机器事实来自结构化节点产出，并在正式中文报告中可追溯表达。Run 层镜像摘要用于搜索 / 筛选 / 看板。

## 4. 角色与节点设计原则

角色是能力，节点是场景。同一基础角色可以绑定到多个工作流中的不同节点，例如：

- `dev` 可用于建设中的「开发」、优化中的「执行」、诊断中的「修复」；
- `review` 可用于建设与诊断中的不同审核节点；
- `test` 可用于建设中的「测试」与诊断中的「回归验证」；
- `evaluator` 的评价维度由节点级评价契约定义，优化「评估」与探索「结论评估」能力同类、契约不同；
- `closeout` 负责需要显式收口 Agent 的工作流最终整理与交付，具体内容由节点决定。

节点负责表达：当前任务目标、输入、约束、重点检查项、完成标准、专业 Output Schema。节点不得承担「我决定下一个谁上场」。

v0.1 的 12 个正式 Built-in Role 名单与绑定实例见产品规格与 [#81](https://github.com/crystepj-max/workflow-manager/issues/81)，本文不把该名单当作跨版本封闭枚举。

## 5. 质量控制、失败回路与自动回退额度

质量控制遵循：

1. 执行与独立证明分离（原则 2）；
2. 失败返回真正根因来源（原则 5）；
3. 上游正式变化使依赖它的证明 stale（原则 7）；
4. 自动回退有额度，超限转人工（原则 11）。

失败回路不是「无限重试直到碰巧通过」，也不是「任何失败都算一轮」。只有 Blueprint 声明为业务自动回退的跨节点路径，才按 `countRound` 消耗 `maxRounds`。

达到额度后停止无人值守自动循环，转 Human Decision，由人选择追加额度、接受当前结果、缩小范围、停止或新建任务。

## 6. 基线、版本与证明失效规则

被后续结果依赖的正式上游基线、方案、诊断结论、成果或研究证据发生实质变化时，所有依赖旧版本形成的下游质量证明自动失效（stale），但作为历史事实保留。

典型情况：

- 需求基线变化 → 方案及后续实现 / 审核 / 测试 / 验收需要重新产生或重新证明；
- 方案变化 → 开发及后续质量证明失效；
- 实现变化 → 审核、测试、人工验收证明失效；
- 缺陷根因被新证据推翻 → 原修复及其审核 / 回归证明失效；
- 探索获得新的关键证据 → 必须重新综合并重新评估，不能直接沿用旧结论。

核心：最终证明必须对应当前真实输入和当前真实成果，而不是历史版本。

每次 Logical Run 另有独立 Snapshot（原则 13），与 Formal Record Revision 互补：Snapshot 冻结「这次用什么定义跑」；Revision 记录「业务对象变成了哪个版本」。

## 7. 不确定性、风险与 Human Decision

不确定性本身不是失败。无法确认的内容必须显式标记为未知、推测、待验证、证据不足、不可稳定复现或观察中。

风险处理：

- 低风险且已声明剩余不确定性：可以受控完成；
- 需要用户价值判断、风险接受或最终业务签字：升级 Human Decision 或 Human Acceptance（原则 9、10）；
- 证据不足且不可复现、无法安全给出根因：节点可给出 `BLOCKED` 等专业结果，由 Blueprint 映射为等待补充信息或受控结束，而不是猜一个确定结论。

Human Decision 必须带齐决策上下文；用户选择必须结构化、可路由、可追溯。Guidance 不得偷偷变成 Baseline Change。

持续观察的口径见原则 15：它是完成类型 / 后续事项，不是 Lifecycle，也不是 Agent 节点。

## 8. 节点交接协议与中英文机器 / 文档分层

### 8.1 公共交接头 + 专业业务包

跨模板统一公共语义，至少覆盖：

- 当前任务 / 目标；
- 当前依据版本；
- 节点裁决或结果；
- 证据；
- 风险；
- 不确定性；
- 未解决事项；
- 已发生的重要人工决定；
- 后续流向及理由（由 Blueprint 解释结果后写入系统元数据，不是由节点指定下一节点）。

同时保留各模板专业业务包：

| 模式 | 专业业务包（示例） |
|---|---|
| 建设 | 需求基线 / 方案基线 / 实现 / 审核 / 测试 / 验收 |
| 优化 | 评估契约 / 执行结果 / 独立评估 |
| 诊断 | 诊断包 / 原始反馈信号 / 根因证据 / 回归结果 |
| 探索 | 专家任务书 / 独立观点卡 / 综合观点地图 / 结论评估 |

多格式正式产物建立在 Formal Record 模型之上，由 [#69](https://github.com/crystepj-max/workflow-manager/issues/69) 承接。

### 8.2 中英文分层

见原则 17。机器路由只读结构化英文字段；中文报告供人确认与追溯，不是解析源。

## 9. 四套内置模板产品原则

四套正式 Built-in Workflow 代表四种解决问题机制，不是「复杂度四档」。用户选择模板的核心问题是「我现在面对哪一种问题」。具体节点序列与默认额度数值以产品规格和 [#82](https://github.com/crystepj-max/workflow-manager/issues/82) 为准；本节只定方法论。

### 9.1 建设：完整功能开发

适用于正式、完整或较高风险的功能建设。

- 定义阶段与交付阶段分离；先有正式需求基线和方案基线，再进入实现；
- 质量链为开发 → 独立审核 → 独立测试（顺序固定，证明互相独立）；
- 实现 / 方案 / 需求问题分别返回真正上游；
- 强制人工最终业务验收；验收通过后成果冻结；
- 上游正式变化按依赖使证明 stale；
- 自动回退额度默认受控，超限转人工。

### 9.2 优化：快速迭代

适用于目标基本明确的小型优化、文档 / 配置 / Prompt 等快速修改。方法：Evaluator–Optimizer。

- 目标确认 → 执行 → 独立评估 → 收口；
- 前置冻结评价基线（evaluation contract），后置有限优化循环；
- 已满足部分尽量保持不动，返工采用定点优化；
- Evaluator 输出 `PASS` / `OPTIMIZE` / `CONFIRM`；`OPTIMIZE` 回执行消耗自动回退额度；
- 验证是一种能力，不强制增加独立 Test 节点；
- Human Decision 只在真正需要用户取舍（如 `CONFIRM` 或额度耗尽）时触发。

### 9.3 诊断：缺陷修复

适用于先建立根因证据，再修复和回归。方法：Evidence-driven Debugging。

- 先诊断、后修复；
- 原始反馈信号贯穿诊断、修复和回归；
- 根因必须有证据，修复必须针对根因；
- 证据不足且不可复现时不得猜根因；
- 不可稳定复现但证据充分时允许受控高可信路径，同时保留不确定性；
- 不确定性必须贯穿修复、审核、回归和收口；
- 审核 / 回归发现修复问题回修复，证据推翻根因回诊断；修改后必须重新审核和回归；
- 默认不因形式一致而增加独立人工验收；高风险条件式人工确认由 Human Decision 承载；
- **持续观察不是 Lifecycle，也不是 Agent 节点。** 缺陷可以 `COMPLETED`，并以完成类型 / 后续事项表达「已完成 · 观察中」；观察期复发创建新的缺陷 Run。

诊断模板的默认自动回退额度数值若规格仍未锁定，实施前单独确认；本文不提前写死。

### 9.4 探索：多视角探索

适用于复杂开放问题，多视角独立研究后综合与评估。方法：Orchestrator–Workers + Synthesis + Evaluation。

- 动态设计互补认知视角，不是拆报告章节；
- 第一轮专家保持上下文独立；
- 综合分析必须形成共识、分歧、假设和证据地图，禁止简单多数投票；
- 证据不足允许 `INSUFFICIENT` 合法结束；
- 第一轮宽探索（BROAD），后续只做 TARGETED 定点补充研究；
- 探索统筹、专家研究、综合分析、结论评估职责分离；
- 新证据必须重新综合和评估，不机械重跑全部专家；
- **总研究轮次最多 3 轮，包含首次 BROAD**；自动 TARGETED 补充最多 2 轮。不得理解为「首次 + 3 次补充」。

## 10. 内置角色设计原则

基础角色优先复用。新增内置角色前应至少确认：

1. 是否存在现有角色能够完成这类能力；
2. 差异是否只是输入、目标、检查重点或完成标准不同；
3. 是否可以通过节点附加职责表达差异；
4. 新角色是否具备跨多个场景长期复用的价值，或是否确实属于不可泛化的专业能力。

只有当答案表明存在真正新的能力类型时，才应新增内置角色。

探索场景用 `researcher` + 动态专家任务书生成运行期专家，不创建永久 Expert A / B / C / D 内置角色。

`review` 与 `evaluator` 保持不同能力：前者面向规范 / 需求符合性与质量审查，后者面向显式评价契约下的独立评估。

收口角色约束见第 11 节。正式 12 角色落地见 [#81](https://github.com/crystepj-max/workflow-manager/issues/81)。

## 11. 收口、观察与关闭原则

收口角色：

- 不重新审核；
- 不重新测试；
- 不重新验收；
- 不修改正式成果；
- 不触发返工；
- 不替用户接受风险；
- 发现新问题只记录并建议新建任务。

观察与关闭：

- 观察不是让 Run 长期停在非终态；
- 「已完成 · 观察中」是 Completion Type / 后续事项；
- 事项是否最终关闭由人决定；
- 观察期复发 = 新 Run。

## 12. 内置资产升级 / 迁移原则

正式化时：

1. 只保留当前正式标准为 Built-in；
2. 被取代的试验工作流转为 Custom Workflow；
3. 被取代或不在新体系内的角色转为 Custom Role，或由同能力正式角色升级替换；
4. 迁移必须保留引用、Skill 兼容和历史可追溯性；
5. Built-in 允许用户级 Provider / Model Override，不允许原地改结构；
6. 不得整包把未按新原则重做的旧分支 / 旧 PR 当作正式实现合入。

历史 Issue #64–#68 已 superseded，不再作为活动实施依赖。

## 13. 后续新增模板 / 角色应遵守的检查清单

新增或调整 **内置角色** 前：

- [ ] 已用第 10 节四问证明存在新的能力类型，而不是新的场景措辞；
- [ ] 已说明与现有角色的能力边界，避免与 `dev` / `review` / `test` / `evaluator` 等基础角色重叠；
- [ ] 已定义该角色可复用的多个场景，或证明其不可泛化的专业性；
- [ ] 节点职责、输入输出和非目标由节点表达，而不是复制一套近义角色。

新增或调整 **内置模板** 前：

- [ ] 已说明它解决的是哪一种问题机制，而不是「比现有模板更复杂 / 更简单」；
- [ ] 节点只报告专业结果，路由留给 Blueprint；
- [ ] 技术成功与业务 Outcome 分离，不把非 PASS 伪装成 failure；
- [ ] 失败返回真正根因来源，并声明哪些回退边 `countRound`；
- [ ] 证明绑定版本，上游变化按依赖失效；
- [ ] 不确定性可显式表达，允许合法的非 PASS 完成类型；
- [ ] Human Decision / Human Acceptance 只在真正需要时出现；
- [ ] 收口（若有）遵守终点约束；无独立收口 Agent 时仍遵守完成协议；
- [ ] 机器结构英文、正式文档中文；公共交接头 + 专业业务包，无超级 Schema；
- [ ] 不把观察做成 Lifecycle 或 Agent 节点；
- [ ] 本文已被引用，Issue 正文不再重写上述原则，只记录本模板的增量决策。

新增 **框架能力** 前：

- [ ] 确认它是框架级能力还是某一模板的业务节点；
- [ ] 确认 Invocation 适配器不会长出第二套 Runtime；
- [ ] 确认与 Lifecycle / Outcome / Completion 三层模型兼容。

## 实现类能力归属

| 主题 | 原则 | 承接 Issue |
|---|---|---|
| Human Decision | 9 | #72 |
| 边级 `countRound` / 自动回退额度 | 11 | #73 |
| Preflight Probe | 13（快照模型可用性） | #74 |
| Business Outcome Routing / Completion Mapping | 3、4、12 | #77 |
| Formal Records / Provenance | 6、7 | #78 |
| Logical Run / Snapshot / Lifecycle | 12、13 | #79 |
| Pause / Guidance / Resume | 14 | #80 |
| 12 个正式 Built-in Role | 1、10、18 | #81 |
| 四套正式 Built-in Workflow / Model Override | 9、18 | #82 |
| Invocation Adapter | 3.1 | #83 |
| 多格式正式 Artifact | 8 | #69 |
| 实施总览 | — | #76 |
| v0.1 产品规格 | — | PR #84 |
