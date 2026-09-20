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
| 当前状态 | 待确认 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | FIX-220 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FIX-220-presentation-protection/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | synced#220 |

> 说明（不进机器解析字段）：本卡已登记进 `registry.json`，锚点为真实远端号，不再触发 `validate:task-context` 的「缺少远端 issue 号」。草稿号原为 `260919e`，因 `tmpId()` 看不见并行会话尚未登记的同日草稿会撞号，与兄弟卡一并迁至 h/i/j 段（沿革详见 `CHORE-219` 卡面说明）。`无人值守许可 = 允许` 依据规格 §12：三项产品口径已裁定，余下 E-2 属不改产品结果的施工裁定。

## 摘要（三要素速览）

### 任务目标

让人工签收的那份内容无法在刷新状态时被换掉，并把「呈递内容一致性 + 记录间时间序 + 有条件通过必须有反馈」做成引擎在磁盘记录上的机器断言。

### 涉及范围

- 做：design 门「无 decision → 带 decision」刷新须原样保留已呈递 `decision_request`；baseline `draft→confirmed` 须保留呈递过的 goal/scope/acceptance 或显式绑定旧 Revision；引擎⑥补 `decision.question` 与呈递问题等值；引擎新增⑩时间序、⑪conditional_pass 磁盘复核；补「缺 feedback 应被 schema 拒」的负例；契约 §5.3/§8.3 与变更史。
- 不做：schema 约束强度（片 1）；把校验搬进写入路径（片 3）；重做 acceptance_package 已落地的 `assembled` 保护；追溯校验历史归档记录。

### 验收标准

V-1~V-9（规格 §15）：两条保护的「先红后绿」用例；两个「应放行」正例（补呈递、首次即已决）防过头；⑩⑪与 question 等值各有正/负例；既有九项断言逐条保留；`npm test` 全绿。

## 关键证据（2026-09-19 实测）

| 缺口 | 位置与现状 |
|---|---|
| design 门可换呈递 | `cwf-record.mjs:227-240` `isFinalized()` 对 `design_package` 只在 `decision` 已存在后禁覆盖；同 attempt 从「无 decision」刷成「带 decision」可连 `decision_request` 一起换新 |
| 呈递历史不进比较 | `cwf-evidence-verify.mjs:139-149` ⑥ 只校 `chosen ∈ 该记录自带 options`；`decision.question` 与 `decision_request.question` 一致性全仓无校验 |
| baseline 冻结可改内容 | `isFinalized()` 仅在 `status==='confirmed'` 后禁覆盖，`draft→confirmed` 刷新不比对呈递过的三要素 |
| 已完成的一半 | `cwf-record.mjs:139-146` 已拒 `awaiting→decided` 改写 `assembled`，用例 `:407`/`:427` 已测——照此模式补齐，不重做 |
| 时间序 | schema / `cwf-record` / `cwf-evidence-verify` / protocol 核心检索均无跨字段时间比较，**零实现**；JSON Schema 与本仓校验器无法表达 |
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
