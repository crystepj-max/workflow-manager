# 任务规格 V1 · FEAT-237 批量任务源接入 GitHub（ready-for-agent 筛选 + 施工中认领互斥）

| 项 | 值 |
|---|---|
| 任务标识 | `FEAT-237` |
| 远端 issue | `github#237`（主源锚点） |
| 规格版本 | V1 |
| 需求基线 | V1 |
| 编写日期 | 2026-09-20 |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 当前状态 | 已定义（登记册机器取值 `本地已定义`，见 §13） |

---

## 1. 背景

2026-09-19 松哥决策 GitHub 为主源后，发号链路已由 CHORE-111 迁到 GitHub（PR #229 已合并 `origin/main`）：`allocate` 走 `gh issue create`、收口目标解析到 `github` 适配器、`remoteIssueCommand` 示例改为 `gh issue list`。

但**批量交付链路（M5 夜间调度器）的任务源没有跟着切换**。实测（2026-09-20，`origin/main`）：

| 位置 | 现状 |
|---|---|
| `scripts/ai-task-candidate-collect.mjs` | 候选只来自 `docs/tasks/registry.json`（本地）；远端明确「不在本脚本范围」 |
| `scripts/ai-task-dispatcher.mjs` | `machine.json` 的 `remoteIssueCommand` 仅做 best-effort 报告性核验，不进候选池 |
| `.scratch/night-batches/machine.json`（本机） | `remoteIssueCommand` 仍是 `cnb issues list-issues --repo chris.ai/workflow-manager` |
| 全仓 `scripts/` | 除 CHORE-111 新增的 `gh` 调用点外，无任何「按远端标签筛任务」的实现 |

同时，「同一任务被多个施工人同时开工」目前**只能靠本机 `.agent-runs/` 的未收口 run 记录**发现（`ai-task-candidate-collect.mjs:98-107`），跨机器完全不可见——Windows 本机与远程 Mac 并行跑批次时会重复施工同一任务。

## 2. 用户问题

1. 批量任务源与主源分离：任务在主源 GitHub 上，批量调度却只认本地登记册，**远端定义的任务无法进入施工池**，远端已认领的事实也无法阻止本地重复开工。
2. 「可施工」这一判断散落在人的记忆里（定义完成、规格齐备、无人值守允许……），没有机器可读的远端信号，批量调度只能各自实现一套本地门禁。
3. 「谁在施工」没有远端留痕：换人、换机器接手时无法判断任务是否已在别处开工，只能重复施工或反复确认。

## 3. 目标

1. **把 GitHub 作为批量任务源接入**：远端 `ready-for-agent` 标签成为「可施工」的权威信号，批量施工池 = 本地已定义 ∩ 远端可施工。
2. **让标签由机械门禁自动维持**：任务通过定义门禁后自动补打 `ready-for-agent`，避免「靠人记得打标签」导致任务掉出批次。
3. **让开工在远端可见且互斥**：开工即打 `施工中` + 指派施工人 + 认领评论；已被他人认领则拒绝开工，从机制上消除跨机器重复施工。

交付后可观察变化：批次报告新增「远端任务源」一节，逐条说明每个候选是就绪、待补标、被他人认领还是无远端锚点；任何任务的 issue 上都能看到「可施工」与「谁在施工」两个状态。

## 4. 非目标

- 不改发号链路与收口动作路径（已由 CHORE-111 完成）。
- 不自动判定与打「体量」标签（`sized-s|m|l`）——体量属人工判断，本票不代打。
- 不做自动「接管他人认领」：僵尸认领（施工会话崩溃后标签残留）由人工执行 `release` 或人工摘标签处理；本票只在报告中提示。
- 不把标签作为本地轨道的开工资格替代品：任务卡与规格仍是施工硬前置（`ai-task-preflight-check`）。
- 不引入 GitHub App / PAT 之外的认证方式，不修改任何机器本地 git 配置。
- 不改 `delivery-closeout-host.mjs`、`packages/**`。
- 不改既有任务的登记册业务字段。

## 5. 方案

### 5.1 两个标签，两种语义

| 标签 | 语义 | 谁写 | 何时摘 |
|---|---|---|---|
| `ready-for-agent`（复用既有标签） | 需求清晰可执行，可交 agent 施工 | 定义落档后人工 `mark-ready`，或调度器门禁后自动补打 | 收口关闭 issue 时随 issue 关闭失效（不主动摘） |
| `施工中`（本票新建） | 已被某施工人认领，正在施工；他人勿重复认领 | `cwf-run-init` 开工认领 | 收口/释放时 `release` 摘除 |

