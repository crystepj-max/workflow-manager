# DT-01 · 轻量路线的验收签署以什么形态记录（决策票）

| 项 | 值 |
|---|---|
| 类型 | 决策票（方案选择影响契约语义，需人工裁定） |
| 状态 | **closed · 已裁定**（2026-09-19 松哥裁定，见下方「裁定结果」） |
| 阻塞 | ~~阻塞 CHORE-110 开工~~ → 已解除，本票的两项开放项均有明确决定 |
| 建立 | 2026-09-19（CHORE-110 立项） |
| 口径收敛 | 2026-09-19 独立开工会话复核实测后重写：原稿的单一因果链与成本估算不成立，见 §实测成因分布 |
| 裁定人 | 松哥（产品经理） |
| 对应规格 | `docs/tasks/specs/CHORE-110-acceptance-package-schema/task-spec-V1.md` §3.1 / §7 / §9 |
| 分析依据 | `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md` 第三节第 3 条 |

---

## 裁定结果（2026-09-19，人工决定）

| 待裁项 | 裁定 | 落定含义 |
|---|---|---|
| 主方案 | **A · 验收包分层**，取 **b3「按实际证据分层」** 为落地形态 | 同一 `acceptance_package` 类型内按本 Run 盘上**实际存在的记录**决定该引哪些；**不采用**「会话自报路线」，故不引入 b1/b2 的路线字段与路线定义 |
| 子问题 a（范围） | **并入本票一起修** | 本票范围从「schema 放开」扩为「验收签署可追溯性」：含摘要在签收后刷新、按任务标识自动关联 Run、无验收包时显式标记而非静默 null；并须修复 CHORE-36 / LOC-032 / LOC-033 三例存量摘要 |

随附子问题由本裁定一并确定：

- **b（判据）**：取 b3，分层判据 = 盘上记录有无，可机检，无自报后门。
- **c（命名）**：新字段**不得**叫 `route`（该键已表示节点下一跳）。
- **d（签署凭据）**：轻量档 `decided_by` 须带可核对来源，禁 AI 代签。
- **e（版本兼容）**：改动做成**纯放宽**（历史记录全部继续合法），故 `record_version` 的 `const:"v0.1.8"` **不前移**——避免盘上 211 条 index 内记录与 7 个 examples 失效。
- **f（规则副本）**：施工时实测修正——`formal-records.mjs:50-56` 的五类清单只是「存在即链接」（唯一消费点 L340-344），不是必填闸门，故**不改代码**；仅新增防分叉断言（规格 §7.3）。

## 背景（为什么必须决定）

`acceptance_package` 的 `assembled` 是**必填**，且强制五类前置记录引用（baseline / design / dev_handoff / review_proof / test_proof）+ `integration_checkpoint`（`handoff.schema.json:590-607`，`assembled` 为 `additionalProperties:false`）。产不出这些引用就登记不了验收包，归档证据摘要里的 `decision` / `decided_by` / `decided_at` 便为 null——而 `.agent-runs/` 是 gitignore 且按 7 天保留期清理（`scripts/task-runs-cleanup.mjs`），**归档摘要是签署的唯一永久层**。

要决定的核心问题：**验收这个动作，应该以什么形态被记录下来，才能事后回答「谁在什么时候验收了什么」。**

必须挡住的坏解法：为「凑齐」必填项伪造 `review_proof` / `test_proof`（等于伪造独立评审，比缺字段严重）；以及为「填上」`decided_by` 由 AI 代签（契约 §5 L201、§8.3 明文禁止）。

## 实测成因分布（2026-09-19，51 个已归档任务全量核对）

核对方式：逐个比对 `docs/tasks/archive/*/evidence-summary.json` 与 `.agent-runs/<run_id>/acceptance_package*.json` 实际内容。

| # | 成因 | 数量 | 属本票题域？ | 代表样本 |
|---|---|---|---|---|
| 0 | 签署已正常落档 | 14 | — | FIX-72（`decided_by=松哥`）、LOC-008~031 多数 |
| 1 | **Run 在盘、确实没有验收包记录** | **6** | ✅ 是（schema 阻塞） | CHORE-106、LOC-037/038/041/042/045 |
| 2 | **验收包已 `decided`，但摘要是签收前生成的旧快照** | **1** | ❌ 否（工具时序） | CHORE-36：`acceptance_package.a3.json` 实为 `status=decided / decided_by=松哥`；摘要 `generated_at=2026-09-16T13:53Z` 读到的是 `awaiting_decision` |
| 3 | **验收包已 `decided`，但摘要未关联 Run（`run_id=None`）** | **2** | ❌ 否（收口口径） | LOC-032（`a3` decided/松哥）、LOC-033（`a2` decided/松哥） |
| 4 | 有验收包但从未 `decided`（含 `awaiting_decision`、以及不合规写入导致 payload 无 `status`） | 8 | ❌ 否（多为真未验收） | feat-85、loc-035/040/043/044 |
| 5 | 先于 Run 机制落地 / 远程收口且盘上无 Run 目录 | 20 | ❌ 否（历史，规格 §5 不追溯） | LOC-001~007、FIX-65/66/69、CHORE-37/38 等 |

