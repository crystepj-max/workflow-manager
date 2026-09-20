# 任务规格 V1 · CHORE-111 任务编号发号源从 CNB 迁移到 GitHub

| 项 | 值 |
|---|---|
| 任务标识 | `CHORE-111` |
| 远端 issue | `cnb#111`（历史锚点）+ `github#215`（主源锚点） |
| 规格版本 | V1 |
| 需求基线 | V1 |
| 编写日期 | 2026-09-19 |
| 优先级 | P2 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 当前状态 | 已定义（登记册机器取值 `本地已定义`，见 §14） |

> V1 修订说明（2026-09-19 复核轮）：本版本在 2026-09-19 立票版基础上，按 Definition Check 复核新发现的 4 处缺口与松哥裁定重写 §3/§5/§8/§12，并更正 §11 与任务卡中「GitHub 分支保护已撤销」的错误事实。
> 基线确认：松哥于 2026-09-19T14:08:57Z 确认 V1（复核修订版）并授权开工实施。

---

## 1. 背景

2026-09-19 松哥决策：GitHub 账户已恢复，后续**以 GitHub 为主源**，CNB 转为**灾备镜像源**。镜像机制已落地并实测通过（`.github/workflows/mirror-cnb.yml`，PR #205，运行 `35418948093` success 13s）。

代码主源方向已定，但**任务编号的发号源**仍绑在 CNB：

- 编号格式 `<TYPE>-<远端 issue 号>`（`TYPE ∈ FEAT|FIX|CHORE`），号由远端服务端分配，本机不自增——这是防双机/多会话撞号的既有机制，**必须保留**。
- 但发号实现只认 CNB：`resolveRemoteSlug` 读 `git remote get-url cnb`；`remoteAllocate` 调 `cnb issues create-issue`。

结果：主源已是 GitHub，新增任务的号却仍由 CNB 签发，出现「主源与发号源分离」的口径不一致。

## 2. 用户问题

执行者按现行工具与文档新建任务时，号仍由灾备镜像（CNB）签发；收口时脚本会把发布目标解析成 CNB。也就是说，**主源切换在工具层没有生效**，日常操作仍被引导回旧平台，且不会报错。

## 3. 现状与改造点定位

以下 12 处位置、现状描述与行号已于 2026-09-19 逐条读取源码核对。

### 3.1 发号链路

| # | 文件 | 位置 | 现状 | 迁移后 |
|---|---|---|---|---|
| 1 | `scripts/local-task-registry.mjs` | L71–80 `resolveRemoteSlug` | 只 `git remote get-url cnb`，取不到返回 null | 优先解析 GitHub 主源远端（`origin`，或 URL 含 github.com 的远端），CNB 仅作灾备不参与发号 |
| 2 | 同上 | L91–113 `remoteAllocate` | 调 `cnb issues create-issue --repo <slug>`，正则取 `"number"` | 调 `gh issue create --repo <owner/repo>`，从返回的 issue URL 尾段取号；函数保持可注入（参照 CHORE-106 `setCnbRunner` 模式）供离线单测 |
| 3 | 同上 | L328–359 `allocate` | `taskId = <TYPE>-<number>`；`remote = cnb#<number>` | `remote = github#<number>`；降级分支不变 |
| 4 | 同上 | L343–347（`allocate` 内 `!remoteSlug` 分支） | 未配置远端的仓库回落**本机自增** `LOC-<序号>`，`remote='none'` | **保留该分支**（`workspace-isolation` / `node-isolation` 等既有测试依赖临时目录无远端路径），但其触发前提改为「无 GitHub 远端」；有 GitHub 远端但 `gh` 失败时必须走 `TMP-*` 而非本机自增 |
| 5 | 同上 | L25 / L30 注释 | 「号由 CNB 服务端分配」 | 改为 GitHub，并保留「禁止本机自增」原则表述 |

### 3.2 同步与收口链路

