# FEAT-237 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FEAT-237` |
| 远端 issue | github#237（编号由 GitHub 主源发号） |
| 需求来源 | 会话录入 |
| 来源定位 | 松哥 2026-09-20 会话：GitHub 已恢复并切为主源后，要求把批量任务源接入 GitHub，并用标签承担「可施工」与「施工中认领」两个信号 |
| 任务名称 | 批量任务源接入 GitHub：ready-for-agent 筛选 + 施工中认领互斥 |
| 任务类型 | 需求迭代（编号类型 FEAT） |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | FEAT-237 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FEAT-237-github-task-source-claim/task-spec-V1.md`（入库） |
| 定义时间 | 2026-09-20T21:40:00Z |
| GitHub 同步 | synced#237 |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据：全部改动落在仓库脚本、机器本地配置与单测内；对外动作（打标签、评论、指派）均发生在已授权的 GitHub 主源仓库且可撤销，无需要人取舍的产品问题。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`。

## 摘要（三要素速览）

### 任务目标

把夜间批量交付（M5 调度器）的任务源从「仅本地登记册」扩展为「本地登记册 ∩ GitHub 可施工标签」，并让「谁在施工」在远端可见、可互斥：需求定义完成即打 `ready-for-agent`，开工即打 `施工中` + 指派 + 认领评论，从而**跨机器**避免不同施工人同时选中同一任务重复施工。

### 涉及范围

- 做：
  - 新增 `scripts/github-issues.mjs`：GitHub issue 通道唯一真源（标签增删、按标签列 issue、评论、assignee、施工人身份、锚点解析、认领/释放/补标），gh 执行器可注入；带 CLI `mark-ready / claim / release / list-ready / show`
  - 新增 `scripts/remote-anchors.mjs`：`remote` 字段 → 远端锚点解析的唯一实现（自 `local-task-merge` 抽出，后者 re-export 保接口）
  - `scripts/ai-task-candidate-collect.mjs`：新增 `planTaskSourceAdmission`（四态准入判定：ready / not-ready / claimed / no-anchor）与 `pendingLabelSync`
  - `scripts/ai-task-dispatcher.mjs`：机器配置新增 `taskSource`；采集后拉远端快照、门禁后补标、排除他人已认领；报告新增「远端任务源」章节；远端不可信按 `onUnavailable` 阻断或降级
  - `scripts/cwf-run-init.mjs`：开工认领（标签 + assignee + 评论），已被他人认领则拒绝开工；`--no-claim` 显式跳过
  - `scripts/local-task-registry.mjs`：新增 `mark-ready` 子命令（幂等补打 `ready-for-agent`）
  - 文档与配置：`docs/tasks/README.md`、`docs/design/night-batch-dispatcher.md`、`scripts/night-batch-machine.example.json`、`CONTEXT.md`、`dsh/skills/requirements-analysis/SKILL.md`
  - 单测：`github-issues.test.mjs`、`ai-task-source-admission.test.mjs`、`cwf-run-init-claim.test.mjs`
- 不做：
  - 不改发号链路（`allocate` 已由 CHORE-111 迁到 GitHub）
  - 不改收口动作路径（`delivery-closeout-host` 的 GitHub 适配器由 CHORE-111 承接）
  - 不自动判定体量标签（`sized-s|m|l` 属人工判断，本票不代打）
  - 不做「接管他人认领」的自动绕过（僵尸认领由人工 `release` 处理，另在报告中提示）
  - 不改 `registry.json` 既有任务的业务字段

### 验收标准

1. `machine.json` 配 `taskSource` 后，批量候选=本地已定义 ∩ 远端带 `ready-for-agent`；远端带 `施工中` 的任务被排除且理由写明认领人。
2. 门禁已过但远端缺标签的任务，调度器自动补打 `ready-for-agent`；补标失败则该任务不进施工池并如实报告。
3. 远端任务源不可信（gh 未登录 / 无 GitHub 远端 / 查询失败）时默认**不开工**并给出明确原因；配 `local-only` 时降级为仅本地，报告显著标注降级。
4. `cwf-run-init` 开工时对目标 issue 打 `施工中` + assignee + 认领评论（含施工人、机器、run、分支、时间）；issue 已被他人认领时**拒绝开工**（exit 1），同 run 重复执行幂等复用。
5. `node scripts/local-task-registry.mjs mark-ready --task <id>` 幂等给任务 issue 打 `ready-for-agent`；无 `github#N` 锚点时报错并给出换号指引。
6. 既有 `scripts/test/*.test.mjs` 全量无新增失败（相对开工基线逐条比对）。
7. 真机验证：认领 → 他人被拒 → 释放全链路在真实 issue 上跑通（证据落运行记录）。

## 关联

- `docs/tasks/CHORE-111-numbering-source-migration.md`（发号源迁 GitHub，本票依赖其 `gh` 通道与锚点解析）
- GitHub issue #224 / #225 / #226（`ready-for-agent` + `sized-*` 标签口径的既有实例）
- `docs/design/night-batch-dispatcher.md`（M5 调度器设计，本票在其上扩展任务源）
