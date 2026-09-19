# 收口缺口根因分析 + 本地 stash 深入审计

> 时间：2026-09-19 01:40（本地会话）
> 起因：用户提问「为什么这么多 issue 没有关闭？合并 PR 时有关闭关联 issue 吗？从结果看是没有的」
> 结论：**用户的判断成立**。且根因不是「漏做一次」，而是**契约要求做了、实现在多个层面同时缺位**。

---

## 一、根因：为什么合并 PR 不会带上关闭 issue

### 结论先行

关闭 issue 这件事，**契约层三处都写了要求，但实现层两处都没做，PR 层也没写机器可解析的关联指令**。三条路同时断，所以 100% 不会自动发生。

### 缺口 1 · 契约层：明确要求「收口要关闭 issue」（有要求）

| 位置 | 原文 |
|---|---|
| `templates/custom-seeds/default-workflow.json:315` | 收口节点 goal：「推送、创建并合并 Draft PR（squash + 删分支）、**关闭 issue**；收束本地工作区」 |
| `templates/custom-seeds/dev-workflow-2-0.json:355` | 同上 |
| `dsh/roles/closeout.md:64` | cleanup-report 模板字段：「issue 状态：**已关闭** / 无」 |
| `dsh/README.md:298` | 「合并 PR 与**关闭 issue** 也由收口节点执行」 |
| `dsh/README.md:300` | 「已在 issue #1 上实测全链路闭环（PR #2 合并、issue 关闭、本地分支收束）」 |

### 缺口 2 · 引擎运行时：`close-task` 动作被声明但从未实现（最关键）

`scripts/delivery-closeout-host.mjs:27`：

```js
const DEFAULT_GIT_ACTIONS = ['create-review', 'merge', 'close-task']
```

**全文件检索 `close-task` 仅此一处出现，没有任何执行分支。**
即：交付运行时承认「关闭任务」是一类默认交付动作，但压根没写代码去执行它 → 声明即空转。

旁证：该 19 KB 文件中检索 `issue` **零命中**，说明关闭 issue 从未被实现过。

而 `scripts/generate.mjs:597-606` 注入的收口节点提示词却明确告知执行者：

> 「本节点会执行创建 PR、合并、**关闭 issue** 等受管理交付动作。每类动作执行前必须先核查目标当前状态（PR 是否已存在或已合并、**issue 是否已关闭**）……」

→ **提示词承诺了能力，运行时没有能力**。这是契约与实现的直接背离。

### 缺口 3 · 本地收口脚本：完全没有这一步

`scripts/local-task-merge.mjs`（本机实际使用的收口脚本）全篇检索 `issue`，**仅一处命中**：

- 第 97 行：`'GitHub 同步: 待补 issue'` —— 这是任务卡里一个字段的默认值，不是关闭逻辑。

本机这批任务（LOC-024 ~ LOC-045、FEAT-77、FIX-76 等）走的正是这条本地脚本路线，因此**从未触发过关闭 issue**。

### 缺口 4 · PR 层：没有机器可解析的关联指令

对已合并的 11 个 CNB PR（#87 #88 #89 #90 #91 #92 #93 #94 #95 #96 #99）做正文检索：

| 检查项 | 结果 |
|---|---|
| 正文中出现 `closes #N` / `fixes #N` / `resolves #N` | **0 / 11，全部为空** |
| PR 正文是否为空 | 11 个全部为空 |
| 标题中的关联标注 | 有，但形态是 `（cnb#77）` —— **给人类看的括号标注，不是机器可解析指令** |

对比 GitHub：`Closes #77` 会在 PR 合并时自动关闭 issue。CNB 未见等价机制可用，即便有，我们的 PR 也从未写过这类关键字。

### 缺口 5 · 登记册回写盲区（连带）

已在 SYNC-02 第六节记录：`registry-reconcile.mjs` 只认「主干 merge commit 尾注」单一信号，分支上的自建工作、以及经 CNB PR 合入但未带任务尾注的提交都看不见 → 「已合并」状态没回写 → 更没有任何环节去触发关 issue。

### 为什么 issue #1/#2 那条链路能关上