| # | 文件 | 位置 | 现状 | 迁移后 |
|---|---|---|---|---|
| 6 | `scripts/remote-issue-sync.mjs` | L112 / L114 / L139 | 写 `t.remote = cnb#<number>`、`done.push(... cnb#...)` | 改为 GitHub 通道，写 `github#<number>` |
| 7 | `scripts/local-task-merge.mjs` | L394–411 | 用严格正则 `^([a-z]+)#(\d+)$` 解析 `remote`；再 `git remote get-url <system>` 取 slug；提示串为 `cnb issues update-issue …` | ① 解析放宽为**平台无关**：支持单值 `<system>#<N>`、双锚点 `cnb#N + github#M`、空格式 `GitHub #N`，并对多锚点分别产出待关闭项；② 平台名→git 远端名映射（`github` → `origin`，本仓库无名为 `github` 的远端）；③ 提示串改为 `gh issue close --repo <owner/repo> <N>` 形态 |
| 8 | `scripts/validate-task-spec-sync.mjs` | L10 | 门禁文案「必须有远端（CNB）issue 号」 | 平台无关表述「必须有远端 issue 号」 |
| 9 | `scripts/ai-task-candidate-collect.mjs` | L13 | 注释「远端（CNB）候选不在本脚本范围」 | 平台无关表述 |
| 10 | `scripts/ai-task-dispatcher.mjs` | L32 | 注释示例 `"remoteIssueCommand": "cnb issues …"` | 改为 GitHub 形态示例（复核轮新增：立票版遗漏此点） |

### 3.3 收口适配器（本票工作量最大项）

| # | 文件 | 位置 | 现状 | 迁移后 |
|---|---|---|---|---|
| 11 | `scripts/delivery-closeout-host.mjs` | L25 / L26 / L199–200 | `KNOWN_ADAPTERS=['local','no-op','cnb']`；`UNAVAILABLE_ADAPTERS=['github']`；命中即 `capability_unavailable` | `github` 进入 `KNOWN_ADAPTERS` 并移出 `UNAVAILABLE_ADAPTERS` |
| 12 | 同上 | L215–228 `resolveAdapter`；L60–170 动作实现；L441 提示串 | 目标解析顺序为：`remoteName==='github'` → 直接判不可用；否则只要存在 `cnb` 远端即返回 `adapter='cnb'`。**本仓库 `git config --get remote.pushDefault` 实测为 `cnb`** → 收口动作实际会解析到 CNB，即向灾备镜像执行对外动作 | 目标解析按「GitHub 为主源、CNB 为灾备」重排：仓库配了 GitHub 远端即以 GitHub 为目标（`pushDefault` 仍写着 cnb 时照常按主源解析，并把差异记入 `push_default_conflict`，脚本不改 git 配置）；新增 `github` provider：`close-task` 先查状态再经 `gh issue close`（WR-012 防重：已关闭只确认不重发），失败**不得**降级 CNB；L441 人工提示串同步改 GitHub 形态。**实施轮收窄**：`create-review` / `merge` 与 cnb 适配器同形态——只登记效果，不代为创建或合并 PR（真实 PR/Git 动作由调用方在收口之外完成；若此处再发一次 `gh pr` 会把对外动作重复执行）。验收 6 只要求 `close-task` 经 `gh` 执行，该收窄不改变任何验收条 |

> 立票版 §3 第 9 行只写「L25/L26 增加或改造 GitHub 适配器」。复核发现该文件是一整套 CNB 适配器（含状态查询、关闭、目标解析），仅放开白名单会得到「已知但未接线」的适配器，且 L215–228 的解析缺陷（收口发布到灾备镜像）原样保留。已按松哥裁定纳入本票，见 §12 决策 D-04。

### 3.4 操作真源文档口径

| # | 文件 | 位置 | 现状 | 迁移后 |
|---|---|---|---|---|
| 13 | `docs/tasks/README.md` | L16 命令注释、L25 `--remote` 示例、L27 同步小节标题、L47 硬规则 3 | 「号由 CNB 服务端发」「远端（CNB）issue 同步」「活跃任务必须有远端（CNB）issue 号」，示例写 `--remote cnb#123` | 四处改为 GitHub 主源口径，示例写 `--remote github#123`；历史 `cnb#N` 取值仍按 §11 保留说明 |
| 14 | `dsh/skills/requirements-analysis/SKILL.md` | L262 起「任务标识分配」段 | 「由远端（CNB）发号」「同时在 CNB 建好对应 issue」 | 改为 GitHub 发号口径，并写明禁止回落 CNB、历史 `cnb#N` 保留不重编。该文件是本仓库内需求分析技能真源，不改则下一轮定义仍会被引导走 CNB |
| 15 | `dsh/roles/closeout.md` | L18 | 「目标 GitHub 或未知适配器时记 `capability_unavailable`，不回落发布到 CNB」 | 与 §3.3 的新适配器行为对齐：GitHub 为主源、`pushDefault=cnb` 时按主源解析并留痕、继续禁止回落 CNB |
| 16 | `scripts/night-batch-machine.example.json` | L19 | `"remoteIssueCommand": "cnb issue list --repo chris.ai/workflow-manager"` | 改为 `gh issue list --repo crystepj-max/workflow-manager`（实施轮新增：夜间批次机器配置示例是执行者直接复制的模板，属 D-05「操作真源」同一类） |