`施工中` 的标签元数据（颜色 / 描述）在 `github-issues.mjs` 的 `LABEL_META` 里固化为口径的一部分，仓库缺标签时幂等创建。

### 5.2 任务源准入判定（纯函数，可离线单测）

`planTaskSourceAdmission({ registryTasks, candidates, readyIssues, claimedBy, remoteError, onUnavailable, requireAnchor })` 对每个本地候选产出一个判定：

| 判定 | 触发条件 | 处置 |
|---|---|---|
| `claimed` | 该任务的 issue 带 `施工中` | **硬排除**，理由带 issue 号与认领人 |
| `no-anchor` | 登记册 `remote` 无 `github#N` 锚点 | 默认放行并在报告标注（历史 LOC-/TMP- 任务与离线仓依赖此路径）；`requireAnchor=true` 时硬排除 |
| `ready` | issue 带 `ready-for-agent` | 放行 |
| `not-ready` | 有锚点但未带标签 | 门禁通过后补标再放行；补标失败则排除 |

**为什么补标排在定义门禁之后**：标签语义是「满足开工条件」。若在门禁之前补标，会把过不了门禁（缺规格、缺 definition-check、无人值守未允许）的任务标记成「可施工」，等于用标签撒谎。

远端就绪但本地进不了候选的 issue 计入 `orphans` 并在报告列出，分两种归因：「登记册无对应任务 → 缺本地定义」与「本地任务未进候选 → 本地采集闸门未过」。

### 5.3 远端不可信时的处置

`taskSource.onUnavailable`：

- `block`（默认）：远端查询失败（gh 未登录 / 无 GitHub 远端 / 网络不可达）→ 本批**全部候选硬排除**，报告写明原因，进程退出码 1。理由是：在失去「可施工筛选 + 认领互斥」保护的情况下拉起会话，代价（重复施工、冲突提交、token 浪费）高于空跑一夜。
- `local-only`：退回「仅本地登记册」（旧行为），但必须在报告与 `batch.json` 的 `candidateSources` 中显著标注降级，不静默。

### 5.4 施工认领（互斥的实现）

`claimIssue({ repo, taskId, runId, branch })` 的步骤与并发语义：

1. 解析任务 → `github#N` 锚点（唯一依据是登记册 `remote`，不猜 issue 标题）；无锚点返回 `no-anchor`，由调用方降级为告警。
2. 读 issue；`state !== OPEN` → 拒绝。
3. 已带 `施工中`：
   - 评论区存在本 run 的 claim 标记（`<!-- wip-claim:<机器>/<run_id> -->`）→ `reused`（幂等复用，不重复评论）；
   - 否则 → `claimed-by-other`，带出认领人。
4. 未带标签：加标签 → 指派（best-effort）→ 写认领评论（施工人 / run / 分支 / 时间）。
5. **并发二次确认**：评论写入后重读该 issue 的全部评论，取最早出现的 claim 标记；若不是自己 → `claim-raced`，本会话让位，**不摘标签**（保护先到者）。

> 第 5 步是本方案对「标签检查与标签写入之间没有原子性」的正面处理：不假装原子，而是让竞争结果可判定且偏向「宁可少开工，不可重复施工」。

施工人身份 = `gh` 当前登录账号 @ 机器码（`AI_AGENT_NAME` 存在时附注 AI 会话名）。账号取自 `gh api user` 而不是手写配置，避免「配置写了别人的账号」这种伪留痕；无 gh 登录时退回机器码，只做本地留痕。

### 5.5 接线点

| 文件 | 改动 |
|---|---|
| `scripts/github-issues.mjs`（新） | GitHub issue 通道唯一真源 + CLI |
| `scripts/remote-anchors.mjs`（新） | `remote` → 锚点解析唯一实现；`local-task-merge` re-export 保接口 |
| `scripts/ai-task-candidate-collect.mjs` | 新增 `planTaskSourceAdmission` / `pendingLabelSync` / `STAGE_TASK_SOURCE` |
| `scripts/ai-task-dispatcher.mjs` | `taskSource` 配置；远端快照；门禁后补标；`task-source.json` 留档；报告新增章节 |
| `scripts/cwf-run-init.mjs` | 开工认领（`--no-claim` 可跳过），run.json 记 `remote_issue` / `claim` |
| `scripts/local-task-registry.mjs` | `mark-ready` 子命令 |

