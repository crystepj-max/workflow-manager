# CHORE-112 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-112` |
| 远端 issue | cnb#112 |
| 需求来源 | CI 长期红排查（会话诊断） |
| 来源定位 | 2026-09-19 恢复 main 分支保护调查时发现 `validate` 自 2026-09-08T06:37 后连续红；顺排查确认三簇失败，本票收编其中两簇测试夹具修复 |
| 任务名称 | validate 长期红修绿：补齐 M5/LOC-042 测试夹具缺失的契约必填字段并登记闸门可信度待办 |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | 待定 |
| 当前状态 | 定义中（本轮修复已实施，待验收） |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 不允许 |
| 任务规格位置 | 未建独立规格：本票两处改动均为测试夹具/装配补全，不改产品行为，判据即既有断言本身 |
| GitHub 同步 | pending |

> 取值约束：`无人值守许可` 只写枚举原值，`GitHub 同步` 只写 `pending` / `synced#N` / `not-applicable`。

## 摘要

未决产品事项：0（下列 4 条为已判定的后续独立事项，不是本票口径未决）

### 问题

`npm run validate` 在 `origin/main` 上稳定失败，合计 13 个测试用例，分三簇。其中两簇的根因不是产品行为回归，而是**测试夹具从写下那天起就没满足被测对象的契约**（born red）：

1. **M5 夜间批次调度器（5 个用例）**：`scripts/test/ai-task-night-dispatch-m5.test.mjs` 的 `buildProject()` 只装配了 `issue-basics.md` 与 `task-spec-V1.md` 两份夹具，漏拷 M3 夹具目录里已存在的 `definition-check.md`。preflight 的定义门禁（`PREFLIGHT_DEF_CHECK_MISSING`，`scripts/ai-task-preflight-check.mjs:200`）因此把全部候选挡在拉起之前，调度器退出码 0 但 `waiting/blocked/completed` 全空。
2. **LOC-042 消费方契约（AC-02/03/04）**：`scripts/workflow-conformance/lib/consumer-chains.mjs` 的 `wf-explore` 夹具不满足 WR-010（LOC-036）给探索模板加的合同——`探索统筹` 缺 `questions[]` 与每个 brief 的 `question_ids`，`综合分析` 缺 `coverage[]`、`source_overlaps`、`research_failures`。引擎在 JSON schema 之外还有机械校验（`.generated/wf-explore/script.mjs` 的 `__ecValidatePlan` / `__ecValidateSynth`），于是首个节点即判 `INVALID_OUTPUT`，技术重试 3 次耗尽 → `TECHNICAL_BUDGET_EXHAUSTED` → `WAITING_HUMAN`，从未走到 `结论评估`。

### 处理

只补齐夹具载荷，**不改任何断言、不改产品代码**：

- `definition-check.md` 一行装配补上。
- `wf-explore` 载荷按 WR-010 契约补全；`coverage` 对成本问题取 `unavailable_with_evidence` + 非空 `evidence_refs`，即「证据客观不可得但有据可记」，正好保持该场景原意（`INSUFFICIENT` 作为合法完成 + 缺口如实保留）。`'成本未知'` 字面量保留，因为 `scripts/workflow-conformance/lib/fixtures.mjs:80` 的冻结夹具校验依赖它。

### 实测结果（见 `specs/CHORE-112-ci-green-test-fixtures/definition-check.md`）

| 项 | 基线 `origin/main` `5dea84a`（未打补丁） | 打补丁后 |
|---|---|---|
| M5 调度器 | 1 通过 / 5 失败 | 6/6 通过 |
| LOC-042 机器层 | `consumer_chains` 失败 | PASS，`auto_contract: PASS` |
| ③ 引擎层全量 | 8 失败 | 761/761 通过 |
| `npm run validate` | 2 项失败 | 1 项失败（仅剩 VWF 包测试簇） |

## 本票登记的其他事项（未在本轮处理）

1. 🔴 **`validate` 会改写被 Git 跟踪的基准产物**：一次测试运行会把 `scripts/benchmark/loc-045/` 下 51 个已跟踪文件的生成时间戳重写（实测 345 增 / 345 删，纯时间戳差异）。后果是任何跑过 `npm run validate` 的工作树都会凭空背上一批「未提交改动」，多会话并行时极易被误当成他人在途工作扫进提交或清掉。需要判定这些产物该入库还是该忽略/生成到 `.generated/`。
2. 🟡 **M5 用例依赖真实挂钟，高负载下会假超时**：本机 `load average` 7~10 时，`M5 释放契约` 从 0.35s 涨到 60s 并超时失败，另一次换成 `M5 看门狗` 失败（42.5s），失败用例在轮次间漂移；同轮改 `--test-concurrency=1` 串行即 761/761 通过、M5 回到 45~350ms。GitHub runner 只有 2 核且默认并发，所以把 `validate` 设成必需状态检查之前必须先解决这条，否则闸门会偶发红。
3. 🟡 **VWF 包测试簇（6 个用例）未处理**：`W1/W3/W8/W10/W11` + `EB8 自动恢复段必须新起段控制器`，集中在 LOC-026 审核 Proof / 集成闸门 / 续跑，属宿主行为问题，另案处理。
4. 🔴 **main 保护治理**：本仓库的 main 保护实际由 ruleset `main protect`（id `21234444`，2026-08-23 建立后未改动）提供，`branches/main/protection` 返回 404 只是端点口径不匹配。该 ruleset 未配 `required_status_checks`，`required_approving_review_count` 为 0，`require_code_owner_review` 因无 `CODEOWNERS` 空转；PR #206 即在 `validate` FAILURE 状态下合入。是否补闸门按第 2 条解决后再定。
5. 🟡 **`docs/tasks/CHORE-111-*.md` 的既有错记**：其现状证据表把上述 404 记为「分支保护已撤销」，与实测相反，待人工裁定后勘正。

## 关联

- 前序：CHORE-111（发号源迁移，本票号 `cnb#112` 由其迁移后的流程发出）
- 证据与复现命令：`specs/CHORE-112-ci-green-test-fixtures/definition-check.md`