## 4. 目标

把发号源迁到 GitHub，使 `<TYPE>-<号>` 的号继续**由远端分配**（保留防撞号属性），并把发号链路、同步链路、收口提示、收口适配器与操作真源文档一并对齐到「GitHub 为主源、CNB 为灾备镜像」的口径。

交付后可观察变化：新建任务拿到 `github#N` 并在 GitHub 上真实存在；收口工具不再把对外动作指向 CNB；照 README / 技能文档操作的人不再被告知去 CNB 发号。

## 5. 非目标

- **不改历史任务的 `task_id`**——`FIX-109` / `CHORE-110` 等已发布号保持原样，不做全量重编。
- **不改历史任务的 `remote` 字段值**——包括 §11 列出的 8 条不规范取值，一律原样保留（规范化另立小票，见 §12 决策 D-03）。
- 不迁移 GitHub 上既有 issue 的内容与评论。
- 不改 `registry.json` 既有任务的业务字段（状态、分支、merge 等）。
- 不改 `.github/workflows/mirror-cnb.yml`（镜像机制已上线且实测成功）。
- 不改 FEAT-84/85/86 相关工作流 UI 交互（由 ZCODE 推进）。
- **不修改任何机器本地 git 配置**（含 `remote.pushDefault`）——按仓库约定 git config 不由 Agent 改动；`pushDefault=cnb` 通过 §3.3 的代码层解析优先级处置，并在 §13 记为已知限制。
- 不改写 `docs/design/ai-task-define-delivery/*` 与 `wayfinder/tickets/SYNC-01*`（历史决策与提案记录，保留当时口径）。

## 6. 方案

### 6.1 发号链路

```
allocate()
  ├─ resolveRemoteSlug(repo)    → 优先 GitHub 主源远端（origin / github.com URL）
  ├─ remoteAllocate()           → gh issue create --repo <owner/repo> --title <name> --label <type>
  │                                从返回的 issue URL 尾段取号
  └─ 失败 → tmpId() 降级 TMP 号（禁止静默回落 CNB 发号）
```

### 6.2 编号格式

保持同构：`task_id = <TYPE>-<号>`，`remote = github#<号>`。

历史任务的 `task_id` 与 `remote` **一律不动**——号是历史事实，重编会牵动卡片文件名、分支名、标签名与所有引用，成本远高于收益。

### 6.3 历史号段冲突（已裁定：A · 复用占位号对齐，已执行完毕）

GitHub `#106` / `#108` / `#109` / `#110` 曾被 2026-08-30 误建的占位 issue 占用，其中 #109/#110 与本地 `FIX-109`（cnb#109）、`CHORE-110`（cnb#110）直接撞号。经 `DT-01` 裁定采用 A 方案，2026-09-19 执行完毕，**执行结果已复核**：

| GitHub 号 | 复用为 | 2026-09-19 实测状态 |
|---|---|---|
| #108 | `FIX-108` | CLOSED，label `bug` ✓ |
| #109 | `FIX-109` | OPEN，label `bug` ✓ |
| #110 | `CHORE-110` | OPEN，label `documentation` ✓ |
| #106 | 不处置（真实 issue，有 parent #76） | CLOSED，标题未改 ✓ |

- **GitHub issue 编号不可回收**（删除后不复用），故复用是零断裂、零浪费的唯一路径。
- 新任务号由 GitHub 服务端按当前最大号 +1 继续分配。

裁定明细见 `decision-tickets/DT-01-numbering-collision.md`。

## 7. 交付范围

**做**：§3.1–§3.4 共 16 处改造点（含 4 处文档/配置模板口径）+ §3.3 的 GitHub provider 与目标解析重排 + 新增单测。

**不做**：§5 全部。

## 8. 验收标准