`machine.json` 新增（全部可省略，省略即保持旧行为）：

```json
"taskSource": {
  "readyLabel": "ready-for-agent",
  "wipLabel": "施工中",
  "labelSync": true,
  "onUnavailable": "block",
  "requireAnchor": false
}
```

## 6. 交付范围

**做**：§5.5 六处脚本 + §5.5 文档/示例配置 + 三个新单测文件 + 真机链路验证。

**不做**：§4 全部。

## 7. 验收标准

1. 配 `taskSource` 后，施工池 = 本地已定义 ∩ 远端 `ready-for-agent`；`施工中` 任务被排除且理由含 issue 号与认领人（单测 `ai-task-source-admission.test.mjs` 覆盖四态）。
2. 门禁已过但远端缺标签 → 调度器补打 `ready-for-agent`（日志逐条记录）；补标失败 → 该任务排除并写明失败原因。
3. 远端不可信（gh 未登录 / 无 GitHub 远端）默认阻断本批并退出码 1；配 `local-only` 时降级且报告显著标注。
4. `cwf-run-init` 开工：`施工中` + assignee + 认领评论齐备；已被他人认领 → exit 1 并指出认领人；同 run 重跑 `reused`；`--no-claim` 明确跳过。
5. `mark-ready --task <id>` 幂等；无 `github#N` 锚点时报错并给出换号指引。
6. `scripts/test/*.test.mjs` 全量相对开工基线**无新增失败**（比对方式：同一组文件在干净 `origin/main` 与改动树各跑一次，逐条对比失败清单）。
7. 真机链路：在真实 issue 上完成「补标 → 认领 → 他人被拒 → 释放」，`施工中` 标签随释放摘除、`ready-for-agent` 保留。

## 8. 实施要点

- `gh issue create` 之外，`gh` 的 JSON 输出字段名以实测为准：`gh issue view --json number,title,state,labels,assignees,url,comments` 的 `comments` 仅在显式请求时返回，且按时间升序——认领协商依赖该顺序。
- 认领标记用 HTML 注释，避免污染 issue 正文可读性：`<!-- wip-claim:<机器>/<run_id> -->`。
- `machine.json` 不入库，是每台机器本地配置；`taskSource` 省略时调度器行为与改动前**逐字节一致**（既有 6 条 M5 测试可证）。
- `scripts/test/` 下运行单测前需 `env -u NODE_OPTIONS`；在 worktree 跑全量测试会把 `scripts/benchmark/loc-045/**` 与登记册改写，跑完必须 `git checkout --` 还原，避免把无关改动卷进提交。

## 9. 已确认的关键决策及原因

| # | 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|---|
| D-01 | 任务源组合口径 | **交集**（本地已定义 ∩ 远端 ready-for-agent） | 本地任务卡与规格是施工硬前置（preflight 门禁），远端标签是跨机可施工信号；两者都满足才开工才不会把「无规格的任务」放进无人值守批次 | 松哥 | 2026-09-20 |
| D-02 | 远端不可信时默认行为 | **block（不开工）** | 失去认领互斥后重复施工的代价高于空跑一夜；且明确报错可恢复，重复施工不可逆 | 松哥 | 2026-09-20 |
| D-03 | 补标时机 | **定义门禁之后**，且补标失败即排除 | 标签语义 = 需求清晰可执行；在门禁前补标等于用标签撒谎；补标失败仍放行则标签形同装饰 | 松哥 | 2026-09-20 |
| D-04 | 无 `github#N` 锚点的任务 | **默认放行并标注**，`requireAnchor` 可开严格 | 历史 LOC-/TMP- 任务与离线仓依赖此路径；一刀切排除会让既有批次瞬间不能开工 | 松哥 | 2026-09-20 |
| D-05 | 施工人身份来源 | **`gh api user` 登录账号 @ 机器码**，不手写配置 | 手写配置可能出现「留痕是别人」的伪证据；登录账号是唯一可信来源 | 松哥 | 2026-09-20 |
| D-06 | 是否提供自动接管他人认领 | **不提供**，只提供 `release` 与报告提示 | 自动接管会把「防重复施工」变成「谁后到谁赢」，破坏互斥语义；僵尸认领用人工释放处理 | 松哥 | 2026-09-20 |

> 未决产品事项：0

## 10. 边界场景

