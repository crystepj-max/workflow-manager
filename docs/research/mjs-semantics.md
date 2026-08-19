# R-01 · dev-workflow-2.0.mjs 语义盘点

> 调研票 R-01 产物。一手资料：`dsh/workflow/dev-workflow-2.0.mjs`（397 行）、`dsh/README.md`（358 行）、`dsh/roles/*.md`（接线层面）、`workflows/dev-workflow-2.0.json`（gold-band 来源）。行号均为 mjs 或 README 中的位置。

## 1. 入口与续跑（entry 模型）

- 入口四态：`dispatch`（默认）/ `dev` / `accept` / `closeout`，非法值直接 throw（mjs:25-28）。
- 前置校验：`entry=dev|accept` 必须带 `A.dispatch`（前次调度结论 JSON，mjs:29-31）；`entry=dispatch` 必须带 `A.issueBody` 或 `A.requirement`（mjs:32-34）。
- **人工验收门禁在脚本外**：脚本跑到 `AWAITING_HUMAN_ACCEPTANCE` 即 return（mjs:381-386），由主会话呈报告、`ask_user_question` 裁决，然后：
  - 通过 → `entry=closeout` 续跑（mjs:390-395）；
  - 不通过 → `entry=dev` + `feedback=人工意见` + `startRound=上次+1` + `history` 续跑（README:112-117、mjs:385-386）。
- 续跑参数：`A.startRound`、`A.feedback`、`A.history`（打回历史数组）、`A.priorFailure`（超限重调度场景，mjs:218）。
- 返回状态机：`REJECTED_INCOMPLETE` / `BLOCKED` / `TECHNICAL_FAILURE` / `AWAITING_HUMAN_ACCEPTANCE` / `FAILED_MAX_ROUNDS` / `DONE`（README:107-114）。

## 2. 「分流」实现

- **脚本内 if，无 LLM**：`if (dispatch.need_integration_test) { 测试 } else { 直送审核 }`（mjs:327-344）。严格转发调度结论，不重新分析。
- 对照：vwf 模板中「分流」是 `route` 节点（LLM 输出 `need_integration_test`）+ `when` 条件边（host.js:43-45,63-64）——**两种实现语义同构**（判定字段相同），但 DSH 侧省了一次 LLM 调用。
- 含义：蓝图若把 route 建模为「有 when 条件边的节点」，生成 DSH 侧时编译器可将「单出两路 when 边」折叠为脚本内 if（判定源 = 上游节点 schema 字段），实现无 LLM 转发。

## 3. 轮次循环与超限

- `MAX_ROUNDS = 9`（mjs:36）；for 循环 `round <= MAX_ROUNDS`（mjs:319）。
- 打回路径：test `FAILED` → `continue`（mjs:334-339）；review `REQUEST_CHANGES` → `continue`（mjs:350-354）；打回时组装 `feedback` 并 `history.push`。
- 超限（循环未 break）：**自动回调度**——`dispatcherPrompt(historyText)` 带全部打回历史做失败归因，要求 `reschedule` 字段（归因/拆分建议/人工介入建议），返回 `FAILED_MAX_ROUNDS`（mjs:361-371）。gold-band 需人工重新调度，此处流程内完成。
- 通过判定：review 非 REQUEST_CHANGES → `passedReview=true; break`（mjs:356-358）。

## 4. 钩子与角色注入

