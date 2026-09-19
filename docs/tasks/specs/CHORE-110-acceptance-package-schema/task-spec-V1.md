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

> 关键判断：**缺的不是记录类型，而是轻量路线无法满足其必填结构。** 这决定了修法方向是「放宽 / 分层」而不是「新造记录类型」。

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

按 §9 裁定方案实施。三种候选方案及其影响已列于 §9，**须先裁定再施工**（记录于 `decision-tickets/DT-01-lightweight-acceptance-record.md`）。

无论选哪一种，以下三条为共同底线（不随方案变化）：

1. 契约须明文**禁止**为满足校验而伪造 `review_proof` / `test_proof` 或冒充独立评审。
2. 轻量路线的验收签署**必须可追溯到人**（真实的 `decided_by` 与 `decided_at`），或被显式标记为「不适用」，两者不得含混。
3. 正式路线的五类引用强制校验**不得放宽**。

## 8. 验收标准

1. 契约层明确轻量路线登记验收签署的唯一入口与字段形态，且与正式验收包不冲突（或统一、或显式区分），并写入 `docs/design/construction-workflow-portable-contract.md` 与 schema。
2. 走轻量路线完成一笔实际任务后，其归档 `evidence-summary.json` 的 `decided_by` 与 `decided_at` 非 null（或为裁定方案定义的「不适用」确定值，而非静默 null）。
3. `cwf-record` / `cwf-validate` 对轻量路线验收记录的校验行为与契约一致，不再出现「因缺五类前置引用而无法登记」。
4. 契约中存在明文禁止伪造独立评审 / 测试记录的条款。
5. 既有测试全绿，新增用例覆盖轻量路线的登记与校验路径。

> 未决产品事项：1（方案 A/B/C 待裁定，见 §9 与 DT-01）

## 9. 方案候选（待裁定）

| 方案 | 做法 | 影响面 | 风险 |
|---|---|---|---|
| **A · 验收包分层** | `acceptance_package` 增「轻量变体」：`assembled` 改为按路线二选一——正式路线仍须五类引用；轻量路线只需 `dev_handoff_ref` + 明确的路线标识，并**强制**记录 `decided_by` / `decided_at` | schema + 契约 + `cwf-validate` 校验分支 | schema 放宽后可能被误用于正式路线 → 须以路线标识 + 校验分支锁死 |
| **B · 独立轻量记录类型** | 新增记录类型（如 `acceptance_note`），只记签署人 / 时间 / 结论 / 所依据证据清单；正式验收包保持原样不动 | 新增记录类型 + 证据摘要取值分支 + 契约新增一节 | 两套「验收」概念并存，长期有语义分叉风险（与 LOC-016 那类「两套同名实现」坑同型） |
| **C · 不放宽，改口径为「轻量路线不留签署」** | 契约明确写死：走轻量路线即不产生结构化验收签署；`evidence-summary` 三字段以显式「不适用」值标记并附原因 | 仅改契约说明 + 摘要取值（不动 schema） | 改动最小，但**放弃**了「谁验收的」可追溯性——断链被制度化而非消除 |

**推荐倾向**：A（分层）。理由：断链的根因是「必填结构与路线现实错配」，分层直接命中根因；B 会引入第二套验收语义（本项目已有「两套同名实现互相争夺同一文件」的历史教训）；C 虽最省事，但把审计缺口写成了规范，等于承认「轻量任务不可追溯」，而本批任务恰恰**全部**走轻量路线。

## 10. 关联决策记录

- `decision-tickets/DT-01-lightweight-acceptance-record.md`（**未决**，需人工裁定 A / B / C）
- `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`（缺口发现处）