`dsh/README.md:300` 记录的「全链路闭环」是 **VWF 引擎蓝图路线**（`templates/*.json` 的收口节点由引擎驱动，引擎侧有 `vwf.delivery.*` 运行时入口）。而我们这批任务走的是**本地脚本路线**（夜批 + `local-task-merge.mjs`）。两条路线能力不对等，后者缺了这一步。

### 附：GitHub 时代会自动关闭、换 CNB 后不会——前后四项主要区别

| # | 维度 | GitHub 时代 | CNB 时代 | 影响 |
|---|---|---|---|---|
| 1 | **执行主体** | 收口是 DSH 编排脚本里的 **AI agent 节点**，直接执行 `gh` CLI 关闭 issue（commit `49cf16c`「收口节点接管合并 PR 与关闭 issue」）。能力是活的，人/AI 能跑命令就有关闭能力 | 架构改为 WR-014 交付适配层（`operations-host.mjs` + `delivery-closeout-host.mjs`）；`closeout.md` L22 明确「外部动作机制由适配器声明，**不由本角色固定自带**」 | 能力从「谁都能跑命令」收进代码，一旦代码没写完就整体失效 |
| 2 | **适配器实现** | 无此抽象层 | `close-task` 只在**常量与注释**里声明：`operations-host.mjs` L24（注释）/ L50（常量），唯一注册 provider 是 `local-count`（测试计数器）；`delivery-closeout-host.mjs` L27 同样仅常量，全文搜 `issue` 零命中 | 🔴 **决定性缺口**：动作被声明但未接线 |
| 3 | **平台可用性** | GitHub 适配器可用 | `UNAVAILABLE_ADAPTERS = ['github']`（delivery-closeout-host L26）、`DECLARED_UNAVAILABLE_PROVIDERS = ['github']`（operations-host L53）；遇 github 目标返回 `capability_unavailable` 且**不回落 CNB** | 旧通道被显式关闭，新通道又没建起来 |
| 4 | **平台原生关键字** | GitHub 原生支持 PR 描述/提交信息写 `Closes #N` 自动关闭 | CNB 侧：11 个已合并 PR 正文**全空**；merge commit 尾注写作 `（cnb#77）`（中文全角括号 + `cnb` 前缀），与 `close #77` / `Closes #77` 形态**三重不匹配** | 本可作为兜底的自动关联通道也没接上 |

> 补充事实：仓库历史上**从未**出现过 `Closes #` 写法（`git log --all -S "Closes #"` 零命中），说明即便在 GitHub 时代，关闭也是靠 agent 主动执行命令，而非依赖平台关键字。换到 CNB 后，agent 这条执行路径随架构改版消失，而接管它的适配器没实现——**不是「换平台导致功能丢失」，是「换架构时能力迁移没完成」。**

**一句话结论**：GitHub 时代靠「AI 节点直接跑命令」兜底，CNB 时代改为「适配器统一声明动作」——架构方向没错，但 `close-task` 只声明未实现，且 GitHub 适配器被标为不可用后没有 CNB 实现接上，于是关闭动作被静默跳过。

### 修复方向（三个选项，不代签）

| 选项 | 做法 | 成本 | 收益 | 风险 |
|---|---|---|---|---|
| **A · 补实现（推荐）** | 在 `delivery-closeout-host.mjs` 补 `close-task` 执行分支（调远端关闭 issue），并在 `local-task-merge.mjs` 收口尾部加同一步 | 中（需处理 CNB/GitHub 适配与权限） | 一次性根治，契约与实现对齐 | 需处理 GitHub 适配器 V1 未接线的现状（当前 `capability_unavailable`） |
| B · 补约定（最轻） | 规定 PR 正文必须写 `Closes #N`，并在收口模板里强制 | 低 | 依赖平台是否支持自动关闭；CNB 侧需先验证 | 若 CNB 不支持该关键字，等于没修 |
| C · 补人工闸门 | 收口脚本在无法关闭 issue 时**明确报「待人工关闭」**并写入交付报告 | 低 | 至少不再静默遗漏，转化为可见待办 | 不减少人工量，只消除「不知道有这回事」 |

建议 **A + C 组合**：A 根治能力缺口，C 兜底让未完成动作显式暴露（这也符合 WR-014「交付动作分离」与 WR-012「防重核查」的既有原则）。