- 使用的钩子：`agent(prompt, { label, schema, ...provider/model })`、`phase(title)`、`log(message)`；**未用** `pipeline`/`parallel`。
- 角色注入：**角色提示词不进 args**——各节点 agent 开工时自行读 `roleDir/<role>.md`（`roleRef`，mjs:162-165），单一事实源 = `dsh/roles/*.md`（README:71-74）。六角色：dispatcher/dev/test/review/accept/closeout。
- 运行上下文：`ctx()`（mjs:171-184）注入 taskId/repoPath/runDir/baseBranch/workBranch/worktree/STATE.md 契约 + 最终回复要求。
- 结构化闸门：每个节点 `agent()` 带 `schema`（六套 schema 定义于 mjs:66-156），校验失败 agent 返回 null → `TECHNICAL_FAILURE`（mjs:307 等）。
- 异源检查：脚本内 `modelTag()` 比对 dev/review 的 provider/model（mjs:46-54），**仅 warning 不拦截**（弱异源容忍）；模型经 `A.models[role] = {provider, model}` 注入（`mo()`，mjs:56-63）。

## 5. 验证可信度闸门（DSH 特有，gold-band 无）

- `verifyBranchStep()`（mjs:189-198）：test/review/accept 开工先自检 worktree 分支 = `dev2/<taskId>` 且 HEAD 一致，错位先恢复。
- `claimError()`（mjs:205-212）：test/review/accept 三节点 schema 必填 `verified_branch`/`verified_head`，编排层纯字符串硬校验，失败 → `TECHNICAL_FAILURE` 打回。这是「验证跑在错误分支」事故的持久修复（README:150-153）。

## 6. 文件契约与多任务隔离

- run 目录 `.agent-runs/<taskId>/`（已 gitignore）：dispatch-result.json、dev-report.md、test-report.md、review-report.md、acceptance-summary.md、accept-report.md、cleanup-report.md、STATE.md（stage/round/status/updated 四行）（README:119-131）。
- git worktree 物理隔离：`worktreePath = runDir + '/worktree'`，分支 `dev2/<taskId>`；dev/test/review 在 worktree 作业；收口在主工作区 push/pr/merge/close（mjs:41-42, 231-237, 288-290；README:133-153）。

## 7. 蓝图可表达 vs 需生成器保证（对照表）

| 语义 | 位置 | 蓝图可表达？ | 说明 |
|---|---|---|---|
| 节点拓扑（7 节点） | mjs 主流程 | ✅ nodes/edges | 与 vwf 模板同构 |
| 节点 goal/output.schema/successCondition | mjs 各 prompt/schema | ✅ 节点字段 | schema 用受支持子集（type/properties/required/additionalProperties/items/enum/const/oneOf） |
| 模型分配 | `A.models` | ✅ per-entry 绑定配置 | 规格 FR-1 已定此方向 |
| 分流（if） | mjs:327-344 | ⚠️ 需编译器折叠 | 当「route 节点两路 when 边」编译为 if 时成立 |
| 打回/轮次 | for+continue/break | ✅ failure 边 + control.maxRounds | vwf 编译产物已实现同构语义 |
| 超限自动归因（reschedule） | mjs:361-371 | ⚠️ 需生成器保证 | vwf 编译产物只返回 FAILED_MAX_ROUNDS（worker.cjs 逻辑），**无归因 agent**——DSH 侧独有，抽取时须决定保留在生成器特例还是蓝图扩展 |
| 人工验收门禁 | mjs:381-386 | ✅ manualCheck 节点 | vwf 编译为 AWAITING_HUMAN_<id> + resume 续跑 |
| 续跑参数（entry/approved/startRound/history/feedback） | 参数装配 | ✅ entry 语义 | vwf 的 resume 载荷与 mjs 的 entry 语义等价（README:327-337） |
| 角色注入（roleRef 自读） | mjs:162-165 | ✅ 约定 | 生成器须注入等价 roleRef/runtimeCtx |
| verifyBranchStep/claimError 闸门 | mjs:189-212 | ⚠️ 需生成器保证 | vwf 编译产物**无此闸门**（现 vwf 模板节点 schema 无 verified_branch/head）——差异点，T-05 等价性须明确是否收敛 |
| 异源 warning | mjs:46-54 | ⚠️ 需生成器保证 | 同下 |
| STATE.md / worktree / 报告文件约定 | ctx() | ✅ 约定注入 | 生成器模板化注入 |
