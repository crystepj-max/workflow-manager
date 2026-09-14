# LOC-024｜显式交接节点输入与返工反馈

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | LOC-024 |
| 需求来源 | 本地文档 |
| 来源定位 | docs/research/workflow-review-requirements-2026-09-14/WR-001.md |
| 任务名称 | 显式交接节点输入与返工反馈 |
| 任务类型 | 完整功能开发 |
| 分类 | bug |
| 体量 | M |
| 优先级 | P0 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-024 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | .scratch/LOC-024-node-input-handoff/task-spec-V1.md |
| 定义时间 | 2026-09-14T10:05:31Z |
| GitHub 同步 | pending |

本版本属本地轨道。GitHub 接口 403、无法完成读写核验；恢复后需补建 Issue。CNB 不是本批的任务载具，本轮不向其发布或声称已定义。

## 摘要（三要素）

**目标：**节点能够声明并实际收到本次执行必需的目标、基线、成果和反馈，返工围绕最新差距进行。

**范围：**四模板的节点调用上下文、返工路径与蓝图编辑/生成；现有未声明输入的旧模板保持可识别兼容。 覆盖普通节点及输入绑定的编辑/生成/运行链；不承担正式记录持久化、文件内容校验或业务评价质量。

**验收标准：**

- [ ] AC-01：优化首轮执行正常；评估返回带唯一标记的 OPTIMIZE 后，第二次执行收到该标记、评价契约引用和当前成果引用。
- [ ] AC-02：诊断修复收到对应 diagnosis 的根因和证据；建设返工收到触发本次返工的 review/test 反馈，而非另一轮的旧报告。
- [ ] AC-03：缺必需引用时消费节点调用数为 0，错误包含 node、binding 和原因；可选输入未产生时按声明处理。
- [ ] AC-04：两轮反馈同时存在时仅选择本次流转对应版本；蓝图编辑、投影往返、生成脚本均保留输入声明。

## 开工材料与状态

- [详细任务规格 V1](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-024-node-input-handoff/task-spec-V1.md) 是确认后实施事实源；[Definition Check](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/LOC-024-node-input-handoff/definition-check.md) 记录定义完成情况。
- [本批确认单](/Users/chris/.codex/worktrees/77ea/workflow-manager/.scratch/p0-definition-2026-09-14/confirmation.md) 包含 10 条明确对象、关键默认值与执行许可；确认已完成，当前任务已标为“本地已定义”。
- 本任务无业务硬前置；与其他任务修改同文件只构成合并风险，不新增串行门禁。
- 现已从现有 `construction-bootstrap` 进入交付；本次不创建 Run、不自动开始开发。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-14T10:05:31Z | 本地已定义 | 从 WR-001 分配正式本地 ID，完成规格和门禁材料准备，基线与许可已确认 |
