# CHORE-111 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-111` |
| 远端 issue | `cnb#111`（历史锚点，编号由 CNB 发号——本票即迁移前最后一批 CNB 号）+ `github#215`（主源锚点） |
| 需求来源 | 会话录入 |
| 来源定位 | 松哥 2026-09-19 决策：GitHub 账户恢复，后续以 GitHub 为主源、CNB 为灾备镜像；发号源单独立票迁移 |
| 任务名称 | 任务编号发号源从 CNB 迁移到 GitHub（编号连续性 + 历史号段冲突处置） |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P2 |
| 当前状态 | 已合并 |
| 需求基线版本 | V1（复核修订版） |
| 前置依赖 | 无 |
| 施工环境组 | CHORE-111 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-111-numbering-source-migration/task-spec-V1.md`（入库） |
| 定义时间 | 2026-09-19T14:08:57Z（松哥确认基线 V1） |
| GitHub 同步 | synced#215 |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据：改动落在仓库脚本、文档与单测内，对外动作限于已授权的 GitHub 主源仓库且可回退。**例外**：GitHub 收口适配器是新建路径，首次真实收口须人工在场，不属无人值守范围（规格 §13）。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`，附加自然语言会导致实施前检查失败。
> - 登记册 `STATUSES` 无「已定义」取值，落档时机器字段写 `本地已定义`、issue #215 对外口径写「已定义」+ `ready-for-agent`，二者指同一状态。

## 摘要（三要素速览）

详细事实源见 `docs/tasks/specs/CHORE-111-numbering-source-migration/task-spec-V1.md`；本节只给结论。

### 任务目标

把任务编号的**发号源**从 CNB 服务端迁到 GitHub 服务端，使 `<TYPE>-<号>` 的号继续由远端分配（保持「禁止本机自增号」的防撞号属性），并把发号链路、同步链路、收口提示、**收口适配器目标解析**与操作真源文档一并对齐到「GitHub 为主源、CNB 为灾备镜像」的新口径。

交付后可观察变化：新建任务拿到 `github#N` 且 issue 在 GitHub 真实存在；收口工具不再把对外动作指向灾备镜像；照 README / 需求分析技能操作的人不再被告知去 CNB 发号。

### 涉及范围

- 做（规格 §3.1–§3.4 共 15 处）：
  - **发号链路**：`local-task-registry.mjs` 的 `resolveRemoteSlug`（现只读 `git remote get-url cnb`）、`remoteAllocate`（现调 `cnb issues create-issue`）改为经 `gh issue create` 取 GitHub 号；`allocate` 写 `remote = github#<号>`；L25/L30 注释改口径
  - **同步脚本**：`remote-issue-sync.mjs` L112/L114/L139 的 `cnb#<号>` 改为 GitHub 通道
  - **收口解析（修复迁移引入的断裂）**：`local-task-merge.mjs` L394–411 的 `remote` 正则放宽为平台无关（支持双锚点 `cnb#N + github#M`、空格式 `GitHub #N`）、平台名→git 远端名映射（`github` → 实际远端 `origin`）、提示串改 `gh issue close` 形态
  - **收口适配器**：`delivery-closeout-host.mjs` 实现**最小 GitHub 适配器**——`KNOWN_ADAPTERS` 增 `github` 并移出 `UNAVAILABLE_ADAPTERS`（L25/L26/L199）、目标解析按主源优先重排（L215–228，现状因 `pushDefault=cnb` 会解析到 CNB）、`close-task`/PR 动作走 `gh`（L60–170 旁新增路径）、L441 提示串对齐；失败**不得**回落 CNB
  - **门禁与注释文案**：`validate-task-spec-sync.mjs` L10、`ai-task-candidate-collect.mjs` L13、`ai-task-dispatcher.mjs` L32（复核轮补）
  - **操作真源文档**：`docs/tasks/README.md` L16/L27/L47、`dsh/skills/requirements-analysis/SKILL.md` L262 段、`dsh/roles/closeout.md` L18
  - **历史号段冲突处置**：按 `DT-01` 裁定 A 执行（已执行完毕并复核）
  - **测试**：新增「GitHub 发号成功」「不可达降级 TMP」「历史字段不被改写」单测 + 收口解析/适配器断言
