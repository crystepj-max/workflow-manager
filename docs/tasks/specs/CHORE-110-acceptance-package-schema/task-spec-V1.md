# 轻量路线验收包可登记性：acceptance_package schema 放开与签署人留痕

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 远端锚点 | cnb#110（编号由 CNB 发号） |
| 优先级 | P2 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 定义时间 | 待人工确认 |
| 当前状态 | 定义中 |

## 1. 需求背景

2026-09-19 在 CHORE-106 收口过程中，实测发现：**走轻量路线完成的任务，验收签署记录无处可落。** 归档证据摘要里的 `decision` / `decided_by` / `decided_at` 三个字段恒为 `null`——不是没验收，而是验收这个动作**在机器可读的记录里不存在**。

三个字段里 `decided_by` 与 `decided_at` 回答的是「**谁**在**什么时候**签的字」。这是审计链上最不可再生的一环：代码可以重跑，测试可以重跑，但「当时是谁确认通过的」一旦没记下来，就永久丢失，且事后无法补记（补记即为伪造）。

## 2. 用户问题

**验收证据链在轻量路线上是断的。** 正式路线的任务会把验收包记进 Run 证据链，收口时校验引用、归档留痕；轻量路线因为不产生独立评审 / 测试记录，**无法登记正式验收包**，于是：

- 归档摘要里签署人字段为空 → 事后无法回答「这笔是谁验收的」；
- 收口报告虽然写了「验收通过」，但那是**自由文本**，不是带签署人的结构化记录；
- 本批任务（CHORE-37 / 38 / 106 等）全部走这条路线 → 断链不是个例，是**常态**。

同时要防止反向的坏解法：为了「凑齐」五类引用而伪造 `review_proof` / `test_proof`——那比缺字段更严重（等于伪造独立评审）。因此本票要的不是「想办法填满必填项」，而是**厘清轻量路线的验收应当以什么形态被记录**。

## 3. 现状（实测证据）

| 层 | 现状 | 证据 |
|---|---|---|
| schema | `assembled` 为**必填**，且强制五类前置记录引用 + `integration_checkpoint`，`additionalProperties: false` | `docs/design/construction-workflow/handoff.schema.json` → `acceptancePackagePayload.required = ['status','assembled']`；`assembled.required` = baseline / design / dev_handoff / review_proof / test_proof + integration_checkpoint |
| 契约 | §8.3 明文要求 `assembled` 含五类引用，并逐条校验（同 Run、`produced_by` 交叉独立、`verified_head` 一致等） | `docs/design/construction-workflow-portable-contract.md` L332 |
| 记录机制 | `acceptance_package` **已是合法记录类型**，且已实现 `awaiting_decision → decided` 状态机与「不得改写已呈递 assembled」约束 | `scripts/cwf-record.mjs` L25（`RECORD_TYPES`）、L139–L147、L230–L232 |
| 轻量路线现实 | 无独立评审 / 测试节点 → `review_proof` / `test_proof` 不存在 → 登记被 schema 拒绝 | 本批任务 Run 目录实测：仅 `dev_handoff` 一类记录（如 `.agent-runs/chore-106-r1/`） |
| 直接后果 | 证据摘要三字段恒为 null | `scripts/workspace-evidence-summary.mjs` L125–L127；实测 `docs/tasks/archive/CHORE-106/evidence-summary.json` 与 `CHORE-37` 均为 `null` |

### 3.1 实测更正（2026-09-19 独立开工会话全量核对 51 个已归档任务）

上表的因果链**只覆盖一部分事实**。逐个比对 `docs/tasks/archive/*/evidence-summary.json` 与 `.agent-runs/<run_id>/acceptance_package*.json` 后，三字段为 null 的 51 个任务实际分成五类成因：

| 成因 | 数量 | 是否属本票题域 |
|---|---|---|
| Run 在盘、确实没有验收包记录（schema 阻塞） | **6** | ✅ 是 |
| 验收包已 `decided`、人是真签的，但摘要是签收前生成的旧快照 | **1**（CHORE-36） | ❌ 否（取值时机） |
| 验收包已 `decided`、但摘要未关联 Run（`run_id=None`） | **2**（LOC-032、LOC-033） | ❌ 否（收口关联） |
| 有验收包但从未 `decided`（含不合规写入导致 payload 无 `status`） | 8 | ❌ 否（多为真未验收） |
| 先于 Run 机制落地 / 远程收口且盘上无 Run 目录 | 20 | ❌ 否（历史，§5 不追溯） |

