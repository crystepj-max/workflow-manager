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

长期资产分为：

- Workflow：Built-in / Custom；
- Role：Built-in / Custom。

Built-in 是系统当前维护的正式标准。被新标准替代的历史试验资产迁移为 Custom，不继续占据 Built-in 身份。

### 2.2 Workflow Blueprint

Blueprint 定义工作流如何运行，至少包括：

- nodes / edges；
- role bindings；
- provider / model bindings；
- node goals；
- input / output schema；
- Business Outcome Routing；
- Completion Mapping；
- Human Decision rules；
- automatic rollback budget；
- fan-out / aggregation；
- formal artifact declarations。

核心规则：**节点只报告专业结果，Blueprint 负责解释结果和决定流向。** 节点不得通过 `next_node` 等字段耦合工作流拓扑。

### 2.3 Invocation / Skill

当前正式入口仍以 Skill / Chat 为核心：Workflow 保存后生成或更新 Skill，用户在会话中调用 Skill 或通过触发词加载工作流。

未来插件侧若增加“使用此工作流 / 运行”等入口，只能作为新的 Invocation Adapter，最终进入同一个 Logical Run Runtime，不能形成第二套运行体系。

### 2.4 Logical Workflow Run

一个 Logical Run 代表用户从开始到结束的一次完整任务，不等同于底层 Workflow Engine 的一次 `start()`。

同一 Run 可以包含多个 Execution Segment，以及 WAITING_HUMAN、PAUSED、BLOCKED、Snapshot Revision、Guidance、Decision 等事件。

### 2.5 Run Snapshot

每次 Run 启动时生成独立 Snapshot，冻结本次运行使用的 Workflow、Role、Provider/Model 等关键定义。

v0.1 运行中只允许修改：

- Provider；
- Model。

修改产生新的 Snapshot Revision，不无痕覆盖；只影响当前 Run，不修改来源 Workflow，也不影响其他 Run。

Role / Goal / Schema / Routing / Node / Edge / Topology 等运行中修改暂不开放，后续完成影响分析能力后再评估。

### 2.6 Run Lifecycle

框架固定以下状态，不开放自定义：

- `READY`
- `RUNNING`
- `WAITING_HUMAN`
- `PAUSED`
- `BLOCKED`
- `COMPLETED`
- `STOPPED`
- `FAILED`

仅 `COMPLETED / STOPPED / FAILED` 为终态。

### 2.7 Formal Records / Provenance

正式记录统一抽象为三类语义：

- 输入 / 基准：需求基线、评估契约、诊断结论、研究任务书等；
- 成果：代码、文档、修复、专家观点、综合报告等；
- 证明：Review、Test、Evaluator、Human Acceptance / Decision 等。

Formal Record 不覆盖修改；变化产生 Revision。每个正式结果记录自己依赖的输入/成果版本。

旧记录保留历史事实，但依赖旧版本的证明不再能证明当前版本。

## 3. Workflow 三层结果模型

### 3.1 Workflow Lifecycle

表示整个 Logical Run 的运行状态，仅由框架定义。

### 3.2 Node Business Outcome

表示节点自己的专业判断和路由依据，可由模板或自定义工作流定义。例如：

- `PASS / OPTIMIZE / CONFIRM`
- `PASS / NEEDS_RESEARCH / INSUFFICIENT`
- `APPROVE / REQUEST_CHANGES`

框架可提供常用 Outcome Preset，但不能把字段硬编码为 `outcome`。自定义工作流可配置自己的结果字段路径和枚举。

技术执行成功与业务 Outcome 必须分离：Agent 正常返回合法结构化结果，不代表业务结果必须 PASS。

### 3.3 Completion Type

表示一个 `COMPLETED` Run 以什么业务原因完成，例如：

- `EVALUATION_PASSED`
- `USER_ACCEPTED`
- `INSUFFICIENT`
- `DELIVERED`
- `COMPLETED_OBSERVING`
- `NO_FIX_NEEDED`

权威事实来自终态节点结构化产出；Run 层镜像摘要用于搜索/筛选/看板；正式中文报告提供用户可读表达。

