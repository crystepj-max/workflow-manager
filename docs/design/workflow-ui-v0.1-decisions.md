# v0.1 UI 产品裁定与归属（正式归档）

> 裁定基线：2026-10-17，DT-00=C、DT-01=A、DT-02=B、DT-03=A。  
> 实现核对：2026-10-22，main `63bef81ef0a6b67dbf3ed0efba2a48e04c639298`。  
> 归档任务：`WFM-82`（Task UUID `01a0e618-e9af-72a0-b230-c2472e3af510`）。本文记录产品范围、唯一承接和相应实现证据；不代替各任务验收或 [#213 产品模式发布验收](https://github.com/crystepj-max/workflow-manager/issues/213)。

## 1. 权威边界

本文是 [#75 当前执行口径](https://github.com/crystepj-max/workflow-manager/issues/75) 的唯一仓库正式归档入口。#75 保持 **OPEN**，继续作为 UI 剩余需求的父票和产品决策/归属索引；后续有证据的产品裁定须同步到本文。文档归档、产品决策完成、代码合入和用户验收分别记录。

- 长期方法论以 [`workflow-design-principles.md`](workflow-design-principles.md) 为准；v0.1 目标语义以 [`workflow-manager-v0.1-final-product-spec.md`](workflow-manager-v0.1-final-product-spec.md) 为准。本文只固定本轮已确认的 UI 范围和承接边界。
- Current 以实际 main 和对应交付证据为准；本次核对提交见文首。Multica 是任务状态、负责人、项目、依赖和执行历史的真源；本文不维护第二份任务登记册。需要精确读取现行承接时，WFM-67 的 Task UUID 为 `01a0e5e2-f331-77a3-bb8a-78d45a858d8a`，WFM-83 为 `01a0e619-474c-746b-85cb-3e2900099ddf`；不根据 Task key 推测网页路由。
- [`workflow-ui-interaction-architecture.md`](workflow-ui-interaction-architecture.md)、FEAT-75 / CHORE-113 的本地卡与决策票保留为 2026-09 历史资料。其“待裁”、四段面板、关闭 #75、旧模板迁 Custom、历史载荷余量等内容不构成当前要求；历史条文与人工确认原文不重写。
- P1–P10、十四项原完成标准只在下方各归档一次；不另制 R-1…R-14 缺口账表。更细的功能验收仍由对应交付任务负责。

## 2. 已确认的产品裁定

| 决策 | 生效结论与范围 | 原始裁定 |
|---|---|---|
| DT-00=C | #75 保留 Open，收窄为剩余 UI 需求父票及决策/归属索引；终止 FEAT-75 与 CHORE-113 的去留冲突，取消“关闭 #75”的旧交付目标。文档归档归 WFM-82，功能沿已有独立承接推进。 | [2026-10-17 DT-00](https://github.com/crystepj-max/workflow-manager/issues/75#issuecomment-6231570747) |
| DT-01=A | **Skill / Chat 是本版新 Logical Run 的唯一正式用户发起入口**；插件不新增起跑按钮，S-1 取消。同一 Run 内的暂停、指导、中断、人工决定与受阻恢复继续保留，沿同一 Logical Run / Runtime 留痕。 | [2026-10-17 DT-01](https://github.com/crystepj-max/workflow-manager/issues/75#issuecomment-6231651893) |
| DT-02=B | 逐节点纠正内置 Outcome Preset，再在自定义工作流“结果与去向”提供选择器；展示真实字段、枚举及中文含义，按当前 schema 校验，冲突明示并确认，保留手填和自定义路径。内置结构只读；不新增用户自建/保存 Preset；Completion Mapping 仍归 WFM-83。 | [2026-10-17 DT-02](https://github.com/crystepj-max/workflow-manager/issues/75#issuecomment-6231717311) |
| DT-03=A | **OBSERVING 为本版非目标、未交付、不纳入 UI/发布验收**；S-5 取消，不加观察标签、手工标记、metadata 写入口、生产者或 Lifecycle。长期“OBSERVING 不是 Lifecycle、复发另建 Run”语义保留；已有终态及实际 Completion Type 仍正常验收。 | [2026-10-17 DT-03](https://github.com/crystepj-max/workflow-manager/issues/75#issuecomment-6231738435) |

动态载荷上限维持 **284 KiB（290816 B）**，不提高到 296 KiB。此限制来自 [#75 后续产品确认](https://github.com/crystepj-max/workflow-manager/issues/75#issuecomment-6306639979)；某次构建余量仅对该版本和构建路径成立，新增 UI 须当次实测。

DT-03 只排除观察功能，未取消 P9 对三类信息视角的评估，也未将统一 Timeline 宣布为已交付。四项裁定均已确认，无须把 2026-09 决策票的 `open` 状态当成当前产品阻塞。

## 3. 持续有效的 P1–P10

原始确认见 [#75「第五轮审查结论」](https://github.com/crystepj-max/workflow-manager/issues/75#issuecomment-5463302857)。以下规则由相应功能持续遵守，不各自重复创建施工任务。

| # | 产品规则 |
|---|---|
| P1 | 内置模板与自定义工作流分区展示。 |
| P2 | Built-in Workflow 结构只读，但用户可持久配置 Provider / Model Override。 |
| P3 | 其他结构修改必须“基于此模板创建自定义工作流”。 |
| P4 | Run Snapshot v0.1 只允许 Provider / Model Revision。 |
| P5 | v0.1 不做自动 Backup Provider；BLOCKED 后由用户选择替代模型并 Probe。 |
| P6 | PAUSED 支持 Run Guidance，多轮沟通形成 Guidance Record 后继续。 |
| P7 | 支持 Safe Pause 与 Interrupt 两种运行干预。 |
| P8 | Run Dashboard 围绕 Logical Run，不围绕底层 engine start。 |
| P9 | Run Detail 至少评估“流程 / Timeline / 成果与证据”三类信息视角；不强制三个页签。 |
| P10 | Guidance 若实质改变正式基线，必须升级为 Baseline Revision，不能只作为聊天上下文。 |

Node Business Outcome、Run Lifecycle、Completion Type 分层表达；技术执行完成不等于业务 PASS，控制动作不得改写已形成的专业结果。探索额度耗尽按目标规格 §5 / §9.4 的已确认口径收口为 `COMPLETED / INSUFFICIENT`，保留原 `NEEDS_RESEARCH`，不转人工、不弹决策卡；该结果不可被显示成仍待自动返工。

## 4. 十四项原完成标准的唯一归属

状态只覆盖文首 main 核对基线。“已合入”表示有 main 代码或 merge 证据；“待产品验收”表示本文未取得对应正式安装/真实使用签收；“待交付”不把在飞候选当成 Current。下表承接的是需求范围，不是新的派工清单。

| 原编号 | 范围 | 唯一承接 / 现有边界 | Current 与待验事项 |
|---|---|---|---|
| 1 | Built-in / Custom 模板信息架构 | 既有模板库；#75 仅保留 P1–P3 回归约束。 | 分区、内置只读和复制为 Custom 的主体已在 main；[PR #361](https://github.com/crystepj-max/workflow-manager/pull/361) 已删除旧 `default-workflow` / `dev-workflow-2-0` / `dispatcher`，不恢复为 Custom。代码见 [client.js](../../packages/dsh-visual-workflow/src/client.js) 与 [四模板真源](../../templates/)。本归档未重做产品回归。 |
| 2 | Skill / Chat / 插件 Invocation 关系 | DT-01=A；S-1 已取消。 | 新 Run 由 Skill / Chat 经 `wf_run` 进入同一 Runtime；既有 Run 控制/续跑不在取消范围。正式入口说明见 [dsh/README.md](../../dsh/README.md)。本版不交付插件起跑按钮。 |
| 3 | Built-in Model Override | 既有模型覆盖实现；不另立同名功能。 | [host.js](../../packages/dsh-visual-workflow/src/host.js) 的 `composeModelBindings` 与 `vwf.workflows.modelOverride.*` 及现有模型设置界面已合入；持久覆盖与原结构只读仍须在产品回归中同时核验。 |
| 4 | 自定义 Workflow 渐进编辑 | 三段编辑器保留；多层字段与完成映射交给 **WFM-83**；FEAT-115 已取消。 | `InspectorTabs` 保持基础 / 结果与去向 / 高级。本基线的结果路径辅助仍限制单层，自定义多层路径及完成映射编辑待 WFM-83 交付；不恢复四段重排。 |
| 5 | Outcome Preset + 自定义 Outcome | S-2a/S-2b 由 **WFM-446** 交付；自定义多层路径边界仍归 WFM-83。 | [PR #364](https://github.com/crystepj-max/workflow-manager/pull/364) 已合入：优化评价 `$.route`、探索评价 `$.verdict`、建设/诊断 review 路由分别定义；[Preset 数据](outcome-presets.json)、`planOutcomePresetApplication` 与选择器可查。PR 明确保留产品安装/E2E及与 WFM-83 联合回归，本文不代签。 |
| 6 | Completion Mapping | 内核 / 内置声明为既有能力；自定义可视化声明与路径保真唯一归 **WFM-83**（原 FEAT-114 / #290）。 | [blueprint-schema.md](blueprint-schema.md) 与内置蓝图已有 `completionPath`；本基线缺自定义完成映射编辑入口，待 WFM-83 交付，不凭 GitHub 迁移关闭判完成。 |
| 7 | Preflight / Snapshot Model 修改 | 既有 Probe / Snapshot 为底座；UI 改模型、Probe、恢复闭环唯一归 **WFM-67**。 | 只能修改当前 Run 的 Provider / Model 并生成 Snapshot Revision；模型替换后的真实恢复待该任务验收，不增加静默备用模型。 |
| 8 | Logical Run Dashboard | S-4 由 **WFM-451** 交付；具体后续缺陷分别沿现行任务处理。 | [PR #370](https://github.com/crystepj-max/workflow-manager/pull/370) 已合入 [dashboardProjectionOf](../../scripts/dashboard-projection.cjs)、host 摘要和现有列表行：当前节点、最近业务结果、额度、唯一活动快照、最近事件；缺失/歧义保留未知。产品重启/E2E仍待独立留证；基线事件标签修正由 **WFM-463** 跟进，不重做 S-4。 |
| 9 | Run Detail 三类信息视角 | **#75 保留核实施工承接 / 验收的唯一治理责任**；统一 Timeline 的历史需求源为 [LOC-016 V2 §7.1.2](../tasks/specs/LOC-016-logical-run-ui/task-spec-V2.md)，不是当前任务状态。 | main 已有结果/检查/活动、成果与记录；`renderActivityTab` 按事件类别显示，`chainEntries` 按节点展开，不能当作跨 Snapshot / Probe / Decision / Guidance 按时间合并的 Timeline。尚未核实该缺口的现行施工任务；不猜号、不在 WFM-82 新增 UI 施工或重复立卡。 |
| 10 | PAUSED / Guidance | 既有控制与记录能力；P6/P7/P10 为持续回归边界。 | 暂停、Interrupt、指导记录和基线修订主体可在 `renderControlCard` / `renderPausedCard`、`vwf.run.control` 查到。真实控制路径按现有产品验收执行；不以“活动”分类列表替代统一 Timeline。 |
| 11 | WAITING_HUMAN / Human Decision | 材料呈现为既有能力；提交续跑唯一归 **WFM-67**（原 FEAT-208 / #208）。 | 本基线 `rdDecisionSubmit` 仍禁用；不能称用户可通过 UI 决策续跑。沿原 Logical Run 追加段、提交失败可重试、幂等和来源留痕均由该任务验收。 |
| 12 | BLOCKED / 模型替换 / Probe / Resume | 恢复卡呈现为既有能力；提交闭环唯一归 **WFM-67**。 | 本基线 `rdBlockedSubmit` 仍禁用；改模型 → Probe → 同 Run Resume 待交付。既有控制同 Runtime 原则不因 DT-01=A 取消。 |
| 13 | 完成终态与 Observing | 已有 COMPLETED / STOPPED / FAILED 和真实 Completion Type 按对应产品证据验收；观察功能按 **DT-03=A** 排除。 | `OBSERVING` / `COMPLETED_OBSERVING` 没有本版正式生产者或 UI 交付；长期语义保留，当前未交付、不纳入验收，S-5 已取消。不得以新增 Lifecycle、手动标记或模拟结果补空验收项。 |
| 14 | #54–#57 局部 UX 归属 | 保留既有局部 UX 的历史交付和回归责任，不由 #75 整体重做。 | [#54](https://github.com/crystepj-max/workflow-manager/issues/54)、[#55](https://github.com/crystepj-max/workflow-manager/issues/55)、[#56](https://github.com/crystepj-max/workflow-manager/issues/56)、[#57](https://github.com/crystepj-max/workflow-manager/issues/57) 已关闭；代码落点与历史核对见 [历史快照 §7](workflow-ui-interaction-architecture.md)。本次没有重做真机视觉签收；若发现具体回归，附复现沿独立缺陷处理。 |

本轮只更新已确认裁定、交付归属和文档引用。WFM-69 / WFM-70 / WFM-77 / WFM-81 等各自的执行记录、起跑互斥、安装漂移和取证等级工作仍按原任务验收；其候选实现不能替代此表的 main 证据，也不由本归档扩大范围。

## 5. 实现与验收的读取顺序

1. 先看本文 §2 / §3，确认本版本的产品范围与持续规则。
2. 再看 §4 对应唯一承接及 live Multica Task；合入事实以相应 GitHub PR / main 为证，迁移源票的 CLOSED 仅是迁移记录。
3. 需要字段契约时看 [`blueprint-schema.md`](blueprint-schema.md)；需要具体蓝图时看 `templates/*.json`；不得用历史设计快照覆盖 Current 或 Target。
4. 发布仍按 [`AGENTS.md`](../../AGENTS.md) 与 [#213](https://github.com/crystepj-max/workflow-manager/issues/213) 的产品模式证据逐项验收；单一模板成功、机器测试或本文归档均不能代签四模板发布。

S-0 文档入库不关闭 #75。S-2 / S-4 合入不自动完成全部 UI 或发布验收；S-1 / S-5 / FEAT-115 的取消不会因历史文档仍保留原文而失效。WFM-108 的历史资料归置、WFM-468 的历史措辞校正各自保留，不并入本项重做。
