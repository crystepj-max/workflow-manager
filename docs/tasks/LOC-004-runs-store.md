# LOC-004 · 运行记录 store 收敛双持久化管线

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-004` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-09 架构评审候选 4 |
| 任务名称 | 运行记录 store 收敛双持久化管线 |
| 任务类型 | 完整功能开发 |
| 优先级 | P2 |
| 当前状态 | 等待验收 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-004 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `.scratch/worktrees/dev-projection-converge-01/.scratch/LOC-004-runs-store/task-spec-V1.md` |
| 定义时间 | 2026-09-09T16:05:00Z |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标
host.js 内 runs 与 logicalRuns 双份持久化管线（写队列/回载/淘汰/水合）收敛为 `createRunRecordStore` 内部工厂，存储介质成可替换 adapter；对外 interface 与落盘语义逐字节不变。

### 涉及范围
- 做：host.js 内部重构 + 既有三大测试文件护栏。
- 不做：RPC interface、落盘格式、client.js（LOC-001 在途）、业务语义合并。

### 验收标准
- [ ] 双份管线函数消失，实现各一处
- [ ] runs-persistence / host / logical-run 测试不改断言全绿；动态闭包 ≤80KB
- [ ] npm test / validate / release:verify 全绿

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-09T16:05:00Z | 本地已定义 | 基线 V1 经用户批量授权；产品 DSH E2E 属人工验收步骤 |
| 2026-09-09 | 等待验收 | 施工完成（提交 687a1eb）：createRecordStore 收敛双管线，30 调用点零改动；三套件不改断言全绿（191 项）；动态闭包 host 57.6KB ≤ 80KB；npm test/validate/release:verify 全绿 |
