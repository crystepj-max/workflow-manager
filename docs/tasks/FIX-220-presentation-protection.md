# FIX-220 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-220`（前草稿号 `TMP-chrisdem-260919i`） |
| 远端 issue | GitHub #220（编号由 GitHub 远端发号；来源含 #123 与 PR #125） |
| 需求来源 | PR #125 未修评审意见（呈递保护两条）＋ GitHub #123 余项中的时间序子项 |
| 来源定位 | https://github.com/crystepj-max/workflow-manager/pull/125 ／ #123 第 2 条 |
| 任务名称 | 证据呈递完整性：成熟刷新呈递保护与引擎时间序 / conditional_pass 断言 |
| 任务类型 | 缺陷修复（FIX）——既有保证存在可绕过路径 |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | FIX-220 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FIX-220-presentation-protection/task-spec-V1.md`（入库） |
| 定义时间 | 2026-09-20T16:41:25Z |
| GitHub 同步 | synced#220 |

> 说明（不进机器解析字段）：本卡已登记进 `registry.json`，锚点为真实远端号，不再触发 `validate:task-context` 的「缺少远端 issue 号」。草稿号原为 `260919e`，因 `tmpId()` 看不见并行会话尚未登记的同日草稿会撞号，与兄弟卡一并迁至 h/i/j 段（沿革详见 `CHORE-219` 卡面说明）。`无人值守许可 = 允许` 依据规格 §12：三项产品口径已裁定，余下 E-2 属不改产品结果的施工裁定。

## 摘要（三要素速览）

### 任务目标

让人工签收的那份内容无法在刷新状态时被换掉，并把「呈递内容一致性 + 记录间时间序 + 有条件通过必须有反馈」做成引擎在磁盘记录上的机器断言。

### 涉及范围

- 做：design 门「无 decision → 带 decision」刷新须原样保留已呈递 `decision_request`；baseline `draft→confirmed` 须保留呈递过的 goal/scope/acceptance 或显式绑定旧 Revision；引擎⑥补 `decision.question` 与呈递问题等值；时间序拆两档——⑬-b 对 `verified_head` 提交时刻（主判据、零容差、提交不可达须报「无法评估」）、⑬-a 记录内反向软判（只报偏离不拒写）；⑭ conditional_pass 磁盘复核；补「缺 feedback 应被 schema 拒」的负例；契约 §5.3/§8.3 与变更史。
- 不做：**整链**九+项校验搬进写入路径（片 3 #221）；schema 约束强度（片 1）；重做 acceptance_package 已落地的 `assembled` 保护；追溯校验或改写历史归档记录；`文件 mtime` 类判据（#214）。
  > 注：本票不做任何写入路径接线（含 ⑬ 两档），全部判定只在引擎侧评估；写入路径自动触发是 #221 的题域。

### 验收标准

V-1~V-11（规格 §15）：两条保护的「先红后绿」用例；两个「应放行」正例（补呈递、首次即已决）防过头；时间序以 **cwf-74-r1 真实形状**造用例——⑬-b 判倒挂（289 分钟）且提交不可达时报「无法评估」而非通过；⑬-a 反向偏离只出提示不改结论；并锁一条反例：`decided_at` 早于 `created_at` 这一正常形态**必须判通过**；⑬-a/⑬-b 结论不一致时按权威分层报失败；⑭ 与 question 等值各有正/负例；既有九项断言逐条保留；`npm test` 全绿。

## 关键证据（2026-09-19 实测）

| 缺口 | 位置与现状 |
|---|---|
| design 门可换呈递 | `cwf-record.mjs:227-240` `isFinalized()` 对 `design_package` 只在 `decision` 已存在后禁覆盖；同 attempt 从「无 decision」刷成「带 decision」可连 `decision_request` 一起换新 |
| 呈递历史不进比较 | `cwf-evidence-verify.mjs:139-149` ⑥ 只校 `chosen ∈ 该记录自带 options`；`decision.question` 与 `decision_request.question` 一致性全仓无校验 |
| baseline 冻结可改内容 | `isFinalized()` 仅在 `status==='confirmed'` 后禁覆盖，`draft→confirmed` 刷新不比对呈递过的三要素 |
| 已完成的一半 | `cwf-record.mjs:139-146` 已拒 `awaiting→decided` 改写 `assembled`，用例 `:407`/`:427` 已测——照此模式补齐，不重做 |
| 时间序 | schema / `cwf-record` / `cwf-evidence-verify` / protocol 核心检索均无跨字段时间比较，**零实现**；JSON Schema 与本仓校验器无法表达 |
| 🔴 时间序**已真实翻车**（非孤例） | `.agent-runs/cwf-74-r1/acceptance_package.a4.json`（2026-09-20 用户在 #82 UAT 取证，本会话 09-21 逐字段复算）：`decided_at=09:30:00Z` 比绑定提交 `a30f5791`（`14:18:32Z`）**早 289 分钟** → 人不可能验过一个当时还不存在的提交。全量复算另得 **4 个 run 同类倒挂**（289/212/36/17/13 分钟），且 4 例 author 与 committer 日期完全相同，排除 rebase 改写造成的假阳性。⚠️ 同时**否掉了本会话一度提出的 `decided_at ≥ created_at` 判据**：成熟刷新的 `created_at` 天然晚于签收，实测 25/32 正常记录如此，故该方向废弃、反向只做软提示 |
| 权威时刻分层（新增需求输入） | `git 自证 > verified_head 提交时刻 > created_at > 回填字段 > 派生叙述 > 文件 mtime`；本票只实现可机械断言部分，**`文件 mtime` 与屏幕物证已登记 #214（CHORE-75 收口护栏），不重叠** |
| conditional_pass（⚠️ 纠正） | 规则**已在 schema**（`acceptancePackagePayload` 条件分支强制带 `feedback`），`cwf-validate.test.mjs:86` 有正例；缺的是引擎磁盘复核与「缺 feedback 被拒」的**负例**，不是规则缺失 |

## 关联

- 契约 §3.6（签收对象即呈递版本）、§5.3（已决 package 保留呈递 `decision_request`）、§8.3 ②⑥
- PR #125（DSH Bootstrap Profile / `cwf-record` 交付）两条未修意见；GitHub #123 余项时间序
- 兄弟切片：`CHORE-219`（schema 加固，代码面不重叠）、`FEAT-221`（写时整链自动校验，**依赖本片**）

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-19 | 定义中 | 复核实测确认两条保护缺口成立、时间序零实现；conditional_pass 高估部分已纠正 |
| 2026-09-19 | 待确认 | 规格 V1 + Definition Check 全通过，未决产品事项 0 |
| 2026-09-21 | 本地已定义（V1 修订 2） | 正式号落定 GitHub #220；并入 cwf-74-r1 事故取证（本会话独立复算两处倒挂，并多发现一条不依赖 git 的探测器）→ 时间序拆 ⑬-a/⑬-b、⑬-a 前置到写入现场、新增 R-6 权威时刻分层与 #214 边界。**基线未经人工确认，故原地修订 V1 不升 V2**；Definition Check 复检通过，未决产品事项仍为 0 |
| 2026-09-20 | 本地已定义 | 松哥确认三张卡基线 V1（含 FIX-220 事故修订），授权进入施工 |
| 2026-09-21 | 交付中 | 施工完成（worktree `dev-cwf-220-r1`，分支基线 `e8350a1`，GitHub #220 已认领）：两条呈递保护 + 引擎⑥ question 等值 + ⑬(a/b) + ⑭ 全部落地；先红后绿；七文件 98 用例全绿；对 cwf-74-r1 真实归档跑引擎复现 UAT 判断。D-4 已并入（提交不可达只显式报未评估、不阻断）。V-9 全量测试与契约文字同步留收口 |
| 2026-09-21 | 交付中（合并 main） | 与 CHORE-110 检查编号撞车，本票 ⑩/⑪ 让位为 ⑬/⑭（语义不变）；合并 origin/main 后相关 6 文件 **111 用例全绿**，登记册取 main 版为底回写本卡状态 |
