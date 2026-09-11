# LOC-006 · 生成产物 staleness 单一权威与孤儿清理

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-006` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-09 架构评审候选 6 |
| 任务名称 | 生成产物 staleness 单一权威与孤儿清理 |
| 任务类型 | 完整功能开发 |
| 优先级 | P2 |
| 当前状态 | 已合并 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-006 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/LOC-006-staleness-authority/task-spec-V1.md` |
| 定义时间 | 2026-09-09T16:05:00Z |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标
「生成产物 map ↔ 目录」比对收敛为共用 helper（generate CLI 与 validate 步骤② 共用）；generate 写盘后按 map 清理孤儿产物目录——删蓝图自动收敛，不再永久红灯。

### 涉及范围
- 做：generate.mjs 导出 compare/prune helper 并接入；validate 步骤② 改共用；新增直测。
- 不做：产物格式、蓝图 schema、宿主 staleness、交互式确认。

### 验收标准
- [ ] 两处 diff 循环归一；直测覆盖 diff 三态 + prune + 幂等
- [ ] 孤儿目录造删场景：generate 清理并列出、validate 恢复绿
- [ ] npm test / validate 全绿

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11T03:09:35Z | 已合并 | 用户验收通过，批次收口：并入 loc-batch-closeout 后经 CNB PR 合入 main |
| 2026-09-09T16:05:00Z | 本地已定义 | 基线 V1 经用户批量授权 |
| 2026-09-09 | 等待验收 | 施工完成（提交 bc50bb2）：compare/prune 单一权威 + 孤儿自愈；直测 6 项；孤儿造删 UAT 通过（清理+validate 恢复绿）；371/371 + validate 绿 |
