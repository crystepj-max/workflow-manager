# Definition Check · CHORE-273 CI 可信度 M4 机械验收

## 检查元数据

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-273` |
| 远端 issue | github#273 |
| 检查对象 | 为 CI 提供「批次前对账（CHORE-73）」所需的环境前提，使 M4 机械验收在 CI 上可通过 |
| 检查时间 | 2026-09-21 |
| 结论位置 | 本文末「结论」节 |

## 目标与范围

- [x] 目标限定为：CI `validate` ③ 段输出 `✅ 引擎层测试全绿`
- [x] 范围限定为 **CI 工作流的环境前提**（克隆深度 + 主干引用）
- [x] 明确不含：修改 `ai-task-scheduled-m4-check.mjs` 的任何断言
- [x] 明确不含：修改 `registry-reconcile.mjs` / `ai-task-scheduled-trigger.mjs` 的任何行为
- [x] 明确不含：父票其余子票范围（M5 / M3 / M2 已分别由 `CHORE-262` / `CHORE-264` / `CHORE-268` 处理；M6 / M7 待办）

## 取证证据（本票要求「先取证再动手」）

- [x] **先纠正既有误判**：父票记「待定位」、本会话早前推断「间歇性（flaky）」，均不准确 → 实为**事件类型决定**：`push`→`main` 无 M4、`pull_request` 有 M4，全部 5 次 run 数据一致
- [x] CI 侧完整输出已取回（临时诊断分支 `diag/ci-260-m4-probe` + Draft PR #272），绕过 `validate.mjs:113` 的明细裁剪
- [x] 失败项唯一：`报告须含批次前对账段（CHORE-73）`
- [x] 报告原文取得：段内为 `对账失败（不阻塞批次）：…fatal: ambiguous argument 'main'`
- [x] 异常直接探得：`reconcilePlan` 抛 `git log main` 失败；`git rev-parse --verify main` 与 `origin/main` **均失败**；`shallow=true`
- [x] 根因指向行：`registry-reconcile.mjs:46-50`（`collectMergeFacts` 未捕获 `execFileSync`）、`ai-task-scheduled-trigger.mjs:133`（设计上的降级 catch）、`ai-task-scheduled-m4-check.mjs:95`（断言只认成功文案）
- [x] **修法已在 CI 上验证**：同分支加 `fetch-depth: 0` + 补 `main` 引用后，报告变为 `对账：账实一致，无需回写`、`PLAN OK`、`shallow=false`、③ 段 `✅ 引擎层测试全绿`

## 验收标准

- [x] AC-1 ~ AC-5 均可机器验证，判据为 CI 真实输出或零 diff 核对
- [x] AC-3 / AC-4 以「零 diff」约束，杜绝用降级分支或放宽产品行为「修绿」
- [x] AC-2 要求走**成功路径**，防止「降级也算过」的伪绿
- [x] AC-5 覆盖 push 场景不回归（新增步骤幂等）
- [x] 标准不含模糊表述

## 依赖与前置

- [x] 无跨票代码依赖：本票与父票其余子票彼此独立
- [x] 施工隔离：本票在独立 worktree / 分支施工，不动主检出内并行会话的在制内容
- [x] 诊断分支为临时产物，**不得合并**，定位后关闭并删除
- [x] 发号完成：`gh` 已登录 `crystepj-max`，发号得到 `github#273`
- [x] 定义落档：任务卡、本规格、本核对清单三者齐备且互相引用一致

## 风险与残留

- [x] `fetch-depth: 0` 会增加 checkout 时间：仓库体量小，实测该 run 诊断步骤耗时正常，影响可接受
- [x] 新增步骤为幂等（`main` 已存在时不 fetch），push 场景行为不变
- [x] 已明确不采用的两条更「省事」的路及其危害（放宽断言＝伪绿；改 fail-fast＝把「主干不可得」伪装成「账实一致」，更危险）

## 结论

**通过。** 本票严格履行父票「先取证再动手、不得凭猜测改断言」的要求：先取回 CI 完整输出定位到唯一失败项与异常原文，再纠正「flaky」误判为「事件类型决定」，最终把修法定在 CI 环境前提上，且已在 CI 上实测达到 `✅ 引擎层测试全绿`。三件套齐备，具备开工条件。