1. `node scripts/local-task-registry.mjs allocate --name <名称> --type <TYPE>` 后，新任务 `task_id = <TYPE>-<GitHub issue 号>`、`remote = github#<号>`，且该 issue 在 `crystepj-max/workflow-manager` 上确实存在、标题与任务名一致。
2. 模拟 `gh` 未登录 / 无网络时执行 `allocate` → 产出 `TMP-*` 号且 stderr 明确告警；**断言不出现 `cnb#` 形式的号**。
3. `git diff docs/tasks/registry.json` 中既有任务的 `task_id` 与 `remote` 字段**零改动**（含 §11 的 8 条不规范取值）。
4. **不新增门禁失败（相对基线）**：开工第一步记录 `npm run validate:task-context` 与 `node scripts/validate-task-spec-sync.mjs` 的当前失败清单作为基线（2026-09-19 实测为 3 项 `spec-untracked`：CHORE-113、FEAT-114、FEAT-75，均属并行会话在途产物），收口时逐项比对，要求**本票改动项全部通过、且不新增失败项**；基线清单与比对结果写入 Run 证据。门禁文案中不再出现「必须有远端（CNB）issue 号」。
5. 新增单测覆盖：发号成功 / 不可达降级 / 历史字段不变三条路径；既有测试套件无新失败。
6. 收口目标解析在 GitHub 主源下结果为 `github`（不再因 `pushDefault=cnb` 解析到 CNB）；`adapter='github'` 时 `close-task` 走 `gh issue close`，动作失败不得改由 CNB 执行。
7. `local-task-merge` 对 `cnb#N + github#M`（双锚点）与 `GitHub #N`（空格式）两类取值能产出待人工关闭提示，不再静默跳过。
8. §3.4 三处操作真源文档不再出现「CNB 发号 / 必须有远端（CNB）issue 号」口径。

## 9. 实施要点

- 发号与适配器函数须保持**可注入**（参照 CHORE-106 的 `setCnbRunner` 模式），否则单测无法离线断言成功路径。
- `gh issue create` 输出为 issue URL（形如 `https://github.com/<owner>/<repo>/issues/<N>`），取号用尾段数字，勿依赖 `--json`（`create` 子命令不支持该参数）。
- GitHub 远端名映射：本仓库 `git remote -v` 实测为 `origin`（github.com）、`cnb`、`mirror`（本地镜像），**没有名为 `github` 的远端**；凡按平台名反查 git 远端的代码都要走映射，不得直接 `get-url github`。
- 与 `FIX-109` 在 `local-task-registry.mjs` / `local-task-merge.mjs` **同文件**改动。**实施轮更正前提**：立票版记「FIX-109 未开工」，实为 `dev-fix-109-r1` 分支已在施工（改 `local-task-merge.mjs` 4 个 hunk：L100 后加 `extractRangeText`、L221 后加 `commitRegistryWriteback`、L270 与 L361 两处替换）。逐个 hunk 比对确认：**均不触及本票要改的 L388–414 `pendingManualClose` 区域**，只造成其后行号漂移 → 维持「非硬依赖」判定，本票以 main 为基线施工，合并时由 `local-task-merge` 的冲突自动中止机制兜底。
- 与 `CHORE-110` 无文件重叠，可并行（`dev-chore-110-r1` 未改 `scripts/`）。

## 10. 已确认的关键决策及原因

| # | 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|---|
| D-01 | 历史号段冲突处置 | **A · 复用占位号对齐** | GitHub 编号不可回收，复用是零断裂零浪费的唯一路径；实际撞号仅两处 | 松哥 | 2026-09-19 |
| D-02 | 验收标准 4「门禁全绿」不可达如何定 | **改为「相对基线不新增失败」** | 门禁当前因并行会话未跟踪规格而红，强求全绿会迫使本票代提交别人的在途产物，越界且把半成品固化进主干 | 松哥 | 2026-09-19 |
| D-03 | `remote` 字段格式与解析点 | **修解析 + 新格式，历史 8 条值不动** | 解析放宽属修复迁移引入的功能断裂；规范化历史值是另一件事，另立小票，同时守住「历史 `remote` 零改动」非目标 | 松哥 | 2026-09-19 |
| D-04 | GitHub 收口适配器做到哪一层 | **实现最小 GitHub 适配器**（解析优先级 + close-task / PR 动作 + 文档口径） | 现状 `pushDefault=cnb` 会把收口对外动作指向灾备镜像，与「不回落发布到 CNB」的既有角色约定直接冲突；仅放开白名单会得到未接线的适配器 | 松哥 | 2026-09-19 |
| D-05 | 文档口径对齐范围 | **只纳入操作真源 3 处**（`docs/tasks/README.md`、`dsh/skills/requirements-analysis/SKILL.md`、`dsh/roles/closeout.md`） | 这三处直接指导执行者动作，不改则切换后仍被引导走 CNB；`docs/design/*` 与 wayfinder 工单是「当时为什么这么定」的历史记录，改写会破坏决策留痕 | 松哥 | 2026-09-19 |
| D-06 | 无人值守许可 | **允许** | 全部改动落在仓库脚本、文档与单测内；对外动作（发号、关 issue）均在已授权的 GitHub 主源仓库且可回退；无必须施工中由人取舍的产品问题 | 松哥 | 2026-09-19 |

