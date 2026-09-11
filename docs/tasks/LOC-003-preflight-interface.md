# LOC-003 · preflight 资格校验结构化接口化

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-003` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-09 架构评审候选 3 |
| 任务名称 | preflight 资格校验结构化接口化 |
| 任务类型 | 完整功能开发 |
| 优先级 | P2 |
| 当前状态 | 已合并 |
| 需求基线版本 | V1 |
| 前置依赖 | LOC-002 |
| 施工环境组 | LOC-003 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `.scratch/worktrees/dev-projection-converge-01/.scratch/LOC-003-preflight-interface/task-spec-V1.md` |
| 定义时间 | 2026-09-09T16:05:00Z |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标
preflight 校验逻辑导出 `runPreflight` 返回结构化结果（CLI 退为薄 adapter，退出码/文案逐字节兼容）；execution-plan 批量筛选改进程内 import，消除每候选 Node 冷启动与字段重解析。

### 涉及范围
- 做：preflight main guard 化 + 导出；execution-plan assess 改 import；新增直测。
- 不做：校验规则变更、m2-check 子进程形态、`--run-baseline V1` 硬编码、trigger。

### 验收标准
- [ ] import 不触发退出；runPreflight 直测三态
- [ ] execution-plan 无 preflight spawnSync；m3 测试不改断言绿
- [ ] preflight-local-track 既有测试不改断言绿；npm test / validate 绿

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11T03:09:35Z | 已合并 | 用户验收通过，批次收口：并入 loc-batch-closeout 后经 CNB PR 合入 main |
| 2026-09-09T16:05:00Z | 本地已定义 | 基线 V1 经用户批量授权；前置依赖 LOC-002 |
| 2026-09-09 | 等待验收 | 施工完成（提交 7913fe2）：runPreflight 结构化导出 + CLI 薄壳；execution-plan 进程内消费；直测 4 态；381/381 + validate 绿；CLI 输出/退出码逐字节兼容 |
