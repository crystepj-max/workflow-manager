# Definition Check · CHORE-112 validate 长期红修绿（M5 / LOC-042 测试夹具契约补全）

## 检查元数据

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-112` |
| 远端 issue | cnb#112 |
| 检查对象 | 把两簇 born-red 测试夹具补齐到被测契约要求，不改产品行为、不改断言 |
| 检查时间 | 2026-09-19 |
| 结论位置 | 本文末「结论」节 |

## 9.1 目标与范围

- [x] 目标限定为：让 `npm run validate` 的 ③ 引擎层与 LOC-042 机器层在 `origin/main` 上真实转绿
- [x] 只改测试夹具装配与载荷字段；不改 `scripts/` 产品脚本、不改 `templates/` 蓝图、不改断言与期望值
- [x] VWF 包测试簇（`W1/W3/W8/W10/W11/EB8`）明确不在本票范围，另案登记
- [x] 是否给 ruleset 补 `required_status_checks` 不在本票范围（依赖 9.5 第 2 条先解决）

## 9.2 现状证据

- [x] 基线已实测：干净 worktree `.scratch/ci-green` @ `origin/main` `5dea84a`，`npm install` + `npm run generate` 后 `npm run validate` 报 2 项失败（③ 引擎层 + ③′ 包测试）
- [x] 簇 1 根因定位到行：`scripts/test/ai-task-night-dispatch-m5.test.mjs:22-23` 只拷两份夹具；门禁要求见 `scripts/ai-task-preflight-check.mjs:195-201`（`PREFLIGHT_DEF_CHECK_MISSING`）
- [x] 簇 1 因果已用最小复现证明：仅补 `definition-check.md` 一行拷贝，调度器输出即变为 `waiting=[FIX-A] blocked=[FIX-B] completed=[FIX-C] launchOrder=3`（与断言逐字一致）
- [x] 簇 2 根因定位到行：`scripts/workflow-conformance/lib/consumer-chains.mjs` 的 `wf-explore` 载荷缺 `questions`/`question_ids`/`coverage`/`source_overlaps`/`research_failures`；机械校验见 `.generated/wf-explore/script.mjs` 的 `__ecValidatePlan`、`__ecValidateSynth`
- [x] 簇 2 故障表现有引擎日志为证：首节点 `INVALID_OUTPUT` → 技术重试 3 次 → `TECHNICAL_BUDGET_EXHAUSTED` → `WAITING_HUMAN`，`results` 为空
- [x] 契约取值有依据：`coverage.status` 合法枚举含 `unavailable_with_evidence`，且 `__ecHandled` 要求该状态下 `evidence_refs` 非空——故取「成本数据客观不可得 + 一条证据引用」
- [x] 承重字面量已核实：`'成本未知'` 被 `scripts/workflow-conformance/lib/fixtures.mjs:80` 的冻结夹具校验引用，保留未改
- [x] 修复后实测：M5 `6/6`、LOC-042 机器层 PASS 且 `auto_contract: PASS`、③ 引擎层串行 `761/761`、`npm run validate` 由 2 项失败降为 1 项（仅剩 VWF 包测试簇）
- [x] 旁证排除串扰：本会话开始时 `main` 为 `13b1e2a`，期间另一会话推进到 `5dea84a`；`git log 169f50d..origin/main` 对这两个文件为空，即新 main 未并含同类修复，补丁 `git apply --check` 在 `5dea84a` 上干净可应用

## 9.3 验收标准

- [x] 每条标准可复现：`node --test scripts/test/ai-task-night-dispatch-m5.test.mjs`（期望 6/6）、`node scripts/workflow-conformance/run.mjs --machine-only`（期望 exit 0 且输出 `LOC-042 机器层 PASS`）
- [x] ③ 引擎层全量通过：`node --test --test-concurrency=1 scripts/test/*.test.mjs`（期望 `pass 761 fail 0`）
- [x] `npm run validate` 的失败项中不再出现 `—— ③ 引擎层测试 ——` 与 `consumer_chains`
- [x] 改动面可机器断言：`git diff --name-only` 仅含 2 个测试文件 + 本票 2 个文档，`templates/`、`scripts/`（非 test/conformance）零改动
- [x] 标准不含模糊表述，不要求「VWF 簇转绿」这类越范围结论

## 9.4 依赖与前置

- [x] 无代码依赖：两处改动互相独立，且都不依赖 VWF 簇结论
- [x] 工具依赖已确认：`cnb` CLI 1.15.20 可用（发号 `cnb#112` 已由其分配）；Node 24 与仓库依赖已安装
- [x] 前置动作：本票需在独立 worktree 施工，避免与并行会话在同一工作树互扫改动

## 9.5 风险与可逆性

- [x] 产品风险为零面：仅测试夹具载荷补字段，产品代码与蓝图未改；单提交可 `git revert`
- [x] 🔴 已登记新发现的风险（不在本票内修）：`validate` 一次运行即改写 51 个被跟踪的 `scripts/benchmark/loc-045/` 文件（实测 345 增 / 345 删，纯生成时间戳差异）；这会让任何跑过校验的工作树平白出现「未提交改动」，多会话并行时可能被误清或误提交
- [x] 🟡 已登记闸门可信度风险：M5 用例依赖真实挂钟，本机 `load average` 7~10 下单个用例从 0.35s 涨到 60s 超时且失败用例在轮次间漂移，改 `--test-concurrency=1` 即全绿；GitHub runner 2 核默认并发，故补 `required_status_checks` 前须先消除该抖动
- [x] 提交面已收敛：本票提交只显式列出所需路径，不使用 `git add -A`，避免把时间戳噪音扫进提交

## 9.6 无人值守许可

- [x] 判定为「不允许」：本票含远端动作（推分支、开 PR）与治理类待办的口径取舍（ruleset 是否加闸门、基准产物入库还是忽略），须人工决定
- [x] 判定依据已记录：改动本身可逆，但收尾动作对外可见，且第 9.5 条两项待办会改变质量闸门行为

## 9.7 与既有契约一致性

- [x] 遵守「Current / Target 边界」：本票是在维护 Current 基线（让已上线的校验重新可信），不引入 Target 目标规格能力
- [x] 不反向覆盖权威资料：`docs/design/workflow-design-principles.md`、v0.1 目标规格与 `templates/` 定义均未触碰
- [x] 与 WR-010（LOC-036）契约一致：补齐的是模板既有必填合同，未放宽任何校验
- [x] 与 LOC-042 自身断言语义一致：`INSUFFICIENT` 仍作为合法完成（`status=DONE` + `completion.type=INSUFFICIENT`）被断言

## 9.8 未决事项

| 项 | 值 |
|---|---|
| 未决产品事项 | 0 |

说明：9.5 与任务卡「其他事项」列出的 4 条是**已判定的后续独立事项**（各自范围、判据与后果均已写明），不是本票定义层面的未决产品事项；它们需要的是排期与人工决定，不是口径澄清。

## 结论

本票定义清晰、现状有据、验收可复现、风险已登记且不涉及未决产品事项。判定为**可交付**，人工关口保留在推分支 / 开 PR 与 9.5 两项治理待办的取舍上。