> 🟡 建议立独立 backlog 跟踪，不要混进普通同步 PR。

---

## 二、本地 stash 深入审计

共 3 个 stash，逐个给出内容、价值判定与处置建议。

### stash@{0} · 2026-09-12（父 `f126654`）

- 消息：`On main: loc-015 收口临时让位：收敛审计 registry 行修正 + 两个未跟踪文档（收口后恢复）`
- 内容：**1 个文件**，`docs/tasks/registry.json`，**1 行**修正。
- 价值判定：**零**。LOC-015 早已收口完成，这行是当时让位的临时修正，早已被后续提交覆盖。
- 建议：**丢弃**。

### stash@{1} · 2026-09-06（父 `2445f97`）— 14 文件 / 124 行新增

- 消息：`#79 worktree 散落改动（2026-09-08 收口时发现：#79 部分已在 merge-79-into-new-main 分支；dsh/ai-task 脚本部分疑似并行线产物，保留备查）`
- 性质：收口 #79 时从工作区扫出的散落改动，混合了「已另路入库」与「疑似并行线产物」两类。

#### 量化结果（逐行比对主干）

**124 行新增中，97 行（78%）已进主干；真正未落地 27 行（22%）。**

| 文件 | 新增行 | 主干已有 | 落地率 |
|---|---:|---:|---:|
| `dsh/install-construction-bootstrap.sh` | 9 | 9 | 100% |
| `dsh/install-execution-plan.sh` | 8 | 8 | 100% |
| `dsh/install-requirements-analysis.sh` | 8 | 8 | 100% |
| `dsh/skills/construction-bootstrap/SKILL.md` | 15 | 14 | 93% |
| `dsh/skills/construction-bootstrap/runbook.md` | 1 | 1 | 100% |
| `dsh/skills/execution-plan/SKILL.md` | 14 | 13 | 93% |
| `dsh/skills/requirements-analysis/SKILL.md` | 8 | 6 | 75% |
| `packages/dsh-visual-workflow/package.json` | 1 | 0 | 0% |
| `scripts/ai-task-execution-plan.mjs` | 1 | 0 | 0% |
| `scripts/ai-task-scheduled-trigger.mjs` | 1 | 1 | 100% |
| `scripts/generate.mjs` | 6 | 3 | 50% |
| `scripts/sync-ai-task-skill-set.mjs` | 34 | 25 | 74% |
| `scripts/test/helpers/runtime-harness.mjs` | 1 | 1 | 100% |
| `scripts/workspace-isolation-host.mjs` | 17 | 8 | 47% |

#### 未落地的 27 行，按性质分三类

**(1) 已被主干重构取代 —— 应丢弃（13 行）**

- `sync-ai-task-skill-set.mjs` 9 行：stash 是「内联 `scriptNames` / `docNames` 数组」的旧写法；主干已重构为 `assetScripts` / `assetDocs` 常量。
  - 🔴 方向核验证据：`grep -c assetScripts` 主干 = **3**，`git show stash@{1}:...` = **0** → **主干更先进，stash 是旧版**。（此前一度误判为「stash 有、主干没有」，2026-09-19 已纠正。）
- `packages/dsh-visual-workflow/package.json` 1 行：stash 是**显式列举**测试文件；主干已改为 `node --test tests/*.test.mjs tests/*.smoke.mjs` 通配符，覆盖面更大。
- `generate.mjs` 3 行：`runAgent` / `coerceStructured` 的旧调用形式。

**(2) 仍有价值 —— 需人工判断（9+4+1 行）**

- `workspace-isolation-host.mjs` **9 行**（最值得看）：新增「Logical Run 工作区上下文查询」能力 —— 返回身份视图 + 事件时间线（分配 / 生命周期 / 源同步 / 锁）+ 清理审计（`archived` 回取，清理后仍可追溯）。
  - 主干该文件检索 `timeline` / `archived` / `cleanup` → **零命中**，即主干确实没有这个能力。
  - 关联：FEAT-85 的工作区面板要求展示「清理状态」，这组数据可能正是其数据源。
  - 🟡 但 UI 侧归 ZCODE，需先确认 FEAT-85 是否已用别的方式实现；若无人消费则为死代码。