> 未决产品事项：**0**（D-01～D-06 已全部落定；复核轮新增的 4 项已在本表 D-02～D-05 关闭）

## 11. 数据现状与边界场景

**登记册规模（2026-09-19 实测）**：`registry.json` 共 **77** 条任务；状态分布 已合并 62 / 定义中 7 / 待确认 3 / 已取消 2 / 本地已定义 2 / 已完成 1。

> 更正：立票版记「71 个任务，`remote` 全为 `cnb#N`」——复核时并行会话已新增条目，且 8 条取值并非纯 `cnb#N`。

**`remote` 取值不规范的 8 条**（D-03 裁定本票不动其值，但 §3.2 第 7 项要求解析层能容忍）：

| 任务 | `remote` 值 | 形态 |
|---|---|---|
| LOC-018 / CHORE-75 / FIX-108 / FIX-109 / CHORE-110 / CHORE-111 | `cnb#N + github#M` | 双锚点 |
| FEAT-208 / FEAT-75 | `GitHub #N` | 空格 + 首字母大写 |

**边界场景**：

- 仓库无 GitHub 远端（临时目录、测试仓）→ 保留 `LOC-<序号>` + `remote='none'` 分支并告警（既有测试依赖此路径）。
- 有 GitHub 远端但 `gh` 未登录 / 无网络 → `TMP-*` + `remote='pending'`，**不得**回落 CNB。
- `remote` 为多锚点 → 收口提示需为每个锚点分别列出（CNB 侧历史 issue 仍需人工关闭）。
- 已合并任务的 `remote` 不重算，本票不追溯补写 GitHub 锚点（由 `remote-issue-sync` 的既有 pending 通道处理）。

## 12. UAT 场景

### UAT-01 GitHub 发号成功

- 验收目的：证明新任务号由 GitHub 服务端签发。
- 前置条件：`gh auth status` 已登录且 scope 含 `repo`；仓库已配置 GitHub 远端。
- 操作步骤：
  1. 在隔离工作副本执行 `node scripts/local-task-registry.mjs allocate --name "UAT 发号探针" --type CHORE`；
  2. 读取返回的 `task_id` 与 `remote`；
  3. `gh issue view <号> --json title,state`。
- 预期结果：
  1. `task_id` 形如 `CHORE-<号>`，`remote` 为 `github#<号>`；
  2. GitHub 上该 issue 存在且标题为「UAT 发号探针」；
  3. 输出与登记册中均不出现 `cnb#`。
- 建议人工关注：探针 issue 用后是否按预期由人工关闭（本 UAT 允许产生一次性可清理 issue）。

### UAT-02 不可达降级

- 验收目的：证明降级只走 TMP，不静默回落 CNB。
- 前置条件：以注入方式使 `gh` 调用失败（未登录或非零退出）。
- 操作步骤：执行 `allocate`，观察 stdout 与 stderr。
- 预期结果：`task_id` 匹配 `TMP-*`，`remote='pending'`，stderr 有明确告警与换号指引；无 `cnb#` 产出。

### UAT-03 收口目标解析与待关闭提示

- 验收目的：证明收口不再指向灾备镜像，且不规范锚点不再静默。
- 前置条件：仓库保持 `remote.pushDefault=cnb`（不改配置）。
- 操作步骤：
  1. 以只读方式调用 `delivery-closeout-host.mjs` 的目标解析，读取 `adapter` / `target_ref`；
  2. 对 `remote` 为 `cnb#111 + github#215` 的任务执行 `local-task-merge.mjs --dry-run`，读取 `pendingManualClose`。
