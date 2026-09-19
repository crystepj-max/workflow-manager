# FIX-109 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-109` |
| 远端 issue | cnb#109（编号由 CNB 远端发号） |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-19 CHORE-106 收口实操中发现（证据见 `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`） |
| 任务名称 | 收口脚本两处口径缺口：merge_commit 回写时机致主检出残留 + 任务范围正则取空 |
| 任务类型 | 缺陷修复（编号类型 FIX） |
| 优先级 | P2 |
| 当前状态 | 定义中 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FIX-109-closeout-tooling-gaps/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | pending |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据：两处均为收口脚本内部的口径缺陷，修法与验收标准可由规格直接判定，无需要人取舍的产品问题。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`，附加自然语言会导致实施前检查失败。

## 摘要（三要素速览）

### 任务目标

消除收口脚本 `scripts/local-task-merge.mjs` 的两处口径缺陷，使**收口结束时主检出保持干净**、**收口提交携带的任务范围是真实正文**，避免并行会话被残留脏工作区阻塞、以及收口记录携带无意义字段。

### 涉及范围

- 做：
  - 缺口①：收口末尾把登记册 `merge.commit` 由 `PENDING` 回写为真实哈希的写入，改为随收口流程自动落进一次提交（此后主检出不再残留未提交改动）
  - 缺口②：修正任务卡「涉及范围」小节的抽取正则，使其取到正文而非标题字面；并抽出可单测的函数
  - 为上述两处各补一条单测（`scripts/test/local-task-merge.test.mjs`）
- 不做：
  - 不改动收口脚本的其余步骤与判定口径（`checkMerge` 前置校验、工作区删除安全门、可逆让位等）
  - 不改动 `delivery-closeout-host.mjs`（引擎蓝图路线）与 WR-014 适配层
  - 不改动验收包 / 证据摘要 schema（另有 `CHORE-110` 承接）
  - 不改动 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进）
  - 不追溯改写历史收口提交（已合并提交不动）

### 验收标准

1. 执行一次完整收口后，主检出 `git status --porcelain` 为空（不含本任务以外的并行会话在制产物）；登记册该任务 `merge.commit` 为真实 40 位哈希，非 `PENDING`。
2. 收口提交（或紧随的自动回写提交）中 `任务范围:` 字段为该任务卡「涉及范围」小节的**正文内容**，不含 `###` 标题字面、不含 markdown 列表标记。
3. 给定同一张任务卡，抽取函数返回值稳定且可断言；新增单测覆盖「标题后紧跟空行」这一原缺陷形态。
4. 既有 `scripts/test/local-task-merge.test.mjs` 全绿，未引入新失败。

## 关键证据（2026-09-19 实测）

| 项 | 实测结果 |
|---|---|
| 缺口① 位置 | `local-task-merge.mjs` L318–L323 `git commit` 之后，L326–L329 才 `git rev-parse HEAD` 并 `update(repo, taskId, { merge_commit: commit })` → 该写入落在**提交之后**，成为未提交改动 |
| 缺口① 实际后果 | CHORE-106 收口后主检出残留 `docs/tasks/registry.json` 未提交 → 按 `checkMerge`「主检出不得有未提交改动」口径，会**阻塞并行会话的下一次收口**；当时由人工补提交 `7e8e8ba` 收尾 |
| 缺口② 位置 | `local-task-merge.mjs` L237：`card.match(/### 涉及范围[\s\S]*?\n\n/)` |
| 缺口② 成因 | 任务卡中「涉及范围」标题后**紧跟空行**（`### 涉及范围\n\n- 做：…`），非贪婪 `[\s\S]*?` 匹配空串后立即命中 `\n\n` → 整体匹配即 `### 涉及范围\n\n`，再经 `.replace(/[-*]\s*/g,'').trim()` 得到字面 `### 涉及范围` |
| 缺口② 波及面 | **所有**任务卡（CHORE-37 / CHORE-38 / CHORE-106 的收口提交「任务范围」字段实测同为废值） |

## 关联

- `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`（收口缺口根因分析与 stash 审计）
- `docs/tasks/CHORE-106-close-task-issue.md`（同批发现，已收口）
- `docs/tasks/CHORE-110-acceptance-package-schema.md`（同批发现的第三处缺口，单独立票）