## 4. 全局设计原则 R1–R6 与扩展规则

1. **R1**：Node 报告专业结果，不报告 next node；
2. **R2**：Blueprint 把业务结果映射为路由；
3. **R3**：正式记录采用不可覆盖 Revision；
4. **R4**：Proof 绑定具体输入/成果 Revision；旧 Proof 保留，但对新版本变为 stale；
5. **R5**：失效按真实依赖判断，不机械重跑全部下游；
6. **R6**：每次 Workflow Run 冻结 Workflow / Role /关键配置快照；v0.1 当前 Run 只允许 Provider/Model Snapshot Revision。

同时遵循：

- 角色能力与节点场景分离；
- 执行与独立证明分离；
- 问题返回真正根因来源；
- 不确定性是一等信息，`INSUFFICIENT` 可合法完成；
- Human Decision 是框架能力，不是通用角色；
- `maxRounds` = 自动回退额度，不是失败/重试总次数；
- 机器结构英文，正式用户文档中文；
- 系统记录公共交接元数据，节点保留专业业务 Schema，不建立超级 JSON；
- 收口是质量循环终点，不重新做开发/审核/测试/评估；
- 收口与事项关闭分离；观察和后续跟踪不要求 Run 长期运行；
- Invocation 与 Runtime 分离。

## 5. 生命周期与异常路径

### 5.1 WAITING_HUMAN

用于系统已经知道需要人做什么决定的场景，例如：

- 需求基线确认；
- 最终验收；
- Evaluator `CONFIRM`；
- 达到自动回退额度。

达到自动回退额度后进入：

`WAITING_HUMAN + reason=MAX_ROUNDS_REACHED`

而不是 `FAILED_MAX_ROUNDS`。系统必须展示完整上下文、历史尝试、剩余问题、风险、成本/收益和可选方向。

### 5.2 PAUSED

当前可以继续，但用户主动暂停。

支持：

- **Safe Pause**：当前 Node Attempt 到安全点后暂停；
- **Interrupt**：立即中断当前 Node Attempt，该 Attempt 标记 `INTERRUPTED`，不产生正式 PASS 结果。

### 5.3 Run Guidance

暂停期间用户可补充上下文、指出理解错误、纠正方向，并进行必要的多轮沟通。

沟通结果形成 Guidance Record，恢复后的 Node Attempt 读取该指导。

必须区分：

- execution guidance：不改变正式基线；
- baseline change：改变目标/范围/硬要求时，必须返回负责基线的业务节点，生成正式 Revision，并重新判断下游证明有效性。

### 5.4 BLOCKED

系统希望继续，但必要外部条件不存在，例如 Provider quota、模型不可用、鉴权失效、测试环境不可用。

推荐恢复路径：

`BLOCKED -> 修改当前 Run 的 Provider/Model -> Snapshot Revision -> Probe -> Resume`

### 5.5 FAILED

只用于无法安全恢复的框架/运行完整性异常，例如状态损坏、必要 checkpoint 无法恢复、框架无法解释的非法运行态。

### 5.6 OBSERVING

`OBSERVING` 不是 Workflow Lifecycle，也不是 Agent 节点。

缺陷可在 `COMPLETED` 后通过 Completion Type / 后续事项显示“已完成 · 观察中”；观察期复发创建新的缺陷 Run，不重新打开旧 Run。

## 6. Snapshot、Built-in Override 与模型可用性

### 6.1 Built-in Workflow Model Override

Built-in Workflow 的结构只读，但允许用户持久设置自己的 Provider / Model Override：

`Built-in Workflow + User Model Override -> Effective Workflow -> Run Snapshot`

修改 Node、Edge、Role、Goal、Schema、Outcome、Human Decision、回退规则或 Topology 时，必须“基于此模板创建自定义工作流”。

### 6.2 Backup Provider

v0.1 不增加自动 Backup Provider / Failover Policy。

模型不可用时由用户显式修改当前 Run Snapshot 的 Provider/Model，再 Probe、Resume。未来可增加推荐替代模型，但不静默自动切换 Provider。

### 6.3 Preflight Probe

验证分两层：