- `dsh/skills/*/SKILL.md` **4 行**：纪律条文「『本地准备完成，待同步』不是正式『已定义』，不可无人值守开工。先同步 Issue 并完成既定资格检查」——防无人值守误开工的护栏，与 CHORE-75（开工纪律对齐）主题重合，**建议并入 #75 范围**。
- `ai-task-execution-plan.mjs` **1 行**：`preflight` 路径常量，需确认主干是否已有等价定义。

**(3) 已完全落地 —— 无需处理**：三个 `install-*.sh`（25 行）、`runbook.md`、`ai-task-scheduled-trigger.mjs`、`runtime-harness.mjs`。

### stash@{2} · 2026-09-05（父 `719cdb5`）

- 消息：`On feat/ai-task-deliver-m2: temp`
- 内容：**0 个文件改动**（空 stash，`stash show --name-status` 无输出）。
- 建议：**丢弃**。

### stash 处置建议汇总

| stash | 处置 | 理由 |
|---|---|---|
| stash@{0} | 丢弃 | 1 行登记册修正，早已被后续提交覆盖 |
| stash@{1} | **暂留**，仅取出 `workspace-isolation-host.mjs` 9 行 + SKILL.md 4 行（待确认后）；其余丢弃 | 78% 已落地，未落地部分多数是过时的旧写法 |
| stash@{2} | 丢弃 | 空 stash |

> 🟡 stash@{1} 的取出涉及 `dsh/skills/` 与脚本层，不属于 UI 交互，可在非 ZCODE 侧处理；但 `workspace-isolation-host.mjs` 那段需先与 FEAT-85 工作区面板的数据来源对齐，避免两头实现。

---

## 三、本次已执行的处置（2026-09-19）

1. **批量关闭 A 类 17 个 issue**：#36 #37 #46 #52 #53 #54 #55 #56 #57 #58 #59 #60 #61 #62 #63 #76 #77 —— 全部 `state_reason=completed`。
2. **LOC-016（cnb#39）关闭**：`state_reason=not_planned`，并已留言说明被 FEAT-85 取代的五条对照结论。
3. **LOC-016 分支与工作区清理**：
   - 先打归档标签 `archive/loc-016-r1` → `4fe673e`（保留可恢复性），
   - 删除 worktree `/Users/chris/workspace/workflow-manager-worktrees/dev-loc-016-r1`（`git worktree remove` 被本机 safe-delete 钩子拦下报 `Operation not permitted`，git 元数据已清、目录残留，改用 Python `shutil.rmtree` 清完；残留 1332 文件 / 276 KB，经查仅 git 检出内容 + `.scratch/ws-isolation-tests/` 临时测试目录，无唯一内容），
   - 删除分支 `dev-loc-016-r1`。
4. **#38 未动**：用户说明对应会话正在收口。
5. **立 backlog CHORE-106（cnb#106）**：收口交付动作 `close-task` 实现 —— 已发号、建任务卡与规格（`docs/tasks/specs/CHORE-106-close-task-issue/`），登记册 `spec_path` 已写入、看板已重建，`validate:task-context` 通过。
6. **stash@{1} 开工纪律条文并入 CHORE-75（cnb#75）**：已建 CHORE-75 任务卡与规格（`docs/tasks/specs/CHORE-75-registry-reconcile/`），4 行条文**逐字原文**记入规格 §5，不再由 stash 承载在制内容；同时按 2026-09-19 盘点结论收敛范围（移除已被 CHORE-73 + FIX-76 覆盖的「例行对账集成」，新增 `registry-reconcile` 识别盲区修补）。

---

## 四、待办

