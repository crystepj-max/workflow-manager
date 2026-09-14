# LOC-028｜人工接受完成必须具备真实决定与版本来源

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | LOC-028 |
| 需求来源 | 本地文档 |
| 来源定位 | docs/research/workflow-review-requirements-2026-09-14/WR-005.md |
| 任务名称 | 人工接受完成必须具备真实决定与版本来源 |
| 任务类型 | 完整功能开发 |
| 分类 | bug |
| 体量 | M |
| 优先级 | P0 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | LOC-026 |
| 施工环境组 | LOC-026 |
| 施工环境角色 | 成员 |
| 无人值守许可 | 允许 |
| 任务规格位置 | .scratch/LOC-028-human-completion/task-spec-V1.md |
| 定义时间 | 2026-09-14T10:05:31Z |
| GitHub 同步 | pending |

本版本属本地轨道。GitHub 接口 403、无法完成读写核验；恢复后需补建 Issue。CNB 不是本批的任务载具，本轮不向其发布或声称已定义。

## 摘要（三要素）

**目标：**完成类型由经过核验的执行路径和决定记录派生，准确区分评估通过、人工接受及建设三态。

**范围：**优化人工接受、建设人工三态、决定恢复及完成摘要展示。 不增加新的人工审批点，不改变建设三态，不代替外部发布授权。

**验收标准：**

- [ ] AC-01：无决定、其他 Run 决定、旧候选决定、模型自报人工接受四种情况均不能生成有效 USER_ACCEPTED。
- [ ] AC-02：优化 PASS 正常自动收口；真实 ACCEPT 对应同一成果时正确生成 USER_ACCEPTED。
- [ ] AC-03：建设三态各走原定路径，无操作继续等待；CONDITIONAL_PASS 的后续意见不修改本轮基线。
- [ ] AC-04：同一决定重复恢复不重复收口；成果在决定后变化时必须重新获得针对新版本的验收。

## 开工材料与状态

- [详细任务规格 V1](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-028-human-completion/task-spec-V1.md) 是确认后实施事实源；[Definition Check](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-028-human-completion/definition-check.md) 记录定义完成情况。
- [本批确认单](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/p0-definition-2026-09-14/confirmation.md) 包含 10 条明确对象、关键默认值与执行许可；确认已完成，当前任务已标为“本地已定义”。
- 前置 LOC-026 须实际完成并保留同组环境；不可将定义完成记成依赖完工。
- 现已从现有 `construction-bootstrap` 进入交付；本次不创建 Run、不自动开始开发。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-14T10:05:31Z | 本地已定义 | 从 WR-005 分配正式本地 ID，完成规格和门禁材料准备，基线与许可已确认 |