1. Static Validation：蓝图是否合法；
2. Runtime Probe：当前 Provider / Model 是否能完成最小真实请求。

Probe 只代表当前时点可用性，不保证整个长 Run 持续可用。

## 7. 统一交接与证明链

Node Result 由两部分组成：

1. 系统元数据：logical run、node、attempt、snapshot revision、输入版本、产物版本、依赖关系、实际 provider/model 等；
2. 节点专业结果：由当前节点 Output Schema 定义。

示例：

`Requirement R1 -> Design D1 -> Implementation I1 -> Review RV1 -> Test T1`

若产生 `Implementation I2`，RV1/T1 仍是 I1 的历史证明，但不再证明 I2。

探索补充研究也按依赖式失效：新增专家证据保留原专家结果，只重新综合和评估依赖该证据集合的结论，不机械重跑全部专家。

## 8. 12 个正式 Built-in Role

通用基础能力：

1. `requirements` — 需求分析
2. `designer` — 方案设计
3. `dev` — 开发
4. `review` — 审核
5. `test` — 测试
6. `evaluator` — 评估
7. `accept` — 验收助手
8. `closeout` — 收口

专业能力：

9. `diagnose` — 缺陷诊断
10. `orchestrator` — 探索统筹
11. `researcher` — 专家研究
12. `synthesizer` — 综合分析

旧 `dispatcher` 迁移为 Custom Role。

复用规则：

- `dev`：建设“开发”、优化“执行”、诊断“修复”；
- `test`：建设“独立测试”、诊断“回归验证”；
- `evaluator`：优化“评估”、探索“结论评估”，但节点级评价契约不同；
- `review` 与 `evaluator` 保持不同能力；
- `researcher` + 动态专家任务书生成 3–5 个运行期专家，不创建永久 Expert A/B/C/D。

## 9. 四套正式 Built-in Workflow

### 9.1 建设 · 完整功能开发

流程：

`需求分析 -> 方案设计 -> 开发 -> 独立审核 -> 独立测试 -> 人工验收 -> 收口`

关键规则：

- 需求最终确认是强 Human Gate；
- 方案阶段仅重大未决问题条件触发 Human Decision；
- Dev -> Review -> Test 固定顺序；
- 实现/方案/需求问题分别返回真正上游；
- 正式变化后重新执行因依赖变化而失效的证明；
- 自动回退额度默认 3；超限转人工；
- Human Acceptance 是正式业务阶段，由验收助手准备证据、人最终签字。

### 9.2 优化 · 快速迭代

流程：

`目标确认 -> 执行 -> 评估 -> 收口`

方法：Evaluator–Optimizer。

关键规则：

- 目标确认生成并冻结 evaluation contract；
- 执行采用最小必要修改并保护已满足部分；
- Evaluator 输出 `PASS / OPTIMIZE / CONFIRM`；
- `OPTIMIZE -> execute` 消耗自动回退额度；
- `RECONFIRM_REQUIRED` 不消耗；
- 自动回退额度默认 3；
- `CONFIRM` 或超限进入 Human Decision；
- Completion Type 区分 `EVALUATION_PASSED / USER_ACCEPTED`。

### 9.3 诊断 · 缺陷修复

流程：

`缺陷诊断 -> 修复 -> 审核 -> 回归验证 -> 收口`

方法：Evidence-driven Debugging。

关键规则：

- 先诊断、后修复；
- 原始 feedback signal 贯穿诊断、修复、回归；
- 证据不足且不可复现时 BLOCKED，不猜根因；
- 不稳定复现但证据足够时允许高可信根因路径，同时保留不确定性；
- 审核/回归发现修复问题回修复，证据推翻根因回诊断；
- 修改后必须重新审核和回归；
- 默认不增加独立人工验收；高风险条件式人工确认由 Human Decision 承载；
- **默认自动回退额度具体数值尚未最终确认**；推荐 3，但实施前必须单独确认。

### 9.4 探索 · 多视角探索

流程：

`探索统筹 -> 专家研究(Fan-out 3–5) -> 综合分析 -> 结论评估 -> END`

方法：Orchestrator–Workers + Synthesis + Evaluation。