两点后果：

1. **schema 放开只解决 6/51。** 另有 3 例签署**已经发生且记录仍在盘上**，是永久层没取到；`.agent-runs/` 按 7 天保留期清理（`scripts/task-runs-cleanup.mjs`），而摘要是签署的唯一永久层（`workspace-evidence-summary.mjs:3-6`），过期即永久不可恢复。该失效与路线无关，正式路线同样会踩。是否并入本票＝`DT-01` 子问题 a。
2. **「轻量＝只有 `dev_handoff`、缺 review/test」的画像不成立。** 6 例缺失项各不相同：CHORE-106 只有 dev_handoff、LOC-042 五类全无，但 LOC-037 / LOC-045 **仅缺 design_package**、LOC-038 **仅缺 review_proof**、LOC-041 缺 design/review。→ 任何「轻量套只认 `dev_handoff_ref`」的分层对其中 4 例是**过度放宽**。

> 关键判断（修正后）：**缺的不是记录类型，而是必填结构与真实证据构成不匹配。** 但「填上 schema」不等于「签署可追溯」——永久层取值时机与关联同属断链成因。完整分析见 `decision-tickets/DT-01-lightweight-acceptance-record.md`。

## 4. 目标

1. 契约层给出**明确且唯一**的答案：轻量路线的验收签署以什么形态记录、落在哪里。
2. 走轻量路线完成一笔实际任务后，归档摘要的 `decided_by` / `decided_at` **有确定取值**（真实的签署人与时间；若裁定「轻量路线不做签署留痕」，则须以显式的确定值表明不适用，而非静默 null）。
3. 杜绝为满足 schema 而伪造独立评审 / 测试记录的做法——契约须明文禁止。

## 5. 非目标

- 不改动收口脚本的两处口径缺口（由 `FIX-109` 承接）。
- 不改动 `delivery-closeout-host.mjs` 与 WR-014 适配层的动作实现。
- 不改动 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进）。
- 不追溯补齐历史任务（含本批已归档任务）的验收签署——事后补记等同于伪造，只在**向后**生效。
- 不降低正式路线的证据标准：五类引用的强制校验对正式路线保持不变。

## 6. 修改前

| 位置 | 现状 |
|---|---|
| `handoff.schema.json` | `acceptancePackagePayload.required = ['status','assembled']`；`assembled.required` 六项全为必填 |
| `portable-contract.md` §8.3 | 仅描述正式验收包一种形态，未给轻量路线的登记口径 |
| `workspace-evidence-summary.mjs` | 三字段直接取自验收包记录，无记录即 null，且无「不适用」的区分 |
| 实测归档 | CHORE-106 / CHORE-37 的 `evidence-summary.json`：`decision / decided_by / decided_at` 全为 null |

## 7. 修改后

按 DT-01 裁定（**A · 验收包分层，取 b3 存在性分层**；范围**并入**摘要修复）落定施工口径。

### 7.1 schema：`acceptancePackagePayload.assembled` 纯放宽

| 项 | 改后 |
|---|---|
| `assembled.required` | 由六项收窄为 **`["dev_handoff_ref", "integration_checkpoint"]`**（dev_handoff 是任何路线必产的记录；checkpoint 仍可机检 HEAD 前进） |
| 四类引用 | `requirements_baseline_ref` / `design_package_ref` / `review_proof_ref` / `test_proof_ref` 改**可选**，描述注明「本 Run 未产生该记录时须在 `evidence_gaps` 声明」 |
| 新增 `assembled.evidence_gaps` | object，`additionalProperties:false`，四个可选键（`requirements_baseline` / `design_package` / `review_proof` / `test_proof`）；每个值为 `{reason, acknowledged_by, acknowledged_at}` 三项全必填 |
| 条件约束 | 四类未全在 ⇒ `evidence_gaps` 必填且 `minProperties:1`；四类全在 ⇒ `evidence_gaps` 须 `maxProperties:0` |
| 状态机 | `awaiting_decision` ↔ `decided` 的 `oneOf` 与 `decided` 必填 `decision/decided_by/decided_at/verified_branch/verified_head` **一律不动**——轻量档同样必须真人签收才能落 `decided` |
| `additionalProperties:false` | 保留（新字段进 `properties`） |
| 🔴 `record_version` | **不前移**，保持 `const:"v0.1.8"`。本改动为纯放宽，五类齐全的旧记录与 7 个 examples 全部继续合法；前移会使盘上 453 个记录文件（`index.json` 索引内 211 条）校验失效 |

