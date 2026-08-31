# 建设 · 完整功能开发 · External Profile Runbook（Codex / Cursor 共用）

> **语义纪律**：业务语义的唯一来源是建设工作流 Portable Contract（本仓库 `docs/design/construction-workflow-portable-contract.md`，版本以其文档头为准）。本 runbook 只做工具映射与驱动纪律，**不复制契约正文语义**（契约 §9.2）。下文 `§x.y` 锚点均指契约文档。
>
> **适用**：不运行在 DSH 内的 Coding Agent（Codex CLI / Cursor Agent 等）。环境需求：bash、git、gh（已认证）、Node.js。

## 工具链（复用仓库脚本，零额外依赖）

| 命令 | 用途 |
|---|---|
| `node scripts/cwf-run-init.mjs <issue编号> <run_id>` | Run 引导：分支 + worktree + portable run identity + schema 提供 |
| `node scripts/cwf-record.mjs write/check/rollback/reverify/budget/archive` | 证据记录、校验、额度、归档 |
| `node scripts/cwf-checkpoint.mjs <runDir>` | Integration Checkpoint（实况计算） |
| `node scripts/cwf-evidence-verify.mjs <runDir>` | §8.3 九项证据链机器校验 |
| `node scripts/cwf-validate.mjs <schema> <record...>` | 单记录 schema 校验 |

> 本仓库克隆后即可用；所有脚本零外部依赖（纯 Node 标准库）。run 产物落在 worktree 的 `.agent-runs/<run_id>/`，由 run-init 自动写入 git 本地排除（不入 PR diff）。

## 十节适配点

### 1. Run 引导（issue → run_id / branch / worktree）

```bash
node scripts/cwf-run-init.mjs <issue编号> <run_id>   # run_id 建议 cwf-<issue>-<序号>，小写连字符
```

产出：分支 `dev-<run_id>` + worktree `.scratch/worktrees/dev-<run_id>/` + `run.json`（portable run identity，契约 §7.1）。**此后全部工作在 worktree 内进行**。

### 2. 上下文加载

进入 Run 前阅读（按序）：本仓库 `AGENTS.md` → 契约文档（版本头为准）→ 目标 issue 全文与评论。契约是业务语义唯一权威；本 runbook 与工具差异说明只是执行层。

### 3. Requirements（需求基线落盘）— §3.1

按契约三要素产出 baseline payload（goal/scope/acceptance/gaps），写入并呈递用户确认：

```bash
node scripts/cwf-record.mjs write .agent-runs/<run_id> requirements_baseline payload.json \
  --produced-by <你的会话标识> --stage requirements
```

固定人工门：呈递三要素摘要，等用户确认；确认后 payload 置 `status=confirmed` + `baseline_revision` + `human_confirmation{confirmed_by, confirmed_at}` 重新写入（同 attempt 成熟刷新）。缺口必须显式（gaps 非空 + outcome=awaiting_human_input 挂起），不编造。

### 4. Design — §3.2

产出 design package（outcome 必填）；命中契约 §5.2 条件门判据 → `outcome=decision_required` + 非空 reasons + `decision_request`（question/options≥1/recommendation）呈递用户；裁决后补 `decision`（chosen 必须属于呈递候选集）并翻转 `package_ready`。未命中即自动推进。

### 5. Dev（Run Workspace 施工）— §3.3

在 worktree 内开发；完成写 dev handoff（`outcome=handoff_ready` 要求自验非空且无 fail/blocked）。`blocked`（可恢复外部条件）必须附 `blocked_reason`，恢复后重入（不耗额度）。写完即提交代码，handoff 记录自动绑定真实 HEAD。

### 6. Review / Test（同一 verified HEAD 上独立复验）— §3.4/§3.5

- **独立证明者（§2 不变量 2）**：审核与测试必须开**新的独立上下文**（见 tool-notes 的会话隔离方法）；`--produced-by` 必须与 dev 不同且 `independent_session=true`；
- review：`verdict` + findings（逐条带根因分类）；`request_changes` → 单边回退（见 §8）；
- test：映射基线验收标准逐条 `acceptance_mapping`（完整无重复）；`fail` 必须带 findings。
- 两者的 `verified_branch`/`verified_head` 必须等于 worktree 实况（脚本写入时自动强校验）。

### 7. Human Acceptance（呈递用户）— §3.6

```bash
node scripts/cwf-checkpoint.mjs .agent-runs/<run_id>          # 集成检查点
node scripts/cwf-record.mjs write .agent-runs/<run_id> acceptance_package assembled.json --produced-by <你的会话标识> --stage human_acceptance
node scripts/cwf-evidence-verify.mjs .agent-runs/<run_id>     # §8.3 九项机器校验，非 0 不得呈递
# 人工知情接受（user_accepted）场景改用例外通道：
node scripts/cwf-evidence-verify.mjs .agent-runs/<run_id> --decision user_accepted
```

呈递用户裁决：accept / reject（feedback + 根因）/ user_accepted（知情接受差异，feedback 必填）。**AI 不代签**。裁决后回填 decided 字段重新写入（成熟刷新；assembled 不得改写）。**裁决回填前必须重跑实况校验**（人工等待期间 target 可能已前进，契约 §7.3）：`node scripts/cwf-checkpoint.mjs .agent-runs/<run_id>` 与 `node scripts/cwf-evidence-verify.mjs .agent-runs/<run_id>` 任一失败即不得签收——先重跑受影响 Proof 并更新 checkpoint。

**收口序列（契约 §3.7，accept 之后）**：PR 按仓库规则创建/合并 → 写 closeout_summary（交付清单 + 集成结果 + acceptance 引用 + `records_retained=true`）→ 归档：

```bash
node scripts/cwf-record.mjs write .agent-runs/<run_id> closeout_summary closeout.json --produced-by <你的会话标识> --stage closeout
node scripts/cwf-record.mjs archive .agent-runs/<run_id>   # 证据归档到主检出后，worktree 才可移除
```

### 8. Rollback（根因路由回退）— §4.1/§4.2

```bash
node scripts/cwf-record.mjs rollback .agent-runs/<run_id> <dev|design|requirements>            # 自动回退（耗额度）
node scripts/cwf-record.mjs rollback .agent-runs/<run_id> <根因> --by human --decided-by <人>   # 人工触发（不耗额度）
node scripts/cwf-record.mjs budget .agent-runs/<run_id> <n> --decided-by <人> --reason "..."    # 人工调额（显式入账）
```

一次回退一条边、按根因选目标（requirements > design > dev 优先上游）；自动额度默认 3，耗尽挂起 `WAITING_HUMAN`（§4.3）呈递决策包。

### 9. 多 Run 并行隔离

run_id 唯一 ⇒ 分支/worktree 唯一（run-init 保证，§7.2）；不同 Run 不在共享 main cwd 开发。重入同一 Run 用同一 run_id 幂等复用（身份不符即拒绝）。

### 10. run 产物不入库

run-init 自动向主仓与 worktree 的 git `info/exclude` 写入 `.scratch/` 与 `.agent-runs/`（本地排除，不改 .gitignore）。收口归档（`cwf-record.mjs archive`）把证据复制到主检出 `.agent-runs/`——worktree 可安全删除，PR diff 始终干净。
