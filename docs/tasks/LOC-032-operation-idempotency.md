# LOC-032｜恢复执行时防止重复外部动作

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | LOC-032 |
| 需求来源 | 本地文档 |
| 来源定位 | docs/research/workflow-review-requirements-2026-09-14/WR-012.md |
| 任务名称 | 恢复执行时防止重复外部动作 |
| 任务类型 | 完整功能开发 |
| 分类 | enhancement |
| 体量 | M |
| 优先级 | P0 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-032 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | .scratch/LOC-032-operation-idempotency/task-spec-V1.md |
| 定义时间 | 2026-09-14T10:05:31Z |
| GitHub 同步 | pending |

本版本属本地轨道。GitHub 接口 403、无法完成读写核验；恢复后需补建 Issue。CNB 不是本批的任务载具，本轮不向其发布或声称已定义。

## 摘要（三要素）

**目标：**已确认成功的受管理外部动作在重试与恢复中只被确认，不重复执行；结果不确定时先核查。

**范围：**宿主管理的交付动作、外部服务回读、本地动作记录与崩溃恢复。 覆盖受管理动作接口；不接管全部命令行、不保证任意第三方服务只执行一次，不实际发布本项目。

**验收标准：**

- [ ] AC-01：在外部成功但本地确认前注入崩溃，恢复先查询原目标，不重复创建第二个 PR/动作。
- [ ] AC-02：重复请求同键、同参数返回同一结果；同键不同目标/参数拒绝。
- [ ] AC-03：未知结果且查询不可用时进入待核查受阻，不再次执行；确认未执行后可安全重试。
- [ ] AC-04：输出格式修复只修复结果，不重新执行已确认动作；账本包含授权、操作、回读与恢复记录。

## 开工材料与状态

- [详细任务规格 V1](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-032-operation-idempotency/task-spec-V1.md) 是确认后实施事实源；[Definition Check](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-032-operation-idempotency/definition-check.md) 记录定义完成情况。
- [本批确认单](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/p0-definition-2026-09-14/confirmation.md) 包含 10 条明确对象、关键默认值与执行许可；确认已完成，当前任务已标为“本地已定义”。
- 本任务无业务硬前置；与其他任务修改同文件只构成合并风险，不新增串行门禁。
- 现已从现有 `construction-bootstrap` 进入交付；本次不创建 Run、不自动开始开发。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-14T10:05:31Z | 本地已定义 | 从 WR-012 分配正式本地 ID，完成规格和门禁材料准备，基线与许可已确认 |