关键规则：

- Orchestrator 设计互补认知视角，不拆报告章节；
- 第一轮专家上下文隔离；
- 专家区分事实/推断/未知，并提供证据、反证、假设、不确定性和 confidence；
- Synthesis 构建共识/分歧/证据地图，不多数投票；
- Evaluator 输出 `PASS / NEEDS_RESEARCH / INSUFFICIENT`；
- `INSUFFICIENT` 是合法 `COMPLETED`；
- 补充研究只做 Targeted；新证据必须重新综合和评估；
- 默认无人工节点；
- 不增加 Closeout Agent，Evaluator 直接进入统一完成协议；
- **总研究轮次最多 3 轮，包含首次 BROAD**；不是“首次 + 3 次补充”；
- 自动研究最多为第 1 轮 BROAD + 最多第 2、3 轮 TARGETED；
- 若以 `maxRounds / countRound` 承载该限制，因为初次执行不计自动回退额度，最多允许 **2 次 `NEEDS_RESEARCH -> orchestrate` 自动回退**；
- 第 3 轮结束后不得自动开启第 4 轮；Evaluator 应基于现有证据形成 `PASS` 或 `INSUFFICIENT` 等受控终结结果。

## 10. Built-in / Custom 规则

正式 Built-in Workflow 只保留上述四套新标准。

历史 `default-workflow` 与 `dev-workflow-2-0` 退出 Built-in 身份，迁移为 Custom Workflow，并尽量保留用户引用、Skill 触发兼容和历史运行可追溯性。

Built-in Workflow 支持：

- 查看结构；
- 修改用户级 Provider / Model Override；
- 验证配置；
- 基于此模板创建 Custom Workflow。

Built-in 不允许原地修改 Node、Edge、Role、Goal、Schema、Outcome Routing、Human Decision、自动回退规则和 Topology。

Custom Workflow 可完整编辑。

## 11. UI / 交互边界

当前真实基线：

`模板库 -> 工作流编辑器（画布 + 配置面板）-> 保存生成/更新 Skill -> Chat 调用 Skill`

后续 #75 需要统一设计：

- Skill/Chat/插件入口关系；
- Template Library Built-in/Custom 信息架构；
- Outcome Preset / Completion Mapping 渐进式配置；
- Logical Run Dashboard / Timeline / 流程视图；
- 成果与证据视图；
- Run Guidance；
- BLOCKED 恢复与 Snapshot Provider/Model 切换。

UI 不得另造第二套 Runtime。

## 12. 当前唯一模板未决项

仅保留：**诊断模板默认自动回退额度具体数值**。

探索模板轮次已经锁定为总共最多 3 轮；按自动回退额度映射时最多允许 2 次 `NEEDS_RESEARCH -> orchestrate` 自动回退。

## 13. 实施依赖

```text
#71 全局原则
  |
  +--> #77 Business Outcome Routing / Completion Mapping
  +--> #78 Formal Records / Provenance
  +--> #72 Human Decision
  +--> #73 自动回退额度
              |
              v
        #79 Logical Run / Lifecycle / Snapshot
              |
              +--> #80 Pause / Interrupt / Guidance / Resume
              +--> #74 Preflight Probe
              +--> 在 #40 已交付的持久化层上演进 Logical Run persistence

#58 Role Library 基础能力 --> #81 12 个正式 Built-in Role

#77 + #78 + #72 + #73 + #79 + #81
              |
              v
#82 四套正式 Built-in Workflow + 历史模板迁移 + Built-in Model Override
              |
              +--> #83 Skill / Chat Invocation -> Logical Run Runtime

#75 横向消费上述契约，定稿后再拆具体 UI 施工任务。
```

## 14. GitHub Issue 归属

### 总览 / 原则

- #71：全局设计原则；
- #76：v0.1 正式工作流体系实施总览。

### Blueprint / 结果 / 证据

- #77：Business Outcome Routing + Completion Mapping；
- #78：Formal Records / Version / Provenance；
- #72：Human Decision；
- #73：自动回退额度；
- #69：多格式正式 Artifact，在 #78 契约上实现。

### Runtime

