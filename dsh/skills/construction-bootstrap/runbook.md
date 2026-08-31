# 建设工作流 Bootstrap · Controller Runbook

本 runbook 是 Portable Contract 的 DSH 驱动细则。契约锚点引用均为契约文档小节；安装后的权威契约副本在 `<SKILL_DIR>/assets/construction-workflow-portable-contract.md`（源仓库内 = `docs/design/construction-workflow-portable-contract.md`）。

> **脚本路径约定**：下文命令使用 `$CWF_ASSETS/cwf-*.mjs` 形式——`CWF_ASSETS` 在 skill 安装态 = `<SKILL_DIR>/assets`（自包含，外仓库可用），在本源仓库内开发时 = 仓库 `scripts`。执行前先设置：`CWF_ASSETS=<SKILL_DIR>/assets`（或仓库内 `CWF_ASSETS=scripts`）。run-init 会把 `handoff.schema.json` 提供到目标 worktree 的 `.agent-runs/schema/`，记录/校验脚本优先读取该副本。

## 0. Run 引导

```bash
node "$CWF_ASSETS/cwf-run-init.mjs" <issue编号> <run_id>
```

- 产出：独立分支 `dev-<run_id>` + worktree `.scratch/worktrees/dev-<run_id>` + run 目录 `.agent-runs/<run_id>/run.json`（含 portable run identity 与回退额度计数）。run_id 须为已净化小写连字符形态（如 `cwf-<issue>-01`）。
- **之后全部工作在该 worktree 内进行**；run.json 是本 Run 的事实锚点（契约 §7.1）。
- 会话内的 stage/attempt 推进都经 `cwf-record.mjs write` 回写 run.json，不留口头状态。

## 1. Requirements（需求基线）— 契约 §3.1

1. 拉取 issue 全文/评论，加工为三要素基线 payload（goal/scope/acceptance/gaps）。
2. 写入草案记录：

```bash
node "$CWF_ASSETS/cwf-record.mjs" write .agent-runs/<run_id> requirements_baseline payload.json \
  --produced-by <本会话标识> --stage requirements
```

   payload 必须：`outcome=baseline_ready`（或 `awaiting_human_input` + 非空 gaps 挂起）、`status=draft`。
3. **固定人工门**：向用户呈递基线（三要素摘要）请求确认。挂起等待，AI 不代签。
4. 用户确认后：payload 改 `status=confirmed`、补 `baseline_revision` 与 `human_confirmation{confirmed_by, confirmed_at}`，重新 `write`（覆盖记录）。
5. 有缺口且无人可问：`outcome=awaiting_human_input` 挂起（契约 §3.1），不编造。

## 2. Design（方案设计）— 契约 §3.2

1. 产出方案 payload：`outcome`、方案摘要、受影响模块、风险、未决问题。
2. **条件门自检**（§5.2 四条判据）。Role 报告命中情况：
   - 未命中 → `outcome=package_ready`，自动推进；
   - 命中 → `outcome=decision_required` + 非空 `decision_required_reasons` + **`decision_request` 待决包**（question / options≥1 / recommendation，§5.3），挂起呈递人工。
3. 人工裁决后：payload 补 `decision`（Decision Record：chosen 必须属于 decision_request.options）+ `outcome` 翻转为 `package_ready`，重新 `write`。
4. 发现基线缺陷/歧义/范围变化 → `outcome=requirements_issue`，Controller 按 §4.1 回退 Requirements。

## 3. Dev（开发实现）— 契约 §3.3

1. 在 Run worktree 内实施（不得跨 worktree 混写）。
2. 完成时写 dev handoff：`outcome` 必填（`handoff_ready` / `blocked` / `design_issue` / `requirements_issue`）。
3. **blocked 协议（§6.3/§6.4）**：仅用于可恢复外部/技术条件；必须附 `blocked_reason`；Controller 路由 `hold`——记录现场、保持 run.json，条件恢复后重入本 Stage 重试（技术重试不耗额度）。
4. `handoff_ready` 要求自验清单非空且无 fail/blocked 项（schema 强制）。
5. 提交代码后 `write dev_handoff`（信封自动绑定真实 `current_head`）。

## 4. Review（独立审核）— 契约 §3.4

