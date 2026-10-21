# 工作流插件 UI / 交互架构定稿（v0.1）

> 定位：Workflow Manager **插件侧 UI 与信息架构的产品权威**。回答"用户如何发现、理解、配置、调用、干预运行、处理人工决策与阻塞、查看完整 Run 与最终成果"。此前这些规则只存在于 GitHub [#75](https://github.com/crystepj-max/workflow-manager/issues/75) 的正文与评论里，仓库内无可引用副本——本文消除该权威真空。
>
> 需求源：[#75](https://github.com/crystepj-max/workflow-manager/issues/75)（`design: 工作流插件整体 UI/交互架构重构`），产品规则来自该 Issue 的「第五轮审查结论：P1–P10 全部确认」评论（2026-09-19 核对：GitHub 侧仅此 1 条评论，第 1–4 轮审查发生在 CNB 期，未随迁移带回，见 §7）。
>
> 与相邻权威的关系：本文只管 **UI 承载什么、如何分层呈现、用户可以做什么**。字段级契约见 [`blueprint-schema.md`](blueprint-schema.md)；产品语义与七层结果模型见 [`workflow-manager-v0.1-final-product-spec.md`](workflow-manager-v0.1-final-product-spec.md) §2–§6；为什么这样设计见 [`workflow-design-principles.md`](workflow-design-principles.md)。该规格 §11 把 UI 整体推给 #75，本文即其承接者。
>
> Current vs Target：本文的 **P1–P10 是 Target 产品规则**；§5「承载现状」逐条标注 main 已实现到什么程度。二者不一致属正常迁移状态，不得静默混用。

## 1. 适用范围

本文约束：

- 模板库（Built-in / Custom）的信息架构与只读边界；
- 工作流编辑器的渐进式配置分层（基础 / 结果与去向 / 高级）；
- Run 看板与 Run 详情的信息分层与视图划分；
- 人工决策、暂停/指导、受阻恢复在界面内的表达方式；
- 运行入口（Chat / Skill / 插件）与 Runtime 的关系约束。

本文不替代：

- Blueprint 字段与校验规则（`blueprint-schema.md`）；
- Runtime / Invocation / Formal Records 的实现方案（#77–#83）；
- 具体施工卡的范围与验收（`docs/tasks/`）；
- 视觉细节（配色、间距、控件形态）——视觉权威在交互原型，见 §6。

**明确不属于本文范围的功能缺陷**（列出来只为划边界，**不得为其设计 UI**）：GitHub **#233**（`wf_run --templateId wf-explore` 误报"未绑定 Agent"，显式传图可绕过）与 **#234**（内置模板默认模型绑定过期，`wf-explore` 的 evaluate 指向已删除配置）都是入口级功能缺陷，走各自的功能修复票；**#235**（隔离保证等级实测 `unavailable` 的根因）只有其**呈现义务**进本文 §4.7，修复本身不在 #75。

---

## 2. P1–P10 硬约束（产品规则，不得在单个施工卡里重新发明）

| # | 规则 | 对 UI 的硬要求 |
|---|---|---|
| P1 | 内置模板与自定义工作流**分区展示** | 模板库必须可区分 Built-in / Custom；不得混排成同一平铺列表 |
| P2 | Built-in Workflow 结构**只读**，但用户可持久配置 Provider / Model Override | 内置项不得提供结构编辑入口；模型覆盖是一等的、可持久化的独立入口 |
| P3 | 其他结构修改必须"**基于此模板创建自定义工作流**" | 不得出现"就地改内置结构"的路径（含通过 JSON 页签绕过） |
| P4 | Run Snapshot v0.1 **只允许** Provider / Model Revision | 运行中不得暴露其他可变结构；UI 必须声明"仅影响当前 Run" |
| P5 | v0.1 **不做自动 Backup Provider**；BLOCKED 后由用户选替代模型并 Probe | 不得静默换模型；受阻态必须给出"改模型 → 重新探针 → 恢复"的人工路径 |
| P6 | PAUSED 支持 Run Guidance，多轮沟通形成 Guidance Record 后继续 | 暂停现场必须可续写指导，并留存为记录而非一次性提示 |
| P7 | 支持 Safe Pause 与 Interrupt **两种**运行干预 | 两种干预语义不同，不得合并成一个"停止"按钮 |
| P8 | Run Dashboard 围绕 **Logical Run**，不围绕底层 engine start | 一次任务跨多执行段仍显示为一个 Run |
| P9 | Run Detail 至少评估"**流程 / Timeline / 成果与证据**"三类信息视角 | 三类视角是评估义务，不强制一比一映射成三个页签；结论见 §4.3 |
| P10 | Guidance 若实质改变正式基线，必须升级为 **Baseline Revision**，不能只作聊天上下文 | 界面必须能区分"补细节的指导"与"改基线的指导" |

**分层铁律**（贯穿 P8/P9）：Node Outcome、Lifecycle、Completion Type 在 UI 中必须保持分层，Runtime 控制不得改写专业 Outcome。示例：额度耗尽升级人工时，看板须同时表达 Outcome=`NEEDS_RESEARCH`、Lifecycle=`WAITING_HUMAN`、reason=`MAX_ROUNDS_REACHED`，不得因"有人在处理"就显示成 `PASS`。

> ⚠️ **该示例在探索模板上已被裁定改变**（方案 A，crystepj-max 2026-09-20；实现来源 LOC-036，用户 2026-09-16 确认，`docs/tasks/specs/LOC-036-exploration-coverage/task-spec-V1.md:117`）：探索第 3 轮仍判 `NEEDS_RESEARCH` 时**不进入 `WAITING_HUMAN`、不弹决策卡**，由宿主收口为合法完成 `INSUFFICIENT`，并保留原专业裁决。代码事实：`scripts/generate.mjs:840-846` 的探索专属分支先于 `:855` 通用 `haltWaitingHuman(..., 'MAX_ROUNDS_REACHED')`；`templates/wf-explore.json:8` 声明 `"maxRoundsExhausted": "INSUFFICIENT"`，且 `scripts/validate-core.cjs:642` 限定只有 `wf-explore` 可声明。
>
> 🔴 **代价是呈现义务转移到 UI**：既然不再弹决策卡，用户就必须在**运行详情、「完整经过」链路、终态摘要**三处看懂"这次是被自动回退额度上限收尾的，不是正常结束"，并且能取回原始专业裁决（`NEEDS_RESEARCH`）。这条定稿为 §4.6，是本版本的强制验收项。
>
> **分层铁律本身不变**：上面那组三层表达在未取代的另外三套模板上仍然成立，继续作为通用判据。

---

## 3. 运行入口：当前事实与约束

🔴 **当前真实正式运行入口仍然是 Skill / Chat。** 这不是待改的缺陷，而是 v0.1 的既定口径：

```text
用户在 Chat 调用 Skill / 触发词
        ↓
  wf_run（插件宿主注册的运行工具）
        ↓
  Logical Run Runtime（Logical Run / Execution Segment / Snapshot）
```

- 运行能力已经存在，且形态是**工具调用而非界面按钮**：`wf_run` 见 `packages/dsh-visual-workflow/src/host.js:3075`，实际起跑 `engineNow.start` 见同文件 `:3456`。
- Skill/Chat 口径统一到 `wf_run` 由 LOC-015（GitHub #83）落地，commit `6e8bd5f`；该票同时裁定**发起权归插件、"结果回灌"方案不采纳**。
- 插件的浏览器侧（编辑器 / 看板）**没有任何运行入口**：模板行只有「查看流程 / 模型设置」或「编辑 / 删除」（`src/client.js:5194-5198`）。
- 注意 #83 设想的独立 `Invocation Adapter` 层在插件源码内**零命中**（`grep -i invocation src/`），当前是"Skill → 插件内工具 → 引擎"的单层结构，而非三层。

**不可协商的约束**：无论插件将来是否增加"运行 / 使用此工作流"入口，都必须进入同一个 Logical Run Runtime，**禁止出现 Chat Runtime 与 Plugin Runtime 两套运行状态或两份运行历史**。

是否新增插件内运行入口，是本文唯一悬而未决的产品选择 → 决策票 `docs/tasks/specs/FEAT-75-ui-interaction-architecture/decision-tickets/DT-01-plugin-run-entry.md`。

---

## 4. 信息架构定稿

### 4.1 模板库

- Built-in 只展示正式四套：建设 / 优化 / 诊断 / 探索（P1）。
- 内置项入口固定为两个：「查看流程」（只读结构）与「模型设置」（Provider / Model 持久覆盖，P2）。
- 历史 `default-workflow` / `dev-workflow-2-0` 归入 Custom 并可编辑，迁移映射由宿主 `isLegacyCustomId` 承担（`src/host.js:299-332`）。
- 结构修改一律走"基于此模板创建自定义工作流"（P3）。

### 4.2 编辑器：渐进式配置

现状是**配置栏三段 tab**（`InspectorTabs`，`src/client.js:2106-2112`；其注释 `:361` 自述"配置栏三段 tab（V-11）"）：基础 / 结果与去向 / 高级设置+JSON，档位带校验错误时标 ⚠ 并自动切过去。目标形态是**四段**（插入"完成映射"一档），已由 **FEAT-115** 认领（需先出真机原型）。

| 段 | 承载 | v0.1 状态 |
|---|---|---|
| 基础 | 节点名 / 角色 / Provider / Model / 目标、输入输出、正式产物声明 | 已实现 |
| 结果与去向 | Business Outcome Routing：字段路径 + 值 → 去向；`countRound` / 自动回退额度 | 已实现，但**只认单层字段名**（`routingNameOf` `client.js:5551-5555` 对多段路径返回 `''`），而校验内核允许多层（`scripts/validate-core.cjs:123`）→ **FEAT-114** |
| **完成映射（Completion Mapping）** | 终态节点结构化结果字段 → Run Completion Summary | **缺失**——契约与运行时全通，仅无编辑入口 → **FEAT-114** |
| 高级 | Human Decision、Fan-out、Formal Record 声明、其他 Blueprint 高级项 | 已实现 |

Completion Mapping 必须作为一等能力补入，不得只靠 JSON 页签手改 DSL；按 CHORE-113 侧裁定，它**不算 v0.1 发布门槛**（内置模板已满足规格 §13），排发布后第一批。

`docs/design/outcome-presets.json` 定位为**候选值推荐**，不是校验规则；当前内容与实际模板不一致（见 §5 R-2），在纠偏前不得直接接入选配器。注意 FEAT-114 已明确"不新增完成映射 Preset 库"、并把 Preset 理解为"按 schema 声明给出候选值"（其 `task-spec-V1.md:38`）——**该文件本身的选择器至今无人认领**，仍是开放项（DT-02）。

### 4.3 Run 详情：三类视角的落点

P9 要求评估三类视角。定稿结论：

- **流程**：沿用已验收的「结果 / 检查 / 活动」三分组 + 链路视图，不推倒重来；
- **Timeline**：必须是**按时间排序的合并事件流**（创建 → 快照 → 探针 → 节点 → 暂停/指导 → 恢复 → 决策/受阻 → 完成），**当前不存在**——现有"完整经过"弹窗按模板节点顺序生成（`chainEntries`，`src/client.js:3977-4055`），不含快照、探针、决策、指导事件；
- **成果与证据**：Baseline、Artifact Revision、Review/Test/Evaluation Proof、Decision Record、当前有效版本与 stale Proof、Completion Type。

施工归属：Timeline 已在 **LOC-016 V2 片1** 基线内（`docs/tasks/specs/LOC-016-logical-run-ui/task-spec-V2.md` §7.1.2），本文确认其为正式承接者，#75 不另立重复卡。

### 4.4 Run 看板字段

P8 + §6 要求列表行至少承载 8 项。现状与缺口见 §5 R-8；宿主侧多数字段已回传（如 `head.node`、`budgetUsed`），属"数据有、界面没有"。

### 4.5 状态与干预的呈现分层

- `PAUSED`（用户主动）/ `WAITING_HUMAN`（系统有决策请求）/ `BLOCKED`（外部条件缺失）三者语义不同，界面必须可区分（P6/P7、§9）。
- 人工决策卡必须展示：决策原因、原 Node Outcome、当前事实/证据/缺口、选项、成本/收益/风险/影响、推荐、每个选项的后续效果；自动回退额度耗尽同样走决策卡，**必须保留原 Outcome，不制造 PASS**。
- 决策卡与恢复卡的**提交续跑路径归 FEAT-208**（GitHub #208），本文只约束呈现层；两者的边界由 §5 R-5 固定。

### 4.6 额度收尾必须可见（裁定 A 的配套呈现义务）

产品口径：**不新增第二套状态机，也不新增状态**。FIX-108 已把「结果信息 / 执行记录 / 完整经过」三处收成单一权威结局判定（`attemptVerdictOf`），要加就加在那一张词表上；文案按 FIX-107 去术语口径，用户可读。

🔴 **实测已钉死：这条呈现义务完全没落地，而且界面给出的是反向信号。** 主仓独立会话以离线注入跑满额度（不花模型调用费）核对四个可见面，本轮逐行复核其引用全部对上：

| 可见面 | 能否看出"被额度收尾" | 实测依据（本轮独立复核） |
|---|---|---|
| 运行详情·完成类型 | **否** | `locales/zh.json:285` `rdCompletionInsufficient` = 「证据不足，如实结束」——A 收口与评估节点直判 `INSUFFICIENT` **渲染成同一句**，用户无从区分"充分证据下的合法不足"与"额度耗尽被迫收尾" |
| 运行列表 | **否** | `budget_exhausted` / `explore_budget_exhausted` / `MAX_ROUNDS_REACHED` / `halted` 在 `src/` 命中数分别为 0 / 0 / 0 / 0（本轮 `grep -c` 复核） |
| 完整经过链路 | **否，且误导** | `verdictWordsOf`（`client.js:3417`）从 DSL 派生词表：`wf-explore` 里 `countRound=true` 的边只有 `NEEDS_RESEARCH`，且无指向 `$human-decision` 的边 → `attemptVerdictOf`（`:3441`）把末次评估判成 `returned` → `zh.json:338` = 「**退回修改**」。运行其实已收口，用户读到的是"还要返工" |
| 终态摘要 | **否** | 宿侧 `termination` 对两种 `INSUFFICIENT` **逐字节相同**（该会话对照用例断言，本轮未重跑），只读 `completion.type` 的消费方无法区分 |

> 原稿这里写的是"两种落点之一，待验收测试钉住"。**现已钉死为 `returned`／「退回修改」**，即反向信号而非信息缺失。一手材料：`.agent-runs/explore-budget-exhaustion-offline/findings.md` §4 与同目录 `card-draft-ui-budget-closure.md`。⚠️ 该目录被 Git 忽略，按仓库硬规则（规格不得只留在忽略目录）本表即为入库副本，后续施工卡须引用本节而非只引 `.agent-runs` 路径。

🟢 **成本更正（推翻本文先前的判断）**：区分信号**宿主侧已经具备**，不需要新增宿主投影——`scripts/generate.mjs:1537-1538` 在 A 收口时把 `completion.path` 改写为 `'$.explore_budget_exhausted.completion_type'`（正常直判是 `'$.completion_type'`），而 `:1543` 的 DONE 返回体本就带 `budgetUsed`、`maxRounds`、`results`、`history`。因此可用信号共四条：`completion.path` 差异、`budgetUsed` 计数、`results.explore_budget_exhausted` 存在与否、`history[]` 里的 `halted:true` + `reason:MAX_ROUNDS_REACHED`。**四条全部已到达插件数据面，UI 一处都没用**——所以这是纯界面缺陷，先前"按界面 + 宿主只读投影估"的说法作废。

需求（强制验收，逐可见面各自可判）：

1. **完整经过链路**：被额度收尾的末次评估不得再判成 `returned`；必须给出一个区别于"已通过/退回修改/阻塞/等待人工"的结局语义，措辞形如"研究补充额度已用尽，本次按证据不足收尾"，不出现 `MAX_ROUNDS_REACHED` / `INSUFFICIENT` 原词。
2. **完成类型**：A 收口与评估直判必须渲染成两句不同的话（前者含"额度用尽被迫收尾"语义，后者保持"证据不足，如实结束"），判定依据取 `completion.path` 或 `results.explore_budget_exhausted` 之一，不得靠节点名。
3. **运行列表**：该 Run 行上有"被收尾"标记，且额度已用/上限可见（`budgetUsed` / `maxRounds`，与 §5 R-8 同一条数据面）。
4. **原始裁决可取回**：同屏能读到被保留的原专业裁决 `NEEDS_RESEARCH` 及其 `why` / `current_state` / 研究目标，并明示"该裁决未被收尾动作改写"。
5. **不得把运行标成失败**：合法完成类型与"因额度上限收尾"分两层表达，不合并成一个标签。
6. **实现约束**：只能扩展 `attemptVerdictOf` / `ATTEMPT_VERDICT` 这一处权威并同步三视图，**禁止**新增状态枚举、新增第二套判定，或在单个视图里特判节点名与结果词（FIX-108 的根因正是各视图各自推导）。
7. **宿侧 `termination` 相同这一条不在本切片修**：它只影响外部消费方只读 `termination` 的场景，不阻塞上述四条。若施工中发现必须改宿侧，先回报再动，不得在 UI 侧造第二套判定来绕。

**执行时机**：本节的成文与逐面判定属"裁决前可观测"；**真机渲染复验排在重装之后**——产品机技能包停在 09-14 一代（不含 A 分支，属"安装态漂移"，另会话已起草立卡但尚未入库），在重装完成前无法用真机证明第 1/2/3 条已达成，不得以离线注入代替真机复验宣布验收通过。

### 4.7 取证等级必须可见（成果与证据视角）

「成果与证据」视角必须区分两件事：**这次运行的成果能不能当正式证据用**，与**它业务上有没有通过**。

事实基础：节点隔离保证等级只有 `enforced` 才允许签发正式独立 Proof——`canIssueIndependentProof`（`scripts/node-isolation.mjs:235-239`）要求 `guarantee === ENFORCED` 且节点具备 `independent_proof` 能力，两条各返回一条拒签原因。2026-09-20 产品模式（DSH 3080）真机跑 `wf-explore` 时实测为 `unavailable`（已立 GitHub **#235**，OPEN），导致本次全部专家报告与评估结论**没有一份带独立 Proof**，只在文字上标了"非独立取证"。

🟡 本条只定 UI 需求，**不含 #235 的修复**（为什么 `sandbox-exec` 存在却仍判 unavailable 属诊断票范围）。

需求：

1. Run Detail 的成果与证据视图，必须把证据分成两档呈现：**可签发独立 Proof** / **降级取证（无独立 Proof）**，并给出人话解释这条差别意味着什么（结论未经独立隔离复核，不宜作为正式验收证据）。
2. 降级状态必须在**列表与详情两级**都能被注意到，不能只存在于产物正文的文字标注里——当前正是这种情况，用户从界面看不出这次运行不可作为正式证据。
3. 拒签原因要如实透出（区分"隔离保证等级不足"与"节点未声明 `independent_proof` 能力"），但按 FIX-107 口径转译，不直接抛枚举值。
4. 只读呈现：不新增写入口、不改 Proof 的签发规则、不为降级成果做任何"看起来已通过"的美化。

---

## 5. 缺口台账（2026-09-19 实测复核；R-13/R-14 为 2026-09-20 产品补入的两条输入）

🔴 并行会话已产出另一份 #75 对账表（`docs/tasks/specs/CHORE-113-issue-75-reconcile-closeout/requirements-analysis.md` §2）。两份对 14 项的归属判定大体一致，但在 **"#75 该不该关票"** 上互斥（见 §8），且本表多出 R-2 的 preset 数据错误与 R-10/R-11/R-12 三条。裁定前不得宣称其中任何一份为唯一权威对账。

| 编号 | 缺口 | 复核结论 | 归属 |
|---|---|---|---|
| R-1 | 插件无运行入口 | **修正**：运行能力已在 `wf_run`（宿主工具），缺的是 UI 入口 + 产品裁定；#83 的 Invocation Adapter 层未实现；LOC-015 已裁"发起权归插件、回灌方案不采纳" | 待 DT-01 |
| R-2 | Outcome Preset 无选择器 | 成立，且 `outcome-presets.json` 三条 preset 的 `outcomePath` 全为 `$.verdict`，而正式模板实际用 `$.route`（14 处）/ `$.status`（3 处）/ `$.verdict`（仅 `templates/wf-explore.json:336` 1 处，共 18 个 `outcomePath` 声明）——**照文件做选择器会给用户错默认值**。FEAT-114 已声明不做 Preset 库（其 `task-spec-V1.md:38`），此面**至今无人认领** | 先纠偏（小票），再 DT-02 |
| R-3 | Completion Mapping 无 UI | 成立：`src/client.js` 内 `completionPath` 命中 0；`src/host.js:974` 与四套模板均已声明 | **FEAT-114**（非 #75 切片） |
| R-10 | 编辑器只认单层结果字段路径 | 成立：`routingNameOf`（`client.js:5551-5555`）对多段路径返回空，而校验内核 `validate-core.cjs:123` 允许多层——**面板能力小于契约能力** | **FEAT-114** |
| R-11 | 配置面板三段 → 四段重排 | 目标形态（插入"完成映射"档）未落地 | **FEAT-115**（需先出真机原型） |
| R-4 | 无 Timeline 视图 | 成立，但已在 LOC-016 片1 基线内。⚠️ CHORE-113 判为"已实现（形态与原文不同：三页签 + 完整经过链路弹窗）"——**分歧项**：现有弹窗按节点序不按时间序，不满足 P9/§7 的合并时间线定义 | LOC-016 / 待裁定（见 §8） |
| R-5 | 决策卡 / BLOCKED 无提交续跑 | 成立，已立 FEAT-208（待派工）；FEAT-85 交付的呈现层不动 | FEAT-208 |
| R-6 | OBSERVING 未呈现 | 成立，根因更深：全仓无 `COMPLETED_OBSERVING` 生产者，看板 Completion 筛选按实际 producer 动态生成 → 该值永不出现。⚠️ CHORE-113 已记"产品裁定：v0.1 不做、列为非目标"（2026-09-19）——与本轮把它列为待裁事项相冲突 | 待确认该裁定是否为准（DT-03） |
| R-7 | #54–#57 裁定未入库 | 成立：四票 GitHub `closed=COMPLETED`（2026-08-26T04:46Z），0 评论，`docs/design/` 无裁定记录。CHORE-113 判"无需再判"；本文 §7 采更严格口径（保留裁定依据，供回归时反查） | 本文 §7 记录 |
| R-8 | 看板字段缺口 | 成立：§6 八项约 3.5 项有；缺 current node、last Node Outcome、回退额度 `used/limit`、当前快照修订、最近事件 | #75 切片 S-4（CHORE-113 判其归 LOC-016） |
| R-9 | 权威真空 | 成立：P1–P10 仅在 Issue 评论；规格 §11（`:240`）把 UI 整体推给 #75，`roadmap.md:176` 仍列 Timeline 未做 | 本文即修复 |
| R-12 | #75 §1 探索硬用例已被取代 | 成立：LOC-036（用户 2026-09-16 确认）把探索额度耗尽改为 `INSUFFICIENT` 直接结束、不再转人工；#75 从未记录该取代。**2026-09-20 已裁定为方案 A** | 本文 §2 已标注；是否回写 Issue 归冲突裁定 |
| R-13 | 额度收尾在结局权威里被误显示 | **已钉死（离线注入 + 本轮逐行复核）**：不是"看不出"，而是把已收口的 Run 显示成**「退回修改」**（`client.js:3441` → `zh.json:338`），且完成类型两种 `INSUFFICIENT` 渲染同一句（`zh.json:285`）。区分信号宿主侧已具备（`generate.mjs:1537-1538` 的 `completion.path` + DONE 体的 `budgetUsed`/`maxRounds`/`results`/`history`），**UI 四条全未用** → 纯界面缺陷，无需改宿主 | 本文 §4.6（7 条逐面验收）→ 切片 S-6；真机复验待重装 |
| R-14 | 降级取证在界面上不可见 | 成立：`canIssueIndependentProof`（`scripts/node-isolation.mjs:235-239`）在 `guarantee !== enforced` 时拒签，2026-09-20 产品模式实测 `unavailable`（GitHub #235 OPEN），成果只在产物文字上标"非独立取证"，Run Detail 无档位区分 | 本文 §4.7 → 切片 S-7（呈现需求；根因修复归 #235） |

**跨切片常态约束**：插件载荷贴线运行（现值 289230B / 290816B，余量约 1.6KB，见 `docs/tasks/closeout-20260919-integration-round.md` §遗留与待裁决）。任何新增 UI 切片必须随卡附瘦身评估，不得默认上调预算。

---

## 6. 承载物地图（避免把原型当实现、把已验收当未做）

| 承载物 | 角色 | 纪律 |
|---|---|---|
| GitHub #75 正文 + P1–P10 评论 | 需求与产品规则一手来源 | 规则已搬入本文 §2；Issue 正文不再作为唯一副本 |
| `packages/dsh-visual-workflow/prototypes/ui-workbench/`（`DESIGN.md`、`REVIEW-2.md`，`npm run prototype:ui`） | **视觉与交互权威** | 仍是纸面原型：个人模板/角色/运行记录皆示例，编辑只存内存，**不得作为生产实现直接合入，也不是发布证据** |
| `docs/tasks/handoffs/H1|H2|H3.md` | 一手需求输入（2026-09-17 Codex 产出） | 分别是 FEAT-84 / 85 / 86 的需求来源，不是裁定记录 |
| `docs/design/workflow-manager-v0.1-final-product-spec.md` §11 | 目标规格，UI 推给 #75 | 语义权威；UI 细节以本文为准 |
| `docs/design/blueprint-schema.md` | 字段级契约 | 本文不改字段 |
| `docs/design/outcome-presets.json` | 候选值推荐 | 校验不强制；内容待纠偏（R-2） |
| `docs/tasks/CHORE-113-issue-75-reconcile-closeout.md`（+ `FEAT-114` / `FEAT-115`） | **并行会话的对账与拆票方案**，与本文同源（都读 #75） | 其结论是"#75 降为需求源并关票"，与本文接到的"保留推进"指令互斥 → 见 §8 冲突项，须产品经理裁定 |

🟢 已经落地、**不得重复设计**的：模板库分区、Built-in 只读 + 逐节点 Provider/Model Override、渐进式三段配置面板、Preflight（静态校验 + 探针）、快照只读历史表、Run 看板与三分组详情、PAUSED + Guidance、BLOCKED 恢复卡与决策卡的**呈现**、终态呈现。对应 FEAT-84/85/86/100/101/102/103、FIX-105/107/108（CNB 期已合并）。

---

## 7. 历史 UI Issue 裁定（#54–#57，以及 #3 / #5）

| Issue | 标题要点 | GitHub 事实 | 裁定 | 依据 |
|---|---|---|---|---|
| #54 | 编辑器改为全局居中大尺寸编辑层 | closed=COMPLETED（2026-08-26T04:46:58Z），0 评论 | **已被 FEAT-84 编排台取代（superseded）** | 编辑器已是独立工作区形态（`vwf-editor-dialog`）；本文 §4.2 的渐进式配置规则是其上的产品约束 |
| #55 | 画布默认居中 + 纵向浏览 + 四向拖动 | 同上 | **保留为已交付行为，不再作为活动需求** | `fitView` 存在且刻意不再首帧自动调用（`src/client.js:1012`、`:1028` 注释）；改动该行为按新缺陷/新需求立票，不复活 #55 |
| #56 | 节点、连线与标签防重叠 | 同上 | **保留为已交付行为**；后续视觉调整走原型评审 | 布局能力属 FEAT-84 范围，视觉细节权威在 `ui-workbench` |
| #57 | 顶部操作区按钮与提示文字重叠 | 同上 | **保留为已交付行为** | 顶部操作区随 FEAT-84 / FIX-107 重做 |
| #3 | 早期 VWF 总纲 | closed=Historical/Superseded | **不得再作为当前状态模型依据** | 规格 `:298` 已裁定，本文沿用 |
| #5 | 早期阶段票 | closed | 仅历史背景 | 同上 |

⚠️ 本节的"已交付"结论是**票面事实 + 代码落点**的核对结果，不等于逐条真机视觉复验。若产品验收发现某条实际未达成，按新缺陷立票并回写本表，不重新打开 #54–#57。

---

## 8. 会话间冲突的裁定结果（已决）

曾有两份同日、同源（GitHub #75）的对账得出互斥结论。**产品经理已于 2026-09-21 裁定：以 `FEAT-75` 这侧为准**（原话「以你这边为准，单独分支单独 worktree 来推进」）。据此固定三件事：

| 事项 | 裁定后的口径 |
|---|---|
| #75 存续 | **保留 open 推进**，作为 v0.1 UI/交互架构的伞票与剩余项承接者；`CHORE-113` 的"降为需求源并关票"结论**不予采纳** |
| 权威载体 | **本文**是 UI/交互架构与 #75 缺口对账的唯一落点；`docs/design/issue-75-ui-reconciliation.md`（CHORE-113 计划创建、至今未落盘）不再另建第二份对账权威 |
| 派工面 | #75 派工面 = S-2（preset）、S-4（看板字段）、S-6（额度收尾呈现）、S-7（降级取证可见）+ 挂起的 S-1/S-5；`FEAT-114`（完成映射与多层路径）与 `FEAT-115`（面板四段重排）作为已拆出的施工卡保留 |

**未被本裁定覆盖、仍开放的三件**（各自归属清楚，不因此重开冲突）：

1. Timeline 归属分歧仍然存在：CHORE-113 判"已实现（形态不同）"，本文 §5 R-4 判"合并时间线未交付"，代码依据是 `chainEntries`（`src/client.js:3977-4055`）按模板节点顺序而非时间序。本文按 R-4 口径执行，实施落点仍是 LOC-016 片1。
2. `CHORE-113` 记为"产品（本会话）"的其余两条裁定（**Completion Mapping 不算发布门槛**、**先补能力再重排面板**）未经本轮确认，作为待确认项保留——它们只影响排期顺序与发布门槛，不改变 #75 存续。
3. `CHORE-113` 自身卡面如何处置（收窄为"stale 指向修正 + LOC-036 取代记录"，或按其原范围继续）由该票所属会话与产品决定，**本卡不代裁、不改写他人卡片**。本文已吸收其一项独立发现（LOC-036 取代 #75 §1 硬用例，见 §2）。

## 9. 检查清单（施工卡收口前自查）

- [ ] 是否保持 Outcome / Lifecycle / Completion Type 三层分层，未被 Runtime 控制改写专业 Outcome？
- [ ] 是否引入第二套运行状态或运行历史？（禁止）
- [ ] 内置模板是否仍可被绕过只读边界（含 JSON 页签）？
- [ ] 运行中是否只允许 Provider / Model 修订，并明确"仅影响当前 Run"？
- [ ] 是否存在静默自动换模型？（禁止，P5）
- [ ] 决策卡是否保留原 Outcome、给出选项后果与推荐？
- [ ] 被额度收尾的执行，是否在三处视图给出同一个"被收尾"结局语义（不新增状态机），且能取回原始专业裁决？（§4.6）
- [ ] 降级取证（无独立 Proof）的成果，是否在列表与详情两级都看得见，并如实区分拒签原因？（§4.7）
- [ ] 是否为 #233 / #234 这类功能缺陷设计了 UI？（禁止，见 §1）
- [ ] 是否随卡附载荷瘦身评估？
