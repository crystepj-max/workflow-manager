# Definition Check · CHORE-264 CI 可信度 M3 治理区布局

## 检查元数据

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-264` |
| 远端 issue | github#264 |
| 检查对象 | 解除测试夹具与 `/tmp` 豁免区的耦合，使治理区用例在 Linux 语义下同样全绿 |
| 检查时间 | 2026-09-21 |
| 结论位置 | 本文末「结论」节 |

## 目标与范围

- [x] 目标限定为：`validate-workspace-context.test.mjs` 在 `TMPDIR=/tmp` 与默认环境下均 7/7
- [x] 范围限定为**夹具根路径**与随之失效的 import，不改产品代码
- [x] 明确不含：修改 `EXEMPT_ABS_PREFIXES` / `EXEMPT_PATH_SEGMENTS`
- [x] 明确不含：该测试文件的用例语义、断言与周边代码
- [x] 明确不含：父票其余子票范围（M5 已由 `CHORE-262` 处理；M2 / M4 / M6 / M7 待办）

## 现状证据

- [x] 失败位置取自 CI 真实输出：`main@f0d95202` 的 `validate` 作业，③ 段 4 项失败，位置 `scripts/test/validate-workspace-context.test.mjs:114` / `:144` / `:151` / `:177`
- [x] 根因指向行：`scripts/validate-workspace.mjs:50` 的 `/tmp` 豁免前缀 + `scripts/workspace-convention-core.cjs:54` 的 `scopeOfPath` 判定
- [x] 本票本地复现（修复前）：`TMPDIR=/tmp` → 7 项中 4 项失败，与 CI 输出**逐项一致**；默认环境 7/7
- [x] 修复后双环境复测：`TMPDIR=/tmp` 7/7、默认 7/7
- [x] 残留检查：跑完整文件后 `git status` 无新增未跟踪项（夹具落在已忽略的 `.scratch/`）

## 验收标准

- [x] AC-1 ~ AC-5 均可机器验证，判据为具体命令与通过数
- [x] AC-4 以「产品源码零 diff」约束，杜绝通过放宽豁免区「修绿」
- [x] AC-3 显式保护「例外区只计警告」的原有语义不被削弱
- [x] 标准不含模糊表述

## 依赖与前置

- [x] 无跨票代码依赖：本票与父票其余子票彼此独立
- [x] 施工隔离：本票在独立 worktree / 分支施工，不动主检出内并行会话的在制内容
- [x] 发号完成：`gh` 已登录 `crystepj-max`，发号得到 `github#264`
- [x] 定义落档：任务卡、本规格、本核对清单三者齐备且互相引用一致

## 风险与残留

- [x] 夹具改落仓库内 `.scratch/`（已被 Git 忽略）：不污染 `git status`；夹具 repo 为独立仓库，不进主仓库 `git worktree list`，故不影响 D 系列工作区检查
- [x] 夹具不再随宿主 `tmpdir()` 变化，Linux / macOS 判定一致——这正是本票要消除的差异
- [x] 无产品行为改动，不引入新回归风险面

## 结论

**通过。** 根因已由父票定位到行、本票已逐项复现；修法只动夹具根路径，判据可机器验证且显式覆盖「例外区语义不被削弱」；三件套齐备，具备开工条件。