> 字段命名不得用 `route`（本仓已表示节点下一跳）。

### 7.2 机器校验：`scripts/cwf-evidence-verify.mjs` 按记录有无分支

- **present** 的引用：原九项校验一字不改（类型/Stage 映射、同 Run lineage、`verified_head` 与实况一致、baseline confirmed 无 gaps、design 已决、dev `handoff_ready`、验收映射完整、review/test 异源）。
- **absent** 的引用：必须有对应 `evidence_gaps` 条目，且 `reason` 非空、`acknowledged_by` 非空且 **≠ 本验收记录 `produced_by`**（契约 §5 禁 AI 代签的机检形式）、`acknowledged_at` 为合法时间。
- ②「review approve 且 test pass」只对**实际存在**的 proof 生效；缺 proof 时改由「人工知情批准」承担该责任，不得因缺记录而判失败。
- **精确配对**：`evidence_gaps` 键集合必须与「缺失引用集合」**完全相等**——多报（声明缺失但其实有）与漏报（缺失但未声明）都判失败。

### 7.3 规则副本核对：`scripts/formal-records.mjs`（施工时实测后收窄）

`PORTABLE_PREDECESSORS.acceptance_package`（L50-56）虽列了五类，但唯一消费点 L340-344 是**存在即链接**（`if (rev !== undefined) dependencies.push(...)`），不构成必填闸门，全仓再无第二处消费——故本项**不改代码**。定义阶段把它记作「第二份硬编码闸门」属**高估**，此处如实修正（连带修正 §9.1 方案 A 的成本行与 DT-01 子问题 f）。仍新增一致性断言测试：轻量档验收包经 `formal-records` 映射时不得因缺 review/test 被判前置缺失，防日后有人把它收紧成闸门造成分叉。

### 7.4 摘要层：`scripts/workspace-evidence-summary.mjs`（范围并入项）

| 缺陷 | 修法 |
|---|---|
| 未关联 Run 即静默 null（LOC-032 / LOC-033） | 未显式传 `--run-id` 时，按 `taskId` 归一匹配 `.agent-runs/*/run.json` 的 `issue_or_task_identity` 自动解析；**唯一命中**才用，多命中报错不猜 |
| 快照早于签收生成后不再刷新（CHORE-36） | `cwf-record.mjs write` 落盘 `acceptance_package` 且 `status=decided` 时，若主检出已有该任务归档摘要则重新生成（task_id 由 `run.json.issue_or_task_identity` 解析）；尚未收口则跳过并说明 |
| 静默 null 无原因 | 新增 `acceptance_state`：`decided` / `awaiting_decision` / `not_registered`，非 `decided` 时附 `acceptance_note` 说明成因。`decision` / `decided_by` / `decided_at` 三字段语义与类型**不变**，避免打断 `validate-workspace.mjs` D-8 与既有归档断言 |
| 存量三例 | 对 CHORE-36 / LOC-032 / LOC-033 重新生成摘要，取到盘上已存在的真实签署值（**这是让永久层读到已发生的签署，不是事后补记**） |

### 7.5 契约与分发