**两个推翻原稿的结论：**

1. **schema 放开只覆盖 6/51。** 另有 3 个任务（成因 2、3）**人的签署其实已经发生并在盘上**，是永久层没取到——这类丢失与走哪条路线无关，**正式路线同样会踩**。只改 schema 不解决它，且 `.agent-runs/` 一过保留期就永久不可恢复。
2. **「轻量 = 只有 dev_handoff、缺 review/test」这个画像对不上实测。** 6 例里缺失项各不相同：

   | 任务 | 盘上已有记录 | 缺哪些引用 |
   |---|---|---|
   | CHORE-106 | dev_handoff | 缺 baseline / design / review / test |
   | LOC-037 | baseline、dev、review(a2)、test(a2) | **仅缺 design_package** |
   | LOC-038 | baseline、design、dev、test | **仅缺 review_proof** |
   | LOC-041 | baseline、dev、test | 缺 design / review |
   | LOC-042 | 仅 `release-event.json` + conformance-report | 缺全部五类 |
   | LOC-045 | baseline、dev、review(a1)、test(a1) | **仅缺 design_package** |

   → 原稿 A 方案「轻量变体只需 `dev_handoff_ref`」对 6 例中的 4 例是**过度放宽**（它们本来能提供 3~4 类）。分层判据不能粗到「一刀只认 dev_handoff」。

## 方案

| 方案 | 做法 | 真实成本（核对代码后） | 收益 | 风险 |
|---|---|---|---|---|
| **A · 验收包分层** | 同一记录类型内分「重 / 轻」两套 `assembled` 必填集，轻量套强制 `decided_by` / `decided_at` | **高于原稿的「中」**：`handoff.schema.json`（`assembled.additionalProperties:false` 须加字段 + `oneOf` 分支）、`cwf-evidence-verify.mjs:59-176`（九项校验按套分支）、**`formal-records.mjs:50-63` 的 `PORTABLE_PREDECESSORS` 是五类规则的第二份硬编码副本，必须同改否则分叉**、契约 §3.6/§8.3、examples 06、测试 | 直接命中根因；正式路线标准不降；签署人留痕恢复 | 🔴 **「路线标识」在本仓无任何权威来源**（见子问题 b），若由写记录的会话自报＝自助绕过独立评审的后门 |
| **B · 独立轻量记录类型** | 新增 `acceptance_note` 等类型，只记签署人 / 时间 / 结论 / 依据清单 | 中高：`cwf-record.mjs:19-27` `RECORD_TYPES` + schema 根 `record_type` enum 与根 `oneOf` 新分支（`run.stage` 仍须落在既有 7 值内）+ `workspace-evidence-summary.mjs:28-44` `KEY_FIELDS`/`RECORD_ORDER`（现仅从 `acceptance_package` 取三字段）+ `formal-records.mjs` 映射 + 契约 §8.1 表 | 不动正式契约，改动隔离 | 两套「验收」概念并存，长期语义分叉（LOC-016 同型教训） |
| **C · 不放宽，改口径** | 契约写死：轻量路线不产生结构化签署；摘要三字段以显式「不适用」值标记并附原因 | 低：契约说明 + `workspace-evidence-summary.mjs:125-127` 取值 | 立即消除「静默 null」的误导 | **放弃**「谁验收的」可追溯性，把审计缺口制度化；而本批任务恰恰走轻量路线 |

> 三案共同点：**都不解决成因 2、3**（那是永久层取值时机/关联问题，不是 schema 问题）。是否一并处理见子问题 a。

## 必须与主方案一并裁定的子问题