- **双锚点取值**（`cnb#111 + github#215`）→ 按 github 一侧认领与打标；CNB 是灾备镜像，不承载施工信号。
- **issue 已关闭** → 认领返回 `issue-not-open`，拒绝开工。
- **任务无远端锚点**（`remote=none` / `pending`）→ 认领降级为告警，本地流程继续；报告中标注「不做标签筛选与认领互斥」。
- **同一机器同 run 重跑** → `reused`，不重复评论、不重复指派。
- **并发认领**（两台机器同一分钟开工同一任务）→ 评论顺序最早者胜出，后到者 `claim-raced` 让位。
- **僵尸认领**（施工会话崩溃、标签残留）→ 本票不自动清理；报告中提示「本地无在跑 run 的已认领任务」，由人工 `release`。
- **测试夹具仓**（无 GitHub 远端）→ `taskSource` 不配置即不启用；配置了但无远端时按 `onUnavailable` 处置。

## 11. 风险与已知限制

| 风险 | 影响 | 处置 |
|---|---|---|
| 首次上线的批次可能因标签未铺开而候选变少 | 某个晚上施工量为 0 | 调度器自动补标（D-03）+ 报告逐条列出「待补标签」，一眼可查 |
| `施工中` 标签残留（会话崩溃） | 该任务长期无法被批次选中 | 报告提示 + 人工 `release`；D-06 明确不自动接管 |
| 认领互斥非严格原子 | 极端并发下可能出现两条认领评论 | 二次确认取最早者并让位；失败方记 `claim-raced` 不施工，最坏结果是「同一任务少开工一次」 |
| `gh` 权限不足（无 `issues: write`） | 标签/评论写入失败 | 补标失败即排除（不静默）；认领失败降级为告警并在报告标注保护未生效 |
| 多机器并发写同一 issue | 评论顺序受网络延迟影响 | 以 GitHub 返回顺序为准（服务端排序），不在客户端比时间戳 |

**已知限制**：

- `施工中` 标签只能表达「有人认领」，不能表达「认领人是否还活着」；liveness 依赖 run 现场与报告提示。
- 本票不覆盖单任务交付（M2）路径的认领——`cwf-run-init` 覆盖手工与批量两条入口，但 M2 若绕过 `cwf-run-init` 则不认领。
- GitHub 标签的写入/摘除存在**秒级最终一致延迟**（真机实测：摘标签后立即查询仍可能读到旧值）。因此认领互斥不依赖「标签立即可见」，而是靠评论区的 claim 标记做二次确认；批次的任务源快照以查询时刻的服务端状态为准，极端情况下可能读到刚变更前的状态。
- 「现任施工人」只认**最后一次释放之后**的认领标记（`claimKeysInWindow`）：释放-重新认领是常态，把历史标记算进来会让 holder 指向早已释放的旧认领（真机实测踩到，已修）。

## 12. UAT 场景

### UAT-01 任务源筛选与准入归因

- 前置条件：`machine.json` 配 `taskSource`；准备 4 个候选：远端就绪、远端缺标、远端被他人认领、无锚点。
- 操作步骤：`node scripts/ai-task-dispatcher.mjs <schedule.json> --dry-run`。
- 预期结果：施工池只含「远端就绪」；缺标者出现在「标签补打记录」并在真实批次中被补标；被认领者理由带认领人；无锚点者列出且标注不做互斥。

### UAT-02 远端不可信

- 操作步骤：令 `gh` 不可用（未登录），跑真实批次。
- 预期结果：退出码 1，报告写明阻断原因，未拉起任何会话；改配 `local-only` 后按仅本地候选运行且报告显著标注降级。

### UAT-03 开工认领与互斥

- 操作步骤：对同一 issue 依次执行 `cwf-run-init <id> <run1>`、`cwf-run-init <id> <run2>`。
- 预期结果：第一次成功并打上 `施工中` + assignee + 认领评论；第二次 exit 1 指出认领人；`release` 后 `施工中` 摘除、`ready-for-agent` 保留。

## 13. 状态词汇说明

登记册 `STATUSES` 枚举中「定义完成」的机器取值是 **`本地已定义`**（无 `已定义` 取值）；GitHub issue #237 的需求基线状态写 **已定义** 并打 `ready-for-agent`（对外口径）。两者指同一状态。

## 14. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-20 | 初版：六处接线 + 两个标签口径 + 准入四态 + 认领互斥（含并发二次确认）+ 六条决策 | 松哥 |