- `construction-workflow-portable-contract.md`：§3.6 输入由「五类记录」改为「五类引用或其缺失声明」；§8.3 `acceptance_package` 段同步，并**明文禁止**为通过校验伪造 `review_proof`/`test_proof` 或冒充独立评审；§9.3 加修订行，说明 `record_version` 保持 v0.1.8 的理由。
- `docs/design/construction-workflow/examples/`：新增一个轻量档验收包示例（缺 review/test + 已知情批准），原 06 号（五类齐全）保持有效作反例锚。
- skill 分发副本：`scripts/sync-ai-task-skill-set.mjs:86` 会把 schema 与契约复制进 `construction-bootstrap` 的 assets，改完须重跑同步并核对哈希一致。

### 7.6 共同底线（不随方案变化，已随裁定固化进 §7.1–§7.5）

1. 契约须明文**禁止**为满足校验而伪造 `review_proof` / `test_proof` 或冒充独立评审。
2. **禁止 AI 代签**；`decided_by` 与 `evidence_gaps.*.acknowledged_by` 须有可核对来源，不得由 Agent 自行断言。
3. 轻量路线的验收签署**必须可追溯到人**（真实的 `decided_by` 与 `decided_at`），或被显式标记为「未登记」并附原因；静默 null 一律消除。
4. 正式路线的五类引用强制校验**不得放宽**（五类齐全时 `evidence_gaps` 必须为空）。
5. **已入库记录不得失效**：`record_version` 保持 `const:"v0.1.8"`，盘上 453 个记录文件与 7 个 examples 在改动后仍须通过校验。
6. 缺独立评审仍登记验收的，须留下「人工知情批准」痕迹，不得默认允许跳过。

## 8. 验收标准

1. 契约层明确轻量路线登记验收签署的唯一入口与字段形态，且与正式验收包不冲突（或统一、或显式区分），并写入 `docs/design/construction-workflow-portable-contract.md` 与 schema。
2. 走轻量路线完成一笔实际任务后，其归档 `evidence-summary.json` 的 `decided_by` 与 `decided_at` 非 null（或为裁定方案定义的「不适用」确定值，而非静默 null）。
3. `cwf-record` / `cwf-validate` 对轻量路线验收记录的校验行为与契约一致，不再出现「因缺五类前置引用而无法登记」。
4. 契约中存在明文禁止伪造独立评审 / 测试记录的条款。
5. 既有测试全绿，新增用例覆盖轻量路线的登记与校验路径。
6. **向后兼容回归**：已入库记录（`record_version=v0.1.8`）与 `docs/design/construction-workflow/examples/*.json` 在改动后仍通过 `cwf-record check` / schema 校验，且 `formal-records.mjs` 的前置映射与 schema 判定结果一致（不分叉）。
7. **签署不得由 AI 自证**：新增用例须断言轻量路线验收记录在缺可核对人工确认来源时不被接受（或按契约以显式标注承载该约束）。
8. 对 CHORE-36 / LOC-032 / LOC-033 重新生成摘要后，`decided_by` 与 `decided_at` 取到盘上已存在的真实签署值。

> **未决产品事项：0**（DT-01 已于 2026-09-19 由松哥裁定：主方案 A·b3 存在性分层；范围并入摘要修复。见 `decision-tickets/DT-01-lightweight-acceptance-record.md`「裁定结果」）

## 9. 方案候选与子问题（已裁定，保留作决策依据）

### 9.1 主方案

| 方案 | 做法 | 真实影响面（核对代码后） | 风险 |
|---|---|---|---|
| **A · 验收包分层** | 同一记录类型内分「重 / 轻」两套 `assembled` 必填集；轻量套**强制** `decided_by` / `decided_at` | `handoff.schema.json`（`assembled` 为 `additionalProperties:false`，加字段＋`oneOf` 分支）、`cwf-evidence-verify.mjs:59-176` 九项校验按套分支、**`formal-records.mjs:50-63` 的第二份五类硬编码副本须同改**、契约 §3.6/§8.3、examples 06、测试 | 分层判据若来自「会话自报路线」＝绕过独立评审的后门（见子问题 b） |
| **B · 独立轻量记录类型** | 新增记录类型（如 `acceptance_note`），只记签署人 / 时间 / 结论 / 依据清单；正式验收包不动 | `cwf-record.mjs:19-27` `RECORD_TYPES`、schema 根 `record_type` enum 与根 `oneOf` 新分支（`run.stage` 仍须落在既有 7 值内）、`workspace-evidence-summary.mjs:28-44`（现仅从 `acceptance_package` 取三字段）、`formal-records.mjs` 映射、契约 §8.1 | 两套「验收」概念并存，长期语义分叉（与 LOC-016「两套同名实现」坑同型） |
| **C · 不放宽，改口径为「轻量路线不留签署」** | 契约明确写死：走轻量路线即不产生结构化验收签署；三字段以显式「不适用」值标记并附原因 | 仅契约说明 + `workspace-evidence-summary.mjs:125-127` 取值（不动 schema） | 改动最小，但**放弃**「谁验收的」可追溯性——断链被制度化而非消除 |

