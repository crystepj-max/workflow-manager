# LOC-027｜系统冻结并核验优化评价契约

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | LOC-027 |
| 需求来源 | 本地文档 |
| 来源定位 | docs/research/workflow-review-requirements-2026-09-14/WR-004.md |
| 任务名称 | 系统冻结并核验优化评价契约 |
| 任务类型 | 完整功能开发 |
| 分类 | bug |
| 体量 | M |
| 优先级 | P0 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-027 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | .scratch/LOC-027-evaluation-baseline/task-spec-V1.md |
| 定义时间 | 2026-09-14T10:05:31Z |
| GitHub 同步 | pending |

本版本属本地轨道。GitHub 接口 403、无法完成读写核验；恢复后需补建 Issue。CNB 不是本批的任务载具，本轮不向其发布或声称已定义。

## 摘要（三要素）

**目标：**一次优化执行与其评估使用同一份可验证的评价基线；重新确认必须产生显式的新基线版本。

**范围：**优化的确认、执行、评估与重新确认路径，以及评价文件的保存方式。 只冻结优化评价基线；不重新设计需求定义系统，不由机器判定评价标准本身是否合理。

**验收标准：**

- [ ] AC-01：模型上报与真实文件不同摘要时不放行；A/B 漂移复现无法完成。
- [ ] AC-02：评价文件缺失或读取失败时不进入执行；冻结后被改写时保留原副本并显示基线冲突。
- [ ] AC-03：重新确认产生 V2 后，执行、评估均指向 V2，且不能沿用 V1 的 PASS。
- [ ] AC-04：未发生变更的文档优化可正常自动评估完成，不额外增加人工确认节点。

## 开工材料与状态

- [详细任务规格 V1](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-027-evaluation-baseline/task-spec-V1.md) 是确认后实施事实源；[Definition Check](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-027-evaluation-baseline/definition-check.md) 记录定义完成情况。
- [本批确认单](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/p0-definition-2026-09-14/confirmation.md) 包含 10 条明确对象、关键默认值与执行许可；确认已完成，当前任务已标为“本地已定义”。
- 本任务无业务硬前置；与其他任务修改同文件只构成合并风险，不新增串行门禁。
- 现已从现有 `construction-bootstrap` 进入交付；本次不创建 Run、不自动开始开发。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-14T10:05:31Z | 本地已定义 | 从 WR-004 分配正式本地 ID，完成规格和门禁材料准备，基线与许可已确认 |
