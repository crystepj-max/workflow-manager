# 2.0 等价验收清单（equivalence-checklist · T-05）

> 用途：AC-1/NFR-3 的收口人工核对清单（v1 收口时逐项勾选）。
> 自动化部分：`scripts/equivalence.test.mjs`（10 项断言，进 validate/CI）。
> 依据：R-01 语义清单（`docs/research/mjs-semantics.md`）+ T-05 决策（语义等价 + 新契约统一）。

## 核对对象

- 旧：`dsh/workflow/dev-workflow-2.0.mjs`（手写，验收通过后**退役**）
- 新：`templates/dev-workflow-2-0.json` + 生成产物 `.generated/dev-workflow-2-0/script.mjs`

## 8 维度核对清单

| # | 维度 | 核对项（行为等价点） | 结果 |
|---|---|---|---|
| 1 | 入口/续跑 | dispatch/dev/accept/closeout 四 entry 可续跑；startRound/history/feedback 传递；`AWAITING_HUMAN_<accept>` 返回 + resume 载荷（新契约） | ☐ |
| 2 | 分流判定 | 判定源 = dispatch 的 `need_integration_test`；DSH 侧无 LLM 转发（折叠 if）；vwf 侧 route 节点 + when 边 | ☐ |
| 3 | 轮次与超限 | 9 轮上限；test FAILED / review REQUEST_CHANGES 打回；超限 → `FAILED_MAX_ROUNDS` + 归因（reschedule：归因/拆分/人工介入） | ☐ |
| 4 | 人工门禁 | AI 核验产双报告（acceptance-summary/accept-report）；人工裁决不代签；通过 → closeout；不通过 → dev+feedback+startRound+1 | ☐ |
| 5 | 可信度闸门 | test/review/accept 开工分支自检（worktree=dev2/<taskId>）；`verified_branch`/`verified_head` 硬校验（失败 TECHNICAL_FAILURE） | ☐ |
| 6 | 异源 | dev↔review 模型比对（v2 起 save 层强制，运行时日志）；弱异源 warning | ☐ |
| 7 | 文件契约 | STATE.md 四行（stage/round/status/updated）；report 文件命名与蓝图 output.files 一致；runDir 只写约定 | ☐ |
| 8 | 返回状态机 | 新契约状态全集可驱动：`AWAITING_HUMAN_<id>` / `FAILED_AT_<id>`（含 dispatch 三要素缺失）/ `FAILED_MAX_ROUNDS` / `BLOCKED` / `TECHNICAL_FAILURE` / `DONE` | ☐ |

## 已知差异（T-05 决策，接受）

- 三要素缺失：旧 `REJECTED_INCOMPLETE` → 新 `FAILED_AT_dispatch`（终止原因可读：missing/reason 在结果中）；runbook 已增补 `FAILED_AT_*` 驱动。
- 返回体：旧 `AWAITING_HUMAN_ACCEPTANCE`（next/heterogeneity 字段）→ 新 `AWAITING_HUMAN_<节点id>` + resume；主会话按新契约驱动。
- 允许差异：报错文案、log 细节、label 命名、代码风格。

## 收口步骤

1. `npm test` 全绿（含 equivalence 断言）
2. 本清单 8 维度逐项人工核对生成脚本（对照 R-01 产物）→ 全勾
3. 触发词路由实测：新会话以「开发工作流 2.0」/「dev-workflow-2-0」调用生成 skill（FR-6 软路由，规格风险 3）
4. 通过后：删除旧 mjs，入口由生成 skill 承接

核对人：__________　日期：__________　结论：通过 / 不通过（附差异说明）
