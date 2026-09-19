# CHORE-111 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-111` |
| 远端 issue | cnb#111（编号由 CNB 远端发号，本票即为迁移前的最后一批 CNB 号） |
| 需求来源 | 会话录入 |
| 来源定位 | 松哥 2026-09-19 决策：GitHub 账户恢复，后续以 GitHub 为主源、CNB 为灾备镜像；发号源单独立票迁移 |
| 任务名称 | 任务编号发号源从 CNB 迁移到 GitHub（编号连续性 + 历史号段冲突处置） |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P2 |
| 当前状态 | 待确认 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-111-numbering-source-migration/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | pending |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据：迁移点全部落在仓库脚本内部（远端解析、发号调用、门禁文案、适配器白名单），无外部不可逆动作；唯一需人工取舍的是历史号段冲突处置口径，已单列决策票。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`，附加自然语言会导致实施前检查失败。

## 摘要（三要素速览）

### 任务目标

把任务编号的**发号源**从 CNB 服务端迁到 GitHub 服务端，使 `<TYPE>-<号>` 的号继续由远端分配（保持「禁止本机自增号」的防撞号属性），同时把与主源相关的门禁文案、收口提示、适配器白名单一并对齐到「GitHub 为主源、CNB 为灾备镜像」的新口径。

### 涉及范围

- 做：
  - **发号链路改造**：`scripts/local-task-registry.mjs` 的 `resolveRemoteSlug`（现只读 `git remote get-url cnb`）与 `remoteAllocate`（现调 `cnb issues create-issue`）改为支持 GitHub 远端并经 `gh issue create` 取号；`allocate` 的 `remote` 字段写 `github#<号>`
  - **编号格式**：新任务 `task_id = <TYPE>-<GitHub issue 号>`，与现格式保持同构
  - **降级路径**：GitHub 不可达时仍降级为 `TMP-<机器码>-<日期><序号>`，**禁止静默回落到 CNB 发号**
  - **同步脚本改造**：`scripts/remote-issue-sync.mjs`（现整脚本 CNB 专用，L112/L139 写 `cnb#<号>`）改为以 GitHub 为目标的同步通道
  - **口径文案对齐**：`scripts/local-task-merge.mjs` L410 收口提示串、`scripts/validate-task-spec-sync.mjs` L10 门禁文案、`scripts/ai-task-candidate-collect.mjs` L13 注释
  - **收口适配器**：`scripts/delivery-closeout-host.mjs` L25 `KNOWN_ADAPTERS` / L26 `UNAVAILABLE_ADAPTERS=['github']` 增加或改造 GitHub 适配器
  - **历史号段冲突处置**：按决策票 `DT-01` 裁定执行（GitHub #106–#110 已被占位，与本地 `FIX-109`/`CHORE-110` 撞号）
  - **测试**：新增覆盖「GitHub 发号成功」「GitHub 不可达降级 TMP」「历史任务字段不被改写」的单测
- 不做：
  - **不改历史任务的 `task_id`**——`FIX-109`/`CHORE-110` 等已发布号保持原样，不做全量重编
  - **不改历史任务的 `remote` 字段值**——`cnb#N` 是当时的事实记录，保留为历史事实
  - 不迁移 GitHub 上既有 issue 的内容与评论
  - 不改动 `docs/tasks/registry.json` 中既有任务的业务字段（状态、分支、merge 等）
  - 不改动 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进）
  - 不改动 `.github/workflows/mirror-cnb.yml`（镜像机制已上线且实测成功，不在本票范围）

### 验收标准

1. 执行 `node scripts/local-task-registry.mjs allocate --name <名称> --type <TYPE>` 后，新任务 `task_id` 为 `<TYPE>-<GitHub issue 号>`、`remote` 为 `github#<号>`，且该 issue 在 `crystepj-max/workflow-manager` 上确实存在、标题与任务名一致。
2. 在无网络或 `gh` 未登录的模拟条件下执行 `allocate`，结果为 `TMP-*` 临时号且 stderr 有明确告警；**不得**出现 `cnb#N` 形式的号。
3. 迁移后执行 `git diff docs/tasks/registry.json`，除新增任务条目外，**既有任务的 `task_id` 与 `remote` 字段零改动**。
4. `npm run validate:task-context` 与 `node scripts/validate-task-spec-sync.mjs` 全绿，门禁文案中不再出现「必须有远端（CNB）issue 号」这类与现状矛盾的表述。
5. 新增单测覆盖发号成功、不可达降级、历史字段不变三条路径，且既有本地测试套件未引入新失败。

## 关键证据（2026-09-19 实测）

| 项 | 实测结果 |
|---|---|
| GitHub 可用性 | `gh auth status` 已登录 `crystepj-max`，scope 含 `repo`/`workflow` |
| GitHub 分支保护 | **已撤销**（`gh api repos/.../branches/main/protection` 返回 404 `Branch not protected`）→ 与旧记忆「禁止直推」前提相反 |
| 镜像机制 | `.github/workflows/mirror-cnb.yml`（PR #205 合入，`452ee07`）已上线；运行 `35418948093` 实测 **success 13s**；只允许快进，CNB 领先时失败等人工回灌 |
| 发号源绑定位置 | `local-task-registry.mjs` L72–80 `resolveRemoteSlug`、L91–113 `remoteAllocate`、L328–359 `allocate` |
| 号段冲突（已处置） | GitHub #108/#109/#110 原为 2026-08-30 误建占位 issue，与本地 `FIX-108`/`FIX-109`/`CHORE-110` 直接撞号；经 `DT-01` 裁定 **A · 复用占位号对齐**，2026-09-19 已执行完毕（三号重命名为对应任务正式 issue + 重开 + 打类型标签）；`#106` 是真实 issue（有 parent #76）**不动**，`CHORE-106` 锚点保留 `cnb#106` |
| 历史号规模 | `registry.json` 共 71 个任务，`remote` 全为 `cnb#N`；`github_sync` 中 69 个 `pending`、2 个 `synced#203/#204` |
| 登记册脏改动来源 | 本票落档时 `docs/tasks/registry.json` 已含并行会话对 `FIX-108` 的「本地已定义→等待验收」推进（revision 97→98），本票代入且内容未改动 |

## 关联

- `docs/tasks/specs/CHORE-111-numbering-source-migration/decision-tickets/DT-01-numbering-collision.md`（历史号段冲突处置，**已裁定 A · 复用占位号对齐并执行完毕**）
- `docs/tasks/specs/CHORE-111-numbering-source-migration/task-spec-V1.md`
- `docs/tasks/FIX-109-closeout-tooling-gaps.md`（收口脚本口径缺口，与本票同区域改动，需排先后）
- `docs/tasks/CHORE-110-acceptance-package-schema.md`（验收包 schema，与本票同期待裁定）
- `wayfinder/tickets/SYNC-01-cnb-to-github-sync-plan.md`（同步工单，主源反转后口径需同步更新）
