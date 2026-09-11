# LOC-002 · 任务卡解析与状态词汇收敛

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-002` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-09 架构评审候选 2（方案二） |
| 任务名称 | 任务卡解析与状态词汇收敛 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 已合并 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-002 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `.scratch/worktrees/dev-projection-converge-01/.scratch/LOC-002-task-card-parse-converge/task-spec-V1.md` |
| 定义时间 | 2026-09-09T15:23:30Z |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标

任务卡表格解析与规格版本解析收敛为唯一 module（`field()` 三份逐字副本归一；版本 fallback 以 preflight 6 级为唯一实现）；本地轨道状态词汇唯一来源 = `local-task-registry`。对现有使用零破坏（唯一行为差异 = merge 侧版本解析变宽为超集）。

### 涉及范围

- 做：新建 `scripts/task-card-parse.mjs`；改造 `ai-task-preflight-check.mjs` / `ai-task-execution-plan.mjs` / `local-task-merge.mjs`；状态字面量改引用 registry 常量；新增直测；`sync-ai-task-skill-set.mjs` 分发清单补行。
- 不做：preflight 结构化 interface（候选 3）、`git()`/`get()` 基础设施副本、登记册 `--slug` 缺陷、模板文档改动。

### 验收标准

- [ ] `grep -rn "function field" scripts/ --include="*.mjs"` 仅命中新 module 一处
- [ ] 版本解析 6 级 fallback 各有直测；全不命中返回 null
- [ ] `等待验收` / `已合并` / `本地已定义` 不再在三个生产脚本中本地声明
- [ ] 既有相关测试不修改断言全绿；`npm test` 与 `npm run validate` 全绿
- [ ] 分发清单包含新 module 文件名

## 详细规格

完整需求以本地任务规格为准（见上表「任务规格位置」）。实质变更走 Vn→Vn+1 流程。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11T03:09:35Z | 已合并 | 用户验收通过，批次收口：并入 loc-batch-closeout 后经 CNB PR 合入 main |
| 2026-09-09T15:23:30Z | 本地已定义 | 基线 V1 经用户确认（指示按单任务工作流完成）；本地轨道，GitHub 恢复后补建 issue |
| 2026-09-09 | 等待验收 | 施工完成（提交 ee21549，分支 loc-002-task-card-parse）；UAT-01 机械验收全部通过：field 定义唯一、6 级 fallback 直测 12 项、状态字面量归零（余 3 处为注释/固定文案）、377/377 测试绿、validate 绿、分发清单已补 |
