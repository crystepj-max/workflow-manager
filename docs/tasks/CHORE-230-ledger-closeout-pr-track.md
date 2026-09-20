# CHORE-230 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-230`（前身 `CHORE-116`，误由灾备镜像发号后经换号机制纠正，`legacy_id` 已留痕） |
| 远端 issue | `github#230`（GitHub 主源发号） |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-20 CHORE-111 收口过程暴露：主源切到 GitHub、main 改为 PR-only 后，收口账本与立票材料都失去了入库载体 |
| 任务名称 | 任务账本与立票/收口路线适配 PR-only 主干（消除每任务额外 PR） |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P1 |
| 当前状态 | 待确认 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | CHORE-230 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许（实施与自动检查免问；**合并需人工批准**） |
| 任务规格位置 | `docs/tasks/specs/CHORE-230-ledger-closeout-pr-track/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | synced#230 |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据与边界：改动落在登记册字段、收口/前置判据脚本、门禁分级与文档，全部可由单测与既有门禁验证；但本票改的正是**所有后续任务共用的开工前置判据与收口路线**，误判会波及整批任务，因此合并动作保留人工批准点。
> - `GitHub 同步 = pending`：#230 目前只有发号自动正文，任务基本信息将在基线确认、落档「已定义」时一并回填，届时改记 `synced#230`。
> - `merge` 字段形状：本票写入 `merge.pr`，`merge.commit` 由解析回填（规格 §6.1），两者语义不同，不能相互替代。

## 摘要（三要素速览）

### 任务目标

让「立票 → 施工 → 收口」整条任务流程在 PR-only 的 GitHub 主干上**闭环自洽**：收口账本与立票材料随任务自身的 PR 一起入库，每个任务不再产生额外 PR；同时保留账本的可追溯性（合并事实按 PR 号可解析、归档一致性校验继续有效）。

交付后可观察变化：
1. 收口一个任务只需 1 个 PR（今天需要 2 个：#223 带代码、#229 补账本）；
2. 新任务的任务卡与规格不再长期停在"未跟踪"状态（今天 FIX-224/225/226 三份材料仍未入库，`validate:task-context` 因此长期挂 3 项红）；
3. 「已合并」不再依赖某个人手工再推一次状态，而由账本按 PR 事实推导；
4. 门禁不再"要么长期红、要么放过真问题"：规格文件存在但未跟踪降为可解释警告，已具备开工资格却无规格仍为硬失败。

### 涉及范围

- 做：`local-task-registry.mjs`（`merge.pr` / `--merged-at` / 本地解析回填）、`local-task-merge.mjs`（新增 `--via-pr` 收口路线，不推进本地主干）、`ai-task-preflight-check.mjs`（前置合并判据兼容 PR 号解析）、`validate-task-spec-sync.mjs`（未跟踪规格分级判定）、`validate-workspace.mjs` 归档一致性对解析值的兼容、三处文档口径、单测覆盖。
- 不做：不改历史任务的 `task_id`/`remote`/`merge` 值（含存量字符串形状，沿用 CHORE-111 的 D-03 裁定）；不给 main 开 ruleset bypass；不把账本搬出 Git；不改编号契约语义；不改 GitHub 收口适配器的既有动作形态；不改机器本地 git 配置（含 `remote.pushDefault`，第 16 项走代码层显式指定主源）。

### 验收标准

见规格 §7（8 条）。核心两条：合入后再收口一个任务只产生 1 个 PR；`validate:task-context` 不再因"材料尚未入库"的正常窗口而长期红。

## 关键证据（2026-09-20 实测）

| 项 | 实测结果 |
|---|---|
| 额外 PR 的真实代价 | CHORE-111：#223（代码）+ #229（账本），账本 PR 与代码 PR 内容零重叠，纯流程开销 |
| 立票材料未入库 | `docs/tasks/FIX-224/225/226` 的卡与规格在主检出为 `??`（未跟踪），主干上不存在这些文件 |
| 账本的哈希消费方 | `ai-task-preflight-check.mjs` L69–77：用 `merge.commit` 做 `git merge-base --is-ancestor` 前置祖先校验；`validate-workspace.mjs` L314–315 + `validate-workspace-archive.test.mjs` D-8：要求归档摘要 `merge.commit` 与登记册**逐字一致** → 哈希不能从账本里删掉 |
| 哈希可否离线解析 | 可：GitHub 合并提交信息固定含 `Merge pull request #<n>`，`git log --merges --grep` 在已 fetch 的 `origin/main` 上即可取回 sha 与提交时间，不需联网 |
| 收口脚本主干推进点 | `local-task-merge.mjs` L316 `git merge --squash` 进本地 main、L329 归档、L357/365/375 写账本与看板、L525 置 `github_sync=pending` |
| 本次误发号事件 | 在落后 4 个提交的主检出（`5dea84a`）执行 `allocate`，旧代码向 CNB 签发 `cnb#116`；已用 `remote-issue-sync reissue` 换成 `CHORE-230` / `github#230`（`legacy_id=CHORE-116`），CNB #116 已关闭留痕 |
| 存量账本形状 | FIX-108 / CHORE-104 的 `merge` 是字符串 `"GitHub PR #206 (…)"`，`merge?.commit` 读不到（既有缺陷，本票只读兼容、不改写） |

## 已确认的关键决策（详见规格 §10）

| # | 主题 | 裁定 | 确认人 |
|---|---|---|---|
| D-01 | 本票范围 | 立票载体与收口载体**一起修** | 松哥 2026-09-20 |
| D-02 | 合并事实记法 | **记 `merge.pr` + 本地解析回填 `merge.commit`**，状态由事实推导 | 松哥 2026-09-20 |
| D-03 | 无人值守边界 | 实施免问、**合并需人工批准** | 松哥 2026-09-20 |
| D-04 | 误建 CNB #116 | 关闭并标注作废，不删除 | 松哥 2026-09-20 |
| D-05 | 存量账本值 | 判据只读兼容，不改写历史值 | 沿用 CHORE-111 D-03，2026-09-20 确认 |

## 关联

- `docs/tasks/archive/CHORE-111/CHORE-111-numbering-source-migration.md`（本票的需求来源：收口账本经 #229 补登）
- GitHub #215 / PR #223 / PR #229（缺陷暴露过程）
- `docs/tasks/FIX-109-closeout-tooling-gaps.md`（同文件强重叠：`merge_commit` 回写时机，正是本票 D-02 要根治的问题）
- `docs/tasks/CHORE-110-acceptance-package-schema.md`（GitHub 轨道的证据来源）
- GitHub #218（CI born-red 修复在途，与本票无因果）