> 三案**都不解决**成因 2、3（已发生签署未被永久层取到）；那是取值时机与关联问题，不是 schema 问题。

### 9.2 随附子问题（须与主方案一并裁定）

| 子问题 | 内容 | 备注 |
|---|---|---|
| **a · 范围** | 是否把「已发生签署不再丢失（摘要在签收后刷新；未关联 Run 时显式标记而非静默 null）」并入本票 | 不在 `FIX-109` 范围内（其两处缺口为 `merge_commit` 回写时机与「涉及范围」正则）；修点落在 `workspace-evidence-summary.mjs` + 收口调用时机，与 FIX-109 同改 `local-task-merge.mjs` 有协调点 |
| **b · 路线标识来源**（选 A 才需要） | `templates/` 仅 1 个 construction 蓝图（含 review/test）、`run.json` 无路线字段、任务卡 14 个机器字段无路线、契约与 `construction-bootstrap/runbook.md` 从未允许跳过评审 → 无权威来源。候选：**b1** 登记册新增「交付路线」字段由人工在定义阶段确定；**b2** 按任务类型推断（CHORE/FIX 轻、FEAT 重）；**b3** 不用「路线」概念，改按**本 Run 盘上实际存在的记录**做存在性分层（有则必引必校验、无则显式声明缺失原因且须人工知情批准） | 我推荐 **b3**：判据是可机检的事实，不存在自报后门 |
| **c · 命名** | `route` 键在建设记录里已表示**节点下一跳**（`loc-035/040/044` 验收包 payload 的 `route=READY_FOR_HUMAN`、`construction-preflight-gate.mjs:54,64` 的 `route=PASS\|BLOCKED`） | 新字段须换名（如 `delivery_route` / `evidence_tier`），否则重演 LOC-016 同型歧义 |
| **d · 签署凭据** | 轻量路线下 `decided_by` 由 Agent 依会话中人工「通过」写入，契约禁 AI 代签 → 须规定可核对形式 | 无凭据则新字段比 null 更糟（不可核对的断言） |
| **e · 版本兼容** | `record_version` 为 `const:"v0.1.8"`，盘上 453 条记录 + 7 个 examples 全为该值 | 保持 const 并同步改 examples，还是 const→enum 接受旧值；b3 若以「新增可选字段＋`oneOf` 变体」实现，旧记录可继续合法 |

**推荐**：主方案 **A**、以 **b3（存在性分层）** 为落地形态、子问题 **a 并入本票**。理由：① b3 直接命中「必填结构与真实证据构成不匹配」的根因，且分层判据取自盘上事实，不引入自报后门；② 五类齐全的 Run 自然落入五类分支，正式路线标准一字不改；③ 最紧的风险其实是「签署已发生却在永久层丢失」——补不上 ① 之外这一环，选了 A/B 之后新任务照样会丢（`.agent-runs/` 一过 7 天保留期即不可恢复）；④ C 把审计缺口写成规范，而本批任务恰恰全部走轻量路线。

## 10. 关联决策记录

- `decision-tickets/DT-01-lightweight-acceptance-record.md`（**未决**，需人工裁定主方案 A/B/C ＋ 子问题 a/b）
- `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`（缺口发现处）
- GitHub #123（`handoff` 证据链机器校验与 schema 深度加固余项）：与本票**定义不重叠**（#123 余项为 `baseline_revision` 格式与自由文本下限），但**同改 `handoff.schema.json`**，须串行或先行合流。