- #79：Logical Run / Execution Segment / Lifecycle / Snapshot Revision；
- #80：Pause / Interrupt / Guidance / Resume；
- #74：Preflight Probe；
- #40：legacy engine-run persistence 已由 PR #50 完成；Logical Run persistence 演进归 #79。

### 资产 / Invocation

- #58：Role Library 基础能力已由 PR #61 完成；
- #81：12 个正式 Built-in Role + 历史角色迁移；
- #82：四套正式 Built-in Workflow + 历史模板迁移；
- #83：Skill / Chat Invocation 接入统一 Logical Run Runtime。

### UI

- #75：整体 UI/交互架构设计。

### 已退出实施依赖

- #64–#68 已关闭为 Superseded；仍有价值的语义已分别迁入 #73/#77/#78/#81/#82；
- #5 保留为早期编辑器/运行看板历史背景，不再作为正式状态模型依据。

## 15. 分阶段实施清单

### Phase A — Blueprint 契约底座

- [ ] #71 方法论补充收口；
- [ ] #77 Outcome Routing / Completion Mapping；
- [ ] #72 Human Decision / Decision Record；
- [ ] #73 自动回退额度；
- [ ] #78 Formal Records / Provenance；
- [ ] #69 多格式 Artifact 接入 Formal Record。

### Phase B — Logical Run Runtime

- [ ] #79 Logical Run / Lifecycle / Snapshot Revision；
- [ ] #80 Pause / Interrupt / Guidance / Resume；
- [x] #40 legacy engine-run persistence（PR #50）；
- [ ] #79 在既有持久化层上升级 Logical Run / Segment / Snapshot Revision persistence；
- [ ] #74 Snapshot Preflight Probe。

### Phase C — 正式资产

- [x] #58 Built-in / Custom Role Library 基础能力（PR #61）；
- [ ] #81 12 个正式角色及历史迁移；
- [ ] #82 四套 Built-in Workflow、历史模板迁移、Built-in Model Override；
- [ ] #78/#82 正式 Built-in artifact/file 契约随 Formal Record 与当前 Built-in 集合演进；
- [ ] #83 Skill / Chat Invocation 接入 Logical Run。

### Phase D — UI / 产品呈现

- [ ] #75 UI/交互方案定稿；
- [ ] Template Library Built-in/Custom 信息架构；
- [ ] Outcome / Completion / Human Decision 渐进式配置；
- [ ] Skill/Chat/插件入口关系；
- [ ] Logical Run Dashboard / Timeline / 成果与证据；
- [ ] Run Guidance / BLOCKED 恢复 / Snapshot 模型切换。

## 16. 发布门槛

四模板进入 Built-in 之前至少满足：

- Blueprint 能表达专业 Outcome 和自定义结果字段；
- 多结果路由不依赖把业务结果伪装成 failure；
- Human Decision 可等待/恢复并持久化 Decision Record；
- 自动回退额度可按业务回退路径独立计数；
- Logical Run 能跨多个 Execution Segment 保持同一 Run；
- Run Snapshot 可冻结，并只对当前 Run 修改 Provider/Model Revision；
- Provider/Model Preflight 可实际验证；
- Formal Records 和版本依赖可追溯；
- 12 个正式 Role 和四套 Workflow 正确生成 Skill；
- 旧 Built-in 资产完成兼容迁移；
- 产品模式下完成真实 E2E。

## 17. 迁移与实现素材

- Draft PR #70（`feat/multi-perspective-exploration`）已关闭且未合并；分支保留为探索模板素材库；
- 后续 Agent 不得 reopen/rebase #70 作为正式实现，也不得整包 cherry-pick；
- `orchestrator/researcher/synthesizer` 与探索业务 Schema 可在 #81/#82 选择性复用；旧 success/failure 路由、10-role registry 和数量测试必须按 #77/#81/#82 重做；
- #40 的 legacy engine-run persistence 已完成；v0.1 不重新打开 #40，而是在 #79 中把既有持久化层升级为 Logical Run / Execution Segment / Snapshot Revision 模型；
- #65–#68 已关闭为 superseded，后续只引用迁移后的正式承接 Issue。
