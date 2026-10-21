# 实施前检查（Multica Task）

> 当前施工硬门禁使用 `scripts/construction-preflight-gate.mjs`。本地 registry、BOARD 与旧任务卡不再是任务状态来源。

```bash
node scripts/construction-preflight-gate.mjs \
  --multica-task-id <Task UUID 或标识> \
  --multica-profile <已确认的 Multica profile> \
  --multica-workspace-id <workspace UUID> \
  --repo <目标仓库> --run-baseline <Run 绑定版本>
```

门禁从所选 Multica workspace 读取 Task 状态、项目、负责人、定义元数据和依赖，再从目标仓库读取 `spec_ref` 与 Definition Check。profile 与 workspace 必须明确并与返回的 `workspace_id` 一致。

## 检查内容

- Task 属于预期 Multica project，状态为 `todo` 或 `in_progress`；
- `dev-flow.definition.v1` 存在且 `definition_status=defined`，无人值守许可为 `true`；
- 需求基线版本、仓库内 `spec_ref`、环境组与角色有效，Definition Check 已通过且未决事项为 0；
- `dev-flow.dependencies.v1` 存在；无依赖须显式写 `[]`，有依赖时逐个读取 Multica Task，且 `status=done` 与 `status_category=done` 同时成立；
- 若 Run 已绑定需求基线版本，必须与 Task 元数据一致。

Multica CLI 不可用、profile/workspace 未指定或数据缺失时均阻断，不从 `registry.json`、`BOARD.md` 或旧任务卡回退。门禁只报告结果，不改写 Multica Task 状态。