- 不做（规格 §5）：
  - **不改历史任务的 `task_id`**、**不改历史任务的 `remote` 字段值**（含下方 8 条不规范取值，规范化另立小票）
  - 不迁移 GitHub 既有 issue 内容与评论；不改 `registry.json` 既有任务业务字段
  - **不修改任何机器本地 `git config`（含 `remote.pushDefault`）**——按仓库约定 git config 不由 Agent 改动，`pushDefault=cnb` 由代码层解析优先级处置
  - 不改 `.github/workflows/mirror-cnb.yml`；不改 FEAT-84/85/86 的 UI 交互（ZCODE 推进）
  - 不改写 `docs/design/ai-task-define-delivery/*` 与 `wayfinder/tickets/SYNC-01*`（历史决策记录，保留当时口径）

### 验收标准

1. `allocate` 后 `task_id = <TYPE>-<GitHub issue 号>`、`remote = github#<号>`，GitHub 上该 issue 存在且标题与任务名一致。
2. 模拟 `gh` 未登录/无网络 → 产出 `TMP-*` 且 stderr 明确告警；**断言不出现 `cnb#`**。
3. `git diff docs/tasks/registry.json` 中既有任务 `task_id` 与 `remote` 字段**零改动**。
4. **门禁相对基线不新增失败**：开工第一步记录当前失败清单为基线（2026-09-19 实测 3 项 `spec-untracked`：CHORE-113 / FEAT-114 / FEAT-75，均属并行会话在途产物），收口时比对；门禁文案不再出现「必须有远端（CNB）issue 号」。
5. 新增单测覆盖三条路径，既有套件无新失败。
6. GitHub 主源下收口目标解析为 `github`（不再因 `pushDefault=cnb` 解析到 CNB）；`adapter=github` 时 `close-task` 走 `gh issue close`，失败不得改由 CNB 执行。
7. `local-task-merge` 对双锚点与空格式 `remote` 能产出待人工关闭提示，不再静默跳过。
8. 三处操作真源文档不再出现「CNB 发号 / 必须有远端（CNB）issue 号」口径。

## 关键证据（2026-09-19 实测，复核轮已独立重跑）

| 项 | 实测结果 |
|---|---|
| GitHub 可用性 | `gh auth status` 已登录 `crystepj-max`，scope 含 `repo`/`workflow` |
| **GitHub main 推送** | **PR-only**：repository ruleset `main protect`（id `21234444`，`enforcement=active`，`bypass_actors=0`）。<br>⚠️ 本卡早先版本记「分支保护已撤销」，依据是 `branches/main/protection` 返回 404 —— **该结论错误**：保护由 ruleset 承载，protection API 404 不代表撤销。执行者不得据此直推主干 |
| 远端与推送目标 | `git remote -v`：`origin`=github.com、`cnb`=cnb.cool、`mirror`=本地镜像；**无名为 `github` 的远端**。`git config --get remote.pushDefault` = **`cnb`**，`main@{upstream}` = `origin/main` |
| 镜像机制 | `.github/workflows/mirror-cnb.yml`（PR #205 合入，`452ee07`）已上线；运行 `35418948093` 实测 **success 13s**；只允许快进，CNB 领先时失败等人工回灌 |
| 发号源绑定位置 | `local-task-registry.mjs` L71–80 `resolveRemoteSlug`、L91–113 `remoteAllocate`、L328–359 `allocate`（行号已逐条核对） |
| 收口适配器耦合面 | `delivery-closeout-host.mjs` L25/L26/L199–200 白名单、**L215–228 目标解析**、L60–170 CNB 动作实现、L441 提示串 |
| 号段冲突（已处置） | GitHub #108/#109/#110 原为 2026-08-30 误建占位 issue；经 `DT-01` 裁定 **A · 复用占位号对齐**，2026-09-19 执行完毕。复核：#108 CLOSED/`bug`、#109 OPEN/`bug`、#110 OPEN/`documentation` 均已改为对应任务正式 issue；`#106` 真实 issue（parent #76）**未动**，`CHORE-106` 锚点保留 `cnb#106` |
| 历史号规模 | `registry.json` 共 **77** 条（早先记 71，并行会话已增条目）；`remote` **并非全为 `cnb#N`**——8 条偏离单值格式：双锚点 `cnb#N + github#M` 6 条（LOC-018、CHORE-75、FIX-108、FIX-109、CHORE-110、CHORE-111）、空格式 `GitHub #N` 2 条（FEAT-208、FEAT-75） |
| 门禁基线 | `npm run validate:task-context` 实测**红 3 项**（CHORE-113 / FEAT-114 / FEAT-75 `spec-untracked`），均与本票无关 → 决定了验收 4 的表述方式（D-02） |
| 既有测试可复用 | `scripts/test/local-task-registry.test.mjs` 已覆盖 allocate 路径，新增单测在此扩展 |

