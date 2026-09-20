# FEAT-75 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FEAT-75` |
| 远端 issue | GitHub #75（发号源迁移未生效，见下方说明） |
| 需求来源 | github-issue |
| 来源定位 | GitHub [#75](https://github.com/crystepj-max/workflow-manager/issues/75) 正文 + 「第五轮审查结论：P1–P10 全部确认」评论 |
| 任务名称 | 工作流插件 UI / 交互架构定稿（模板库、编辑器、运行入口与 Run 看板） |
| 任务类型 | 设计定稿与需求分析（不含实现） |
| 优先级 | P1 |
| 当前状态 | 定义中（待决策：未决产品事项 4 项，含 1 项会话间冲突） |
| 需求基线版本 | V1（草案，未确认） |
| 前置依赖 | 🔴 **与并行会话 CHORE-113 冲突待裁**（#75 保留推进 vs 降为需求源关票）；DT-00～DT-03 关闭后才可推进「待确认」；实现面依赖 FEAT-114（完成映射/多层路径）、FEAT-115（面板四段重排）、LOC-016 片1（Timeline）、FEAT-208（提交续跑） |
| 施工环境组 | FEAT-75 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 不允许（存在必须产品经理拍板的产品事项） |
| 任务规格位置 | `docs/tasks/specs/FEAT-75-ui-interaction-architecture/`（`requirements-analysis.md` + `definition-check.md` + `decision-tickets/DT-00..03`） |
| 定义时间 | 2026-09-19T12:37:16Z |
| GitHub 同步 | synced#75 |

> 说明（不进机器解析字段）：
> ① **卡号与号段**：登记册现有口径是"卡号数字 = 远端 issue 号"（最近的 FEAT-208 / FIX-108 / CHORE-110 均如此），故本卡取 `FEAT-75` 锚定 GitHub #75。⚠️ 这与既有 `CHORE-75`（remote = `cnb#75 + github#214`）**数字重叠**，是 CHORE-111 / 其 DT-01「GitHub 发号段与本地号冲突」尚未解决的一个具体实例。CHORE-111 当前状态为「待确认」、GitHub #215 仍 OPEN 且 0 评论，**迁移规则未生效**。此处不猜新号：若产品经理希望避开歧义，改名成本在"尚无分支 / PR / 归档"之前最低，请在基线确认时一并裁定。
> ② 本卡不照抄 FEAT-208 的 `GitHub 同步 | #208` 写法——该值违反契约枚举（`pending` / `synced#N` / `not-applicable`），本卡用 `synced#75`。
> ③ 本卡是 **#75 的设计定稿承载**，不是 UI 施工卡；§5 拆出的切片按一片一卡另立。
> ④ 🔴 **会话间冲突（最高优先待裁）**：并行会话已就同一份 #75 立了 `CHORE-113`（状态「待确认」）+ `FEAT-114` + `FEAT-115`，其结论是"#75 降为需求源并**关票**，只拆残余"，与本轮收到的"#75 **保留推进**、UI 剩余项统一由本 Issue 承接"直接互斥。两票不能同时成立，见 `decision-tickets/DT-00-issue-75-fate.md`。本轮不做单方收敛：卡、切片表与架构文档均按"待裁"标注。

## 摘要（三要素速览）

### 任务目标

为 v0.1 workflow 插件给出一份**唯一、可施工、已裁定**的 UI / 交互架构定稿，并消除当前的权威真空：把只存在于 GitHub Issue 评论里的产品规则（P1–P10）与"当前真实运行入口仍是 Skill / Chat"这一事实搬进入库的设计文档；同时对 #75 的 14 项完成标准与本轮复核出的 12 条缺口逐条给出**归属结论**——哪些由 #75 新拆切片承担、哪些已由既有卡（LOC-016 片1 / FEAT-208 / FEAT-114 / FEAT-115 / FEAT-84~108）承接、哪些应显式移出 v0.1。

🔴 前置条件：并行会话对同一份 #75 已给出**相反处置结论**（降为需求源并关票 vs 保留推进），须先裁 `DT-00`，否则本卡的权威地位与切片派工面都不确定。

### 涉及范围

- **做**：
  1. 权威落库：`docs/design/workflow-ui-interaction-architecture.md`（P1–P10 + 运行入口事实 + 信息架构定稿 + 缺口台账 + 承载物地图 + #54–#57 裁定 + 收口自查清单），并在权威链登记；
  2. 缺口复核与归属：对 12 条缺口逐条以 `文件:行号` 取证，判定"本卡新切片 / 既有卡承接 / 移出 v0.1"；
  3. 功能切片划分 S-0…S-5（见下），每片给目标、边界、可否独立 UAT、依赖；
  4. 未决产品事项出决策票 **DT-00（#75 处置：保留推进 vs 降为需求源关票——会话间冲突，最高优先）**、DT-01（插件运行入口 A/B/C）、DT-02（Outcome Preset 呈现深度）、DT-03（OBSERVING 呈现），各附候选方案与成本/收益/风险及推荐；
  5. 记录 #54–#57 与 #3 / #5 的裁定事实（GitHub 已 closed=COMPLETED，仓库内原无记录），以及 #75 §1 探索硬用例已被 LOC-036 取代这一未记录事实。
- **不做**：
  - 不改 `packages/dsh-visual-workflow/src/` 任何运行代码，不动宿主 RPC 契约与持久化格式（本卡零实现）；
  - 不重复设计已落地能力：模板库分区、Built-in 只读 + Provider/Model Override、渐进式三段配置面板、Preflight / 快照表、Run 看板与三分组详情、PAUSED+Guidance、决策卡 / 恢复卡的呈现、终态呈现（FEAT-84/85/86/100/101/102/103、FIX-105/107/108）；
  - 不重做 Timeline 卡（归 LOC-016 片1）、不碰提交续跑（归 FEAT-208）、**不重复立 Completion Mapping / 多层路径卡（归并行会话的 FEAT-114）与面板四段重排（归 FEAT-115）**；
  - 不改产品规格 `workflow-manager-v0.1-final-product-spec.md` 正文、不改 `blueprint-schema.md` 字段、不改 `workflow-design-principles.md`；
  - 不动发号规则与登记册既有条目（等 CHORE-111 生效）；不代其他会话改写 registry 条目；
  - 不在 GitHub 上回填评论、关闭票或改动任何 Issue（对外动作，须另行授权）；
  - **不代裁 DT-00**：不主动关闭或废弃 CHORE-113 / FEAT-114 / FEAT-115 任何一张卡。

### 验收标准

- [ ] **V-1** 权威已落库：`docs/design/workflow-ui-interaction-architecture.md` 存在且被 Git 跟踪，含 P1–P10 全部十条（逐条可检索）与"当前真实正式运行入口仍是 Skill / Chat"一节。判定：`git ls-files` 命中 + `grep -c '^| P' ` ≥ 10。*执行时机：裁决前可观测。*
- [ ] **V-2** 该文档已在权威链登记：`AGENTS.md`「权威资料」小节或 `docs/design/workflow-capability-index.md` 出现指向本文的条目。*裁决前可观测。*
- [ ] **V-3** 12 条缺口（R-1…R-12）每条都有 `文件:行号` 级证据，并明确标注"已实现 / 部分实现 / 未实现"三态之一，无一条只凭 #75 正文推断。判定：`requirements-analysis.md` §2 表格逐行有代码路径。*裁决前可观测。*
- [ ] **V-4** #75 正文的 14 项完成标准全部有归属结论，且每项指向：本文某节 / 某张既有卡 / 某张待立切片 / 显式移出 v0.1。无悬空项。**其中与 CHORE-113 判定不一致的项（至少 Timeline 第 9 项、Observing 第 13 项）必须显式标为"分歧待裁"，不得单方收敛**。*裁决前可观测。*
- [ ] **V-5** 每个新切片（S-0…S-5）都具备目标 + 边界 + 可验证验收条件，都标注了是否受载荷预算（289230B/290816B）与 FEAT-114 / FEAT-115 / LOC-016 / FEAT-208 依赖，都能独立 UAT。*裁决前可观测。*
- [ ] **V-6** DT-00～DT-03 每张票都含：必须决定什么、候选方案与成本/收益/风险、推荐及理由、关闭判据；且 Definition Check 的 9.3 与未决事项计数与票状态一致（票未关 → 不得标「待确认」）。*裁决前可观测。*
- [ ] **V-7** #54–#57 的裁定已入库成表（含 GitHub 事实、裁定、依据），并给出"若验收发现实际未达成"的处置路径。*裁决前可观测。*
- [ ] **V-8** 产品经理可用 `npm run prototype:ui` 现物确认信息架构：原型可打开，且本文 §4 各节所指界面在原型中有对应可点击形态。*执行者：产品经理；结果回填 UAT 卡「收口后复核」区。执行时机：收口后观测（本卡不实现界面，无法在裁决前真机验证定稿效果）。*
- [ ] **V-9** DT-00～DT-03 全部关闭后，Definition Check 未决产品事项归零，本卡推进为「待确认」→ 人工确认后「已定义」；本卡派工面内的切片各自立施工卡并在登记册/看板登记，`npm run validate:task-context` 绿。*执行者：基线确认后的拆票会话；回填位置：各施工卡 + 收口摘要。执行时机：收口后观测；失败处置：如实记录，不静默跳过。*
- [ ] **V-10** 🔴 DT-00 有明确裁定结果，且裁定后一次性收敛：本卡与 CHORE-113 只留一份 #75 对账权威，两卡的 registry 状态与架构文档 §8 同步更新；不出现两张互相否定的活动卡。*执行时机：裁决前可观测（它是本卡进入「待确认」的入口条件）。执行者：产品经理裁定 + 收口会话回写。*

## 功能切片划分（定稿后另立施工卡）

| 切片 | 内容 | 依赖产品决策 | 技术依赖 | 可独立 UAT | 建议优先 |
|---|---|---|---|---|---|
| S-0 | 权威落库 + 缺口归属 + 裁定记录（**本卡范围，已完成草案**） | 否（冲突裁定只影响其存续，见 DT-00） | 无 | 是（读文档即可判） | P1 |
| S-1 | 运行入口落地（若 DT-01 选 B/C 才存在；选 A 则本切片取消） | DT-01 | 需先探路宿主是否提供"从插件唤起 Skill 会话"能力（本轮未取证） | 取决于 DT-01 | — |
| S-2 | Outcome Preset：**先纠偏 `outcome-presets.json` 的 `$.verdict` → 实际路径（14 `$.route` / 3 `$.status` / 1 `$.verdict`）**；再按 DT-02 决定是否加选择器 | DT-02（纠偏部分不需要） | 纠偏是数据级，可即刻做；FEAT-114 已声明不做 Preset 库，此面目前**无人认领** | 是 | P1（纠偏）/ P2（选择器） |
| ~~S-3~~ | ~~Completion Mapping 编辑 UI~~ → **已由并行会话立为 `FEAT-114`**（含多层结果字段路径，即 R-10） | 否 | 契约与运行时已全通（`host.js:974` + 四模板已声明），纯客户端 | 是 | **不由 #75 派工**；已裁"不算 v0.1 发布门槛" |
| S-4 | Run 看板字段补齐：current node、last Node Outcome、回退额度 `used/limit`、当前快照修订、最近事件 | 否 | 字段宿主侧已回传（`host.js:715`、`:690`），只读投影 | 是 | P2；⚠️ 与 LOC-016 片1 的归属需一并裁定（见 V-4） |
| S-5 | OBSERVING 呈现（若 DT-03 选 B/C） | DT-03 | 无 producer，需先补模板/契约侧生产者 | 取决于 DT-03 | CHORE-113 记为已裁"v0.1 非目标" |
| （归他人） | 编辑器配置面板三段 → 四段重排（R-11） | — | **FEAT-115**（需先出真机原型） | 是 | 由 #115 派工 |
| （归他人） | Timeline 合并时间线 | — | **LOC-016 V2 片1**（已本地已定义，未开工） | 是 | 由 LOC-016 派工 |
| （归他人） | 决策卡 / 恢复卡提交续跑闭环 | — | **FEAT-208**（已本地已定义，待派工） | 是 | 由 #208 派工 |

先后建议：S-0 → S-2 纠偏 → S-4。S-2/S-4 无产品决策依赖、可与 FEAT-114 并行；S-1 / S-5 在对应 DT 关闭前不排期；Timeline 与续跑不在 #75 派工面内，避免与 LOC-016 / FEAT-208 / FEAT-114/115 抢同一文件（`client.js` 的编辑器面板与 Run Detail 区是三方的共同改动点）。

## 关键证据

- 运行工具与起跑：`packages/dsh-visual-workflow/src/host.js:3075`（`wf_run` 注册）、`:3456`（`engineNow.start`）；Skill 口径统一见 LOC-015（`docs/tasks/LOC-015-skill-invocation-runtime.md`，commit `6e8bd5f`，registry 状态「已合并」而卡面「等待验收」——按仓库口径以卡面为准）。
- UI 无运行入口：`src/client.js:5194-5198`。
- `invocation` 在 `src/` 零命中；`completionPath` 在 `src/client.js` 零命中、在 `src/host.js:974` 生效。
- Preset 与模板不符：`docs/design/outcome-presets.json`（三条均 `$.verdict`）vs `templates/*.json`（18 个声明：`$.route` 14 处 / `$.status` 3 处 / `$.verdict` 仅 `wf-explore.json:336`）。
- 时间线缺失：`src/client.js:3977-4055`（`chainEntries` 按节点序）、`:4260-4292`（"完整经过"弹窗）。
- 权威真空：`docs/design/workflow-manager-v0.1-final-product-spec.md:240`（§11 推给 #75）、`roadmap.md:176`。
- #54–#57：GitHub `closed=COMPLETED` 2026-08-26T04:46Z，0 评论。
- 编辑器现状三段 / 目标四段：`client.js:2106-2112`（`InspectorTabs` 三档）+ 其注释 `:361`"配置栏三段 tab（V-11）"；单层路径限制 `client.js:5551-5555`（`routingNameOf` 多段返回 `''`）vs 内核允许多层 `scripts/validate-core.cjs:123`。
- 冲突对象：`docs/tasks/specs/CHORE-113-issue-75-reconcile-closeout/task-spec-V1.md` §12（"#75 降为需求源并关票"，确认人记"产品（本会话）"，2026-09-19）与其 `requirements-analysis.md` §2 十四项对账表；`FEAT-114` / `FEAT-115` 已在 registry（status 定义中，remote cnb#114/#115）。
- LOC-036 取代 #75 §1 探索硬用例：`scripts/generate.mjs:840-846`（探索专属分支）先于 `:855` 通用 `haltWaitingHuman(..., 'MAX_ROUNDS_REACHED')`；`scripts/validate-core.cjs:642` 限定仅 `wf-explore` 可声明；`docs/tasks/specs/LOC-036-exploration-coverage/task-spec-V1.md:117`（用户 2026-09-16 确认）。

## 关联

`docs/design/workflow-ui-interaction-architecture.md`（本卡的定稿产物）；GitHub #75 / #76（已关）/ #79 / #83（已关）/ #208 / #215；`docs/tasks/LOC-015-*.md`、`LOC-016-*.md`、`FEAT-208-*.md`、`CHORE-111-*.md`、`closeout-20260919-integration-round.md`；**冲突待裁**：`CHORE-113-issue-75-reconcile-closeout.md`、`docs/tasks/specs/FEAT-114-editor-completion-mapping-paths/`；`FEAT-115`（面板四段重排）仅 registry 有条目，任务卡与规格目录尚未创建。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-19T12:37:16Z | 定义中（待决策） | 需求分析基线 V1 草案落盘：权威文档入库、9 条缺口带证据复核、S-0…S-5 切片划分、DT-01～DT-03 未决产品事项 3 项。Definition Check 9.3 未通过（未决 > 0），按契约禁止标「待确认」，呈递产品经理裁定 |
| 2026-09-19T12:55:50Z | 定义中（待决策，含冲突） | 发现并行会话已就同一份 #75 立 `CHORE-113`（待确认）+ `FEAT-114` + `FEAT-115`，其结论"#75 降为需求源并关票"与本轮"保留推进"指令互斥 → 新增 **DT-00**；缺口由 9 条增至 12 条（补 R-10 单层路径、R-11 四段重排、R-12 LOC-036 已取代 #75 §1 探索硬用例，均已自行复核代码）；S-3 撤销（归 FEAT-114），S-4 归属需与 LOC-016 一并裁定；修正本文原稿把编辑器写成"三层"的口径（实为三段 tab，目标四段）。未决产品事项 4 项 |
