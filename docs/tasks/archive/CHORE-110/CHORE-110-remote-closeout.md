# CHORE-110 · 远程收口任务卡存根

> 本文件是**轻量归档存根**（FIX-72 语义分层：远程收口 = 存根 + 凭据摘要）。任务名称：轻量路线验收包可登记性：acceptance_package schema 放开与签署人留痕

| 项 | 值 |
|---|---|
| 状态 | 已合并（merge `f0d9520` @ 2026-09-21T12:25:30+08:00，PR #255 merge commit） |
| 远端 | github#110（cnb#110 同号）；需求基线 V1 |
| 分支 | dev-chore-110-r1（保留，`branch_retained=true`；提交 `c7f8707`→`0896a4e`） |
| 验收 | 人工验收通过（2026-09-21 用户裁决「通过」），运行 `chore-110-r1` 证据见 `evidence-summary.json` 所指 run 目录 |
| 定义 | `docs/tasks/specs/CHORE-110-acceptance-package-schema/`（规格 V1 + Definition Check 全过 + `decision-tickets/DT-01` 已裁定） |

## 收口口径说明

- 本任务经 **GitHub PR 合并**，不是 `local-task-merge.mjs` 的本地收口路径（该脚本要求主检出干净且分支领先主干，合并后两条均不成立），故按仓库既有的「远程收口 + 轻量归档」形态落账：卡存根 + 带凭据字段的 `evidence-summary.json`（`archive_form=lightweight-remote`、`merge.commit` 与登记册逐字一致、`remote_ref`）。
- 规格与定义文档保留在 `docs/tasks/specs/`（FIX-72 决策五：specs/ 是定义入库家），不复制进归档目录。

## 交付内容（合入 main 的部分）

- schema：`acceptance_package.assembled` 存在性分层（`dev_handoff_ref` + `integration_checkpoint` 恒必填；其余四类可缺但须 `evidence_gaps` 声明 + 人工知情批准）；`record_version` **保持 v0.1.8**，纯放宽不失效。
- 机器校验：`cwf-evidence-verify` 按记录有无分支，新增 ⑩ 缺失精确配对 / ⑪ 知情批准（批准人 ≠ 记录产生者）/ ⑫ 轻量档签署须带可核对来源。
- 永久层：`workspace-evidence-summary` 按 task_id 反查 Run、`acceptance_state` + `acceptance_note` 消除静默 null；`cwf-record` 签收时刷新已归档摘要。
- 契约：`construction-workflow-portable-contract.md` 升至 v0.1.9，明文禁止伪造评审/测试记录；新增轻量档示例 `08-acceptance-package-lightweight.json`。
- 存量修复：CHORE-36 / LOC-032 / LOC-033 三例摘要取回已发生的真实签署。
- 测试：新增 24 条用例（含 PR Round 1 Cursor A 类意见的修复与回归）。

## PR Review 结论（Round 1 → Round 2 收敛）

| 轮次 | 结果 | 处理 |
|---|---|---|
| 1/3（head `bbcf78e`） | 1 条 Medium，自评 A · 当前阻塞：未声明的缺失引用会让校验器崩在第 ⑧ 项，⑩ 的「漏报」判定没机会执行 | **成立并已修**：⑧ 增加守卫改为判失败；补回归用例并证明修复前抛 `TypeError`、修复后通过（提交 `0896a4e`） |
| 2/3（head `0896a4e`） | ✅ 无新问题（Round 1 意见标记为 stale 取代） | A 类清零，进入收口；未耗第 3 轮 |

## 遗留事项

1. 影子 schema：`.agent-runs/schema/` 预置副本遮蔽 handoff schema 真源（`cwf-record` 三级兜底第一优先级）——与 #123 / FEAT-221 同域。
2. 契约缺口：人工签收后 target 再前进时，`decided` 记录不可覆盖，④ 会永久判红且无合法出路。
3. GitHub #110 关闭、CNB 镜像同步、skill 资产副本重跑（`sync-ai-task-skill-set.mjs`）——均属对外动作，待人工授权。

凭据校验字段见同目录 `evidence-summary.json`（merge.commit 与登记册逐字一致 + remote_ref）。
