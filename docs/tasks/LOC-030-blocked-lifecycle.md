# LOC-030｜统一受阻、恢复与完成的生命周期语义

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | LOC-030 |
| 需求来源 | 本地文档 |
| 来源定位 | docs/research/workflow-review-requirements-2026-09-14/WR-009.md |
| 任务名称 | 统一受阻、恢复与完成的生命周期语义 |
| 任务类型 | 完整功能开发 |
| 分类 | bug |
| 体量 | M |
| 优先级 | P0 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-030 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | .scratch/LOC-030-blocked-lifecycle/task-spec-V1.md |
| 定义时间 | 2026-09-14T10:05:31Z |
| GitHub 同步 | pending |

本版本属本地轨道。GitHub 接口 403、无法完成读写核验；恢复后需补建 Issue。CNB 不是本批的任务载具，本轮不向其发布或声称已定义。

## 摘要（三要素）

**目标：**技术执行段结束不再自动等于业务完成；暂时受阻可恢复，已完成必须有明确终结语义。

**范围：**四模板终止状态、宿主恢复入口、并发名额释放及生成操作说明。 不重新设计顶层任务状态，不增加新调度器，不将业务 BLOCKED 与模型连接预检 BLOCKED 混为一条未经验证路径。

**验收标准：**

- [ ] AC-01：诊断“环境暂不可用”得到 BLOCKED、terminal=false；环境恢复后继续同一 Run，而非新建假成功记录。
- [ ] AC-02：建设第 3 次业务返工后仍失败时按 M2 受阻；人工退回后正确重置业务额度。
- [ ] AC-03：DONE 但无有效业务完成映射时不记 COMPLETED；合法 PASS、人工接受及探索 INSUFFICIENT 能形成各自明确结果。
- [ ] AC-04：宿主状态、生成 Skill、Bootstrap 与用户界面对同一事件给出一致解释；恢复后不重复已确认节点。

## 开工材料与状态

- [详细任务规格 V1](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-030-blocked-lifecycle/task-spec-V1.md) 是确认后实施事实源；[Definition Check](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-030-blocked-lifecycle/definition-check.md) 记录定义完成情况。
- [本批确认单](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/p0-definition-2026-09-14/confirmation.md) 包含 10 条明确对象、关键默认值与执行许可；确认已完成，当前任务已标为“本地已定义”。
- 本任务无业务硬前置；与其他任务修改同文件只构成合并风险，不新增串行门禁。
- 现已从现有 `construction-bootstrap` 进入交付；本次不创建 Run、不自动开始开发。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-14T10:05:31Z | 本地已定义 | 从 WR-009 分配正式本地 ID，完成规格和门禁材料准备，基线与许可已确认 |