- 预期结果：
  1. `adapter` 为 `github`，且不存在任何向 CNB 发布的动作计划；
  2. `pendingManualClose` 同时列出 CNB 与 GitHub 两个待关闭项，GitHub 项提示串为 `gh issue close` 形态且带 `owner/repo`。

### UAT-04 历史字段零改动

- 验收目的：证明迁移不触碰历史事实。
- 操作步骤：完成全部改动后执行 `git diff docs/tasks/registry.json`。
- 预期结果：diff 仅含新增条目与本票自身字段推进；§11 的 8 条 `remote` 值与其他历史条目逐字节不变。

## 13. 风险与已知限制

| 风险 | 影响 | 处置 |
|---|---|---|
| `pushDefault=cnb` 属机器本地配置，本票不改 | 换一台机器或换个人施工，解析前提不同 | 按 D-04 在代码层以主源优先解析；§12 UAT-03 显式覆盖该组合；已知限制见下 |
| 号段跳变导致新旧号不连续 | 阅读与检索困惑 | 登记册保留 `remote` 作平台锚点；文档说明切换日期与号段分界 |
| 误改历史任务字段 | 牵动卡名/分支名/引用 | 单测 + UAT-04 断言零改动（验收 3） |
| 双源并存期撞号 | 两边各发一个同号 | 迁移一次完成，切换后禁止 CNB 发号；`allocate` 断言不产出 `cnb#` |
| `gh` 未登录导致静默降级 | 误用 TMP 号当正式号 | 降级时 stderr 明确告警；`remote='pending'` 标注 |
| GitHub 适配器为新建路径，缺真实收口验证 | 收口动作可能在实际 PR 流程中失败 | 动作失败不得降级 CNB；首次真实收口须人工在场确认，不列入无人值守范围 |

**已知限制**：

- 本票不修改 `git config`（含 `remote.pushDefault`）。若需从配置层根治，须由人工决定并另行执行。
- 8 条不规范 `remote` 取值本票仅容忍不规范化，长期清理另立小票（D-03）。
- `dsh/skills/requirements-analysis/SKILL.md` 改后需经技能分发链路同步到各助手入口才算生效；本票只保证仓库真源正确。
- **GitHub 适配器只把 `close-task` 接到真实 `gh` 调用**；`create-review` / `merge` 与既有 cnb 适配器同形态——登记效果而不代为执行 PR 动作（真实 PR/推送由调用方在收口之外完成）。若要让收口 host 直接建/并 PR，须另立一票并先解决「重复对外动作」的防重设计。
- 同区域发现的**票外遗留项**（本票不改，登记为后续事项）：`local-task-merge.mjs` L97 在收口提交信息里硬编码 `GitHub 同步: 待补 issue`——主源切换后多数任务其实已同步，该句会长期失真。属独立文案修正，与本票 8 条验收无关。

## 14. 状态词汇说明

登记册 `STATUSES` 枚举中「定义完成」的机器取值是 **`本地已定义`**（无 `已定义`），本票落档时：`registry.json` 写 `本地已定义`（机器词汇），GitHub issue #215 的需求基线状态写 **已定义** 并打 `ready-for-agent`（对外口径）。两者指同一状态，不是矛盾。

## 15. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1（立票版） | 2026-09-19 | 初版：9 处改造点 + DT-01 处置 | 未确认 |
| V1（复核修订） | 2026-09-19 | 补 D-02～D-05 四项裁定；改造点 9→15（含 ai-task-dispatcher 与收口适配器解析层、3 处文档口径）；验收 5→8 条；更正「分支保护已撤销」为 ruleset PR-only；新增 §11 数据现状 / §12 UAT / §14 状态词汇 | 松哥（确认基线并授权开工） |
| V1（实施轮更正） | 2026-09-19 | 不改基线判定，只把实施中发现的事实写回：① §9 更正「FIX-109 未开工」前提（`dev-fix-109-r1` 在途，4 个 hunk 均不碰本票区域）；② §3.4 增第 16 处 `night-batch-machine.example.json`；③ §3.3 记 `create-review`/`merge` 收窄为登记效果（不重复执行对外动作），并落 §13 已知限制与一条票外遗留项 | 实施记录（不改变已确认的 8 条验收） |