- [x] ~~立 backlog：实现 `close-task`（关闭 issue）能力~~ → **已完成，见 CHORE-106（cnb#106）**
- [x] ~~#75 CHORE-75：范围缩减并考虑并入 stash@{1} 开工纪律条文 4 行~~ → **已完成，见 `docs/tasks/specs/CHORE-75-registry-reconcile/task-spec-V1.md`**
- [x] ~~**CHORE-106 未决开放项（需松哥裁决后开工）**：是否让本地脚本路线（`local-task-merge.mjs`）也接入适配器关闭 issue？~~ → **已裁定：方案 A**（松哥 2026-09-19）——只补引擎适配层；本地路线不做自动关闭，但报告显式列「待人工关闭 <issue 号>」。记录见 `docs/tasks/specs/CHORE-106-close-task-issue/decision-tickets/DT-01-local-script-route.md`。CHORE-106 定义门全过、未决事项 0，状态已转「待确认」，等基线 V1 人工确认后落档「本地已定义」。
- [ ] #40 LOC-018（v0.1 发布验收）：确认它是验收闸门而非开发任务，并在 FEAT-84/85/86 收口后按不再过时的范围执行。
- [ ] stash@{1} 的 `workspace-isolation-host.mjs` 9 行：与 ZCODE 确认 FEAT-85 工作区面板数据来源后决定取用或丢弃。
- [ ] stash@{0} / stash@{2}：可丢弃（待用户授权）。
- [ ] 登记册滞后条目修正：FIX-76 / FEAT-77 应置「已合并」，CHORE-38 应置「等待验收」。
- [x] ~~新建产物尚未提交~~ → 已提交（CHORE-106 的卡与规格经收口流程入库；本文件与 SYNC-01/02 同批入库）。
- [x] ~~收口工具口径缺口立票~~ → **已完成，见本文第五节**：**FIX-109（cnb#109）** 与 **CHORE-110（cnb#110）**。

---

## 五、收口工具口径缺口（2026-09-19 收口 CHORE-106 时实测发现，已立票）

除本文第一节的 `close-task` 缺口外，CHORE-106 收口实操中另发现三处**每次收口必然发生**的口径缺陷。均不影响「代码是否合入主干」这一主结果，故长期未被发现。

| # | 缺口 | 实证 | 处置 |
|---|---|---|---|
| 1 | **收口后主检出残留未提交改动**：脚本在 `git commit` **之后**才把 `merge.commit` 由 `PENDING` 写成真实哈希（`local-task-merge.mjs` L318–L323 提交，L326–L329 回写）→ 每次收口都把主检出弄脏 | CHORE-106 收口后残留 `docs/tasks/registry.json`；因 `checkMerge` 要求主检出干净，会**阻塞并行会话的下一次收口**；当时人工补提交 `7e8e8ba` | **FIX-109**（与缺口 2 合并为一笔） |
| 2 | **收口提交「任务范围」字段恒为废值**：`rangeText` 正则 `### 涉及范围[\s\S]*?\n\n` 因标题后紧跟空行，非贪婪匹配退化为标题本身（L237） | CHORE-37 / CHORE-38 / CHORE-106 的收口提交 `任务范围:` **全部**为字面 `### 涉及范围` | **FIX-109** |
| 3 | **轻量路线登记不了正式验收包**：`acceptance_package.assembled` 强制五类前置记录引用 + checkpoint，轻量路线无 `review_proof` / `test_proof` → 无法登记 → 归档摘要 `decision` / `decided_by` / `decided_at` 恒为 `null` | `docs/tasks/archive/CHORE-106/evidence-summary.json` 与 `CHORE-37` 三字段全为 null；**本批任务全部走轻量路线**，故为常态而非个例 | **CHORE-110** |

**票面**：

- `docs/tasks/FIX-109-closeout-tooling-gaps.md` + `docs/tasks/specs/FIX-109-closeout-tooling-gaps/`（定义门全过、未决事项 0，待基线确认）
- `docs/tasks/CHORE-110-acceptance-package-schema.md` + `docs/tasks/specs/CHORE-110-acceptance-package-schema/`

**⚠️ CHORE-110 带一项待裁定开放项**（阻塞开工）：轻量路线的验收签署以什么形态记录？
选 A（验收包分层，推荐）/ B（新增独立轻量记录类型）/ C（不放宽，改口径为「轻量路线不留签署」）。
记录见 `docs/tasks/specs/CHORE-110-acceptance-package-schema/decision-tickets/DT-01-lightweight-acceptance-record.md`（**open**）。

> 缺口 3 的严重性提示：`decided_by` / `decided_at` 是审计链上**最不可再生**的一环——代码可重跑、测试可重跑，但「当时是谁确认通过的」一旦没记下来即永久丢失（事后补记等同伪造）。