- **a · 范围**：成因 2、3（已发生签署被永久层丢失，3 例，且随 `.agent-runs/` 清理而不可恢复）是否并入本票？不在 `FIX-109` 范围内（其两处缺口是 `merge_commit` 回写时机与「涉及范围」正则，且明文不改验收包/摘要 schema）。注意修点在 `workspace-evidence-summary.mjs` + 收口调用时机，与 `FIX-109` 都改 `local-task-merge.mjs` 存在同文件协调点。
- **b · 路线标识由谁断言（选 A 才需要）**：`templates/` 只有 1 个 construction 蓝图（`wf-construction-full-feature.json`，含 review/test 节点）；`run.json`（`cwf-run-init.mjs:190-203`）无路线字段；任务卡 14 个机器字段（`task-card-parse.mjs:8-22`）无路线；契约与 `dsh/skills/construction-bootstrap/runbook.md` §3/§4/§6 **从未允许跳过 review/test 记录**。候选权威来源：**b1** 登记册新增显式「交付路线」字段、定义阶段由人工勾选、校验器从登记册读；**b2** 按任务类型推断（CHORE/FIX＝轻、FEAT＝重），机器可读已有但属新业务规则；**b3** 不用「路线」概念，改为**存在性分层**——引用有则必引必校验、无则必须显式声明缺失原因且缺独立评审须记人工知情批准（我倾向此形，见推荐）。
- **c · 命名**：`route` 键在建设记录里已表示**节点下一跳**（`loc-035/040/044` 的验收包 payload 带 `route=READY_FOR_HUMAN`；`construction-preflight-gate.mjs:54,64` 输出 `route=PASS|BLOCKED`）。新字段若同名必致二次歧义，须用 `delivery_route` / `evidence_tier` 等区分名。
- **d · 签署凭据**：轻量路线下 `decided_by` 由 Agent 依会话中人工「通过」写入。契约禁 AI 代签，故须规定可核对形式（例如同时落人工确认所在位置/收口报告条目），否则新字段比 null 更糟——不可核对的断言。
- **e · 向后兼容（已入库记录不得失效）**：`record_version` 现为 `const:"v0.1.8"`（`handoff.schema.json:22-24`），盘上 **453 条**记录与 **7 个** examples 全为该值；`cwf-record.mjs:88` 写入时直接取该 const，而 `schema-protocol.test.mjs:113-119` 用当前 schema 校验 examples。若为语义变更须前移版本，须同时决定：保持 const 并同步改 examples/测试，还是 const→enum 接受旧值。A 若以「新增可选字段＋`oneOf` 变体」实现，旧记录可继续合法。
- **f · 规则副本**：`formal-records.mjs:50-56` 也列了五类，但实测为「存在即链接」而非闸门（定义初稿曾把它当成第二份硬编码闸门，已修正）；仍需一条防分叉断言，防日后被收紧成必填。

## 推荐

**主方案 A，并以 b3「存在性分层」作为其落地形态；范围问题 a 建议并入本票。** 理由：

1. **对症且不引入自报后门**——`assembled` 必填集 = 本 Run 盘上实际存在的记录，有无是可机检的事实，不需人工先定义「什么算轻量路线」。
2. **不降低正式路线**——五类齐全的 Run 自然落入五类分支，校验一字不改。
3. **顺带保住真已发生的签署**——成因 2、3 那 3 例说明最紧的风险不是「轻量路线登记不了」，而是「签署已发生却在永久层丢失」；不补这一环，选了 A/B 之后新任务仍会照样丢。
4. 若选 C，成因 1 与 2/3 都无解，等于承认「这批任务不可追溯」。

> B 仍然可行，但代价是「验收」在契约里出现两个并行名字，且证据摘要取值需新增分支（`workspace-evidence-summary.mjs` 现在只认 `acceptance_package`）。

## 共同底线（不随方案变化）

1. 明文**禁止**为满足校验伪造 `review_proof` / `test_proof` 或冒充独立评审。
2. 禁止 AI 代签；`decided_by` 须有可核对来源（子问题 d）。
3. 轻量路线的签署**要么可追溯到人，要么显式标记不适用**，不得静默 null。
4. 正式路线的五类引用强制校验**不得放宽**。
5. 已入库记录（`record_version=v0.1.8`：盘上 453 个带该字段的记录文件，其中各 Run `index.json` 索引内 211 条）不得因本次改动失效（子问题 e）。
6. 缺独立评审而仍登记验收，须留下「人工知情批准」痕迹，不得默认允许跳过。

## 待裁定（已全部裁定）

- [x] **主方案**：**A · 验收包分层**，落地形态取 **b3 存在性分层**（判据＝盘上记录有无，不由会话自报路线）。
- [x] **范围 a**：**并入本票**——已发生签署不得因摘要快照过期/未关联而丢失，含 CHORE-36 / LOC-032 / LOC-033 三例存量摘要修复。

本票已关闭。规格 §7 按本裁定落定施工口径，定义门两项开放项随之清零。