## 已确认的关键决策（详见规格 §10）

| # | 主题 | 裁定 | 确认人 |
|---|---|---|---|
| D-01 | 历史号段冲突 | A · 复用占位号对齐（已执行） | 松哥 2026-09-19 |
| D-02 | 验收 4 门禁全绿不可达 | 改为「相对基线不新增失败」 | 松哥 2026-09-19 |
| D-03 | `remote` 格式与解析点 | 修解析 + 新格式，历史 8 条值不动 | 松哥 2026-09-19 |
| D-04 | GitHub 收口适配器深度 | 实现最小 GitHub 适配器（含目标解析） | 松哥 2026-09-19 |
| D-05 | 文档口径范围 | 只纳入操作真源 3 处，历史设计/wayfinder 留后续 | 松哥 2026-09-19 |
| D-06 | 无人值守许可 | 允许（首次真实 GitHub 收口须人工在场） | 松哥 2026-09-19 |

## 收口记录（2026-09-20）

| 项 | 值 |
|---|---|
| 合并方式 | GitHub PR **#223**（merge commit `eea2b99ee12221c2c713a924f3f3f416f2a51515`，merged_at 2026-09-20T02:09:33Z） |
| 施工分支 | `dev-chore-111-r1` @ `75f3c6e`，19 个文件一次提交；分支保留未删 |
| 评审 | 人工评审通过（松哥 2026-09-20）；🔴 自动 Review 闸门当时处于空档（Codex Controller 已暂停、Cursor 侧未出现评审），未发起任何自动 Review |
| CI | `validate` 红为既有 born-red（`LOC-042 consumer_chains` + `dsh-visual-workflow` 包测试），本地同命令对照 main 与本源失败要点逐字一致；main 自 2026-09-08 起持续红，修复在途于 #218 |
| 验收 | 规格 §8 八条全部达成；UAT-01 真实发号产生一次性探针 #222（已关闭），UAT-03/04 由单测与只读调用覆盖 |
| 灾备镜像 | `Mirror to CNB` 对 `eea2b99` 运行 success |
| 证据保留 | `evidence_expires_at = null`——本任务未建 `.agent-runs` 运行现场，UAT 证据在本轮会话与本卡/规格内，无归档证据包，故不起算保留期 |
| 遗留 | #215 已关闭；`dev-chore-111-r1` 工作区待回收；收口账本经 PR（本文件所在的小 PR）补登，暴露的流程缺陷见规格 §13 与本 PR 说明 |

## 关联

- `docs/tasks/specs/CHORE-111-numbering-source-migration/decision-tickets/DT-01-numbering-collision.md`（历史号段冲突处置，**已裁定 A 并执行完毕**）
- `docs/tasks/FIX-109-closeout-tooling-gaps.md`（同文件改动，当前「定义中」未开工 → 非硬依赖，见规格 §9）
- `docs/tasks/CHORE-110-acceptance-package-schema.md`（无文件重叠，可并行）
- `docs/tasks/CHORE-106-close-task-issue.md`（CNB 收口适配器来源，本票新增 GitHub 路径与其并存）
- `wayfinder/tickets/SYNC-01-cnb-to-github-sync-plan.md`（同步工单，主源反转后口径需更新，本票不改写历史工单）
- GitHub issue #215（本票主源锚点，由 cnb#111 于 2026-09-19 转移；因 GitHub `#111` 已被已合并 PR 占用不可回收，故取新号）