1. **独立证明者（§2 不变量 2）**：开启**新的独立会话/子会话**执行审核（推荐不同模型路线）；`produced_by` 必须异于 dev handoff 的产生者（§8.3 第⑨项）；`independent_session=true`。
2. 产出 review proof：`verdict` + findings（逐条 `root_cause` ∈ dev/design/requirements）+ 真实 `verified_branch`/`verified_head`。
3. 路由（controller 判定）：
   - `approve` → 推进 Test；
   - `request_changes` → **单边回退**：按根因优先级选一条边（requirements > design > dev，§4.1），执行 `node "$CWF_ASSETS/cwf-record.mjs" rollback <runDir> <root_cause>`（额度记账，耗尽自动拒绝并提示升级 §4.3），带 feedback 打回目标 Stage。

## 5. Test（独立测试）— 契约 §3.5

1. 独立会话（同 §4 独立性要求）；输入 = review approve 的 HEAD。
2. 产出 test proof：`verdict` + `acceptance_mapping`（与基线验收标准逐条完整无重复对应）。
3. 路由：`pass` → 推进验收；`fail` → findings 带根因 → 单边回退（同 §4）；`blocked` → `blocked_reason` 必填，`hold` 挂起。

## 6. Human Acceptance（人工验收）— 契约 §3.6

1. 执行 **§8.3 九项证据链校验**（当前人工逐条执行；#123 交付后由 `cwf-evidence-verify` 机器化）：record_type↔stage 映射、上游完成态（baseline confirmed / design package_ready / dev handoff_ready / review approve / test pass）、同 Run lineage、Proof HEAD 与当前一致、映射完整覆盖、produced_by 异源、chosen∈呈递候选集。
2. `user_accepted` 例外：允许携带 fail/blocked 证据链知情接受，必须附 feedback 说明差异（不得伪造证据）。
3. 执行 Integration Checkpoint：

```bash
node "$CWF_ASSETS/cwf-checkpoint.mjs" .agent-runs/<run_id>
```

   target 已前进 → 先 sync，再执行 `node "$CWF_ASSETS/cwf-record.mjs" reverify <runDir> --reason "checkpoint sync"` 推进 Proof 修订（保留原 HEAD 记录，不耗额度），重跑受影响 Proof（review/test 新 attempt 文件），再 `--proofs-rerun`。
4. 组装 `assembled`（五类引用 + 结构化 checkpoint），`write acceptance_package`（status=awaiting_decision），呈递人工。
5. 人工裁决后回填 `status=decided` + `decision` + `decided_by/at` + `verified_branch/head`（+ reject 时 feedback/根因），重新 `write`。
6. **reject 路由**：验收 reject ≠ 进 closeout——执行人工触发回退（不耗自动额度，§4.2）：

```bash
node "$CWF_ASSETS/cwf-record.mjs" rollback .agent-runs/<run_id> <rejection_root_cause> \
  --by human --decided-by <验收人> --reason "acceptance reject: <feedback 摘要>"
```

   随后按根因回到目标 Stage 重入（实现问题回 Dev，设计问题回 Design，需求/范围回 Requirements——§4.1 根因路由表）。

## 7. Closeout（收口）— 契约 §3.7

1. 只整理/冻结/交付；交付清单 + 集成结果（PR/merge 至少其一）+ `acceptance_package_ref`（引用已决验收包）+ `acceptance_outcome`（保留 user_accepted 异常）+ `records_retained=true`。
2. PR 按仓库规则创建/合并；合并后 issue 关闭与复选框勾选属收口记账。
3. `write closeout_summary` 归档声明（交付清单 + 集成结果 + acceptance 引用 + records_retained=true）。
4. **证据归档**（§8.5）：closeout_summary 与最终 index.json/run.json 写入后，把完整 run 证据归档到主检出（worktree 是一次性的）：

```bash
node "$CWF_ASSETS/cwf-record.mjs" archive .agent-runs/<run_id>
```

   归档后的主检出 `.agent-runs/<run_id>/` 含全部七类记录，可按 run_id 检索；此后 worktree 才可安全移除。

## 通用规则

- **路由动作**（§6.4）：proceed / rollback（单边、耗额度）/ await-human（挂起）/ hold（BLOCKED 恢复后重入）/ escalate（升级）。
- **额度**（§4.2）：默认 3；review/test 打回消耗；dev 内部迭代、挂起、技术重试、人工触发均不耗；Decision 后额度变化必须显式记录。
- **升级**（§4.4）：额度耗尽（MAX_ROUNDS_REACHED，保留原结果）与完整性违约走人工升级。
- **禁止事项**（§5.4/§6.1/§6.5）：AI 代签、篡改结果制造 PASS、Profile 复制契约语义、Role 输出路由指令、悬空结果。
