# LOC-026｜将审核与测试证明绑定到真实候选成果

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | LOC-026 |
| 需求来源 | 本地文档 |
| 来源定位 | docs/research/workflow-review-requirements-2026-09-14/WR-003.md |
| 任务名称 | 将审核与测试证明绑定到真实候选成果 |
| 任务类型 | 完整功能开发 |
| 分类 | bug |
| 体量 | M |
| 优先级 | P0 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-026 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | .scratch/LOC-026-candidate-proof/task-spec-V1.md |
| 定义时间 | 2026-09-14T10:05:31Z |
| GitHub 同步 | pending |

本版本属本地轨道。GitHub 接口 403、无法完成读写核验；恢复后需补建 Issue。CNB 不是本批的任务载具，本轮不向其发布或声称已定义。

## 摘要（三要素）

**目标：**审核、测试、UAT 引用同一份真实候选成果；成果变更后旧证明不得为新成果放行。

**范围：**建设和诊断的候选快照、审核/测试证明、UAT 放行；本地非 Git 文件型成果同样适用。 覆盖 Git 与本地非 Git 文件成果；不实现远程数据库快照或所有外部资源适配，不重构现有工作区系统。

**验收标准：**

- [ ] AC-01：审核旧 HEAD、测试另一旧 HEAD、当前新 HEAD 时不进入 UAT/收口，并指出具体不匹配证明。
- [ ] AC-02：同一 HEAD 下受审文件发生未提交修改也被发现；不相关且已声明排除的临时证据文件不会使源码候选失效。
- [ ] AC-03：非 Git 文档集合任一纳入文件修改、增删或更名均改变候选标识；排序变化不改变摘要。
- [ ] AC-04：审核期间被审成果变化时不签发有效证明；对完全相同候选的正常审核、测试可通过。

## 开工材料与状态

- [详细任务规格 V1](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-026-candidate-proof/task-spec-V1.md) 是确认后实施事实源；[Definition Check](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-026-candidate-proof/definition-check.md) 记录定义完成情况。
- [本批确认单](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/p0-definition-2026-09-14/confirmation.md) 包含 10 条明确对象、关键默认值与执行许可；确认已完成，当前任务已标为“本地已定义”。
- 本任务无业务硬前置；与其他任务修改同文件只构成合并风险，不新增串行门禁。
- 现已从现有 `construction-bootstrap` 进入交付；本次不创建 Run、不自动开始开发。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-14T10:05:31Z | 本地已定义 | 从 WR-003 分配正式本地 ID，完成规格和门禁材料准备，基线与许可已确认 |
