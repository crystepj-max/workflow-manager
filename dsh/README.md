# 开发工作流 2.0 · DSH 实现

「开发工作流 2.0」在 DeepSeek Harness（DSH）上的迁移实现。需求基线见
[`docs/开发工作流2.0需求规格.md`](../docs/开发工作流2.0需求规格.md)，原 gold-band
实现见 `workflows/dev-workflow-2.0.json` 与 `profiles/`。

## 架构

```
人工沟通 → GitHub issue（三要素）
   │
   ▼
主会话（调度台 + 人工门禁）
   │  ① gh issue view 拉取 issue  ② 装配 args 调 workflow 工具（角色文件由节点 agent 自读）
   ▼
workflow 编排脚本（dsh/workflow/dev-workflow-2.0.mjs）
   │
   ├─ 阶段 调度：dispatcher agent ── schema 闸门 ── 三要素缺失 → REJECTED_INCOMPLETE（打回人工）
   │
   ├─ 阶段 开发循环（≤9 轮）：
   │     开发 agent → 分流（脚本内 if，无 LLM）→ [测试 agent] → 审核 agent（异源）
   │     测试 FAILED / 审核 REQUEST_CHANGES → 带反馈打回开发，计 1 轮
   │     9 轮超限 → 自动回调度做失败归因 → FAILED_MAX_ROUNDS
   │
   ├─ 阶段 人工验收：accept agent 产双报告 → AWAITING_HUMAN_ACCEPTANCE（脚本返回）
   │
   ▼
主会话呈 acceptance-summary.md → ask_user_question 人工裁决（AI 不代签）
   ├─ 通过 → workflow(entry=closeout) → 收口 agent（一致性收口 + 推送分支 + 建 Draft PR）→ DONE
   └─ 不通过 → workflow(entry=dev, feedback=人工意见, startRound+1) → 继续开发循环
```

- **流程编排**：`workflow` 工具的 JS 编排脚本即状态机；节点 = `agent()` 调用；
  结构化闸门 = `agent()` 的 `schema` 校验（替代 gold-band 的 output/messageId 机制）。
- **人工门禁**：脚本不等人。跑到验收点返回，主会话发人工确认卡，裁决后以对应
  `entry` 续跑。全过程状态落在 run 目录文件中，天然支持断点续跑。
- **角色异源**：`agent()` 支持 `provider`/`model` 覆盖；通过 `args.models` 按节点指定，
  开发与审核指定不同模型即满足「异源异模型」硬规则（脚本会检查并警告弱异源）。

## 文件清单

| 文件 | 说明 |
|------|------|
| `dsh/roles/dispatcher.md` | 调度角色提示词（含超限重调度分析；分流职责已由脚本承担） |
| `dsh/roles/dev.md` | 开发角色（分支隔离 + tdd 施工 + dev-report.md） |
| `dsh/roles/test.md` | 测试角色（证据驱动 + test-report.md） |
| `dsh/roles/review.md` | 审核角色（双轴审查 + review-report.md） |
| `dsh/roles/accept.md` | 验收角色（acceptance-summary.md + accept-report.md） |
| `dsh/roles/closeout.md` | 收口角色（cleanup-report.md） |
| `dsh/workflow/dev-workflow-2.0.mjs` | 编排脚本（workflow 工具 script 参数的版本控制源） |

角色正文与 `profiles/*.md` 一致，仅 dev 角色有 3 处适配：task.yaml 引用改为
「运行上下文注入」（DSH 侧调度结论直接进提示词与 dispatch-result.json，无 task.yaml）。

## 运行方式（主会话 runbook）

### 1. 装配输入

```bash
# 方式 A：GitHub issue（推荐，issue 是唯一需求来源）
gh issue view <N> --json title,body,comments

# 方式 B：直接给需求文本（走 args.requirement）
```

### 2. 角色文件无需装配

六个角色提示词不进 args：各节点 agent 开工时按 `args.roleDir`（缺省 `dsh/roles`）
自行读取对应 `<role>.md` 并严格遵循——单一事实源，改角色只改文件。

### 3. 调用 workflow 工具

- `script`：`dsh/workflow/dev-workflow-2.0.mjs` 全文；
- `meta`：`name: "dev-workflow-2-0"`，`phases` 标题须为
  `调度 / 开发循环 / 人工验收 / 收口 / 超限重调度`（与脚本内 `phase()` 调用一致）；
- `args`：见下表。

```jsonc
{
  "taskId": "issue-12",                 // 必填，任务标识
  "runDir": ".agent-runs/issue-12",     // 必填，run 产物目录（相对目标仓库根）
  "entry": "dispatch",                  // dispatch(默认) | dev | accept | closeout
  "issueRef": "#12", "issueTitle": "...", "issueBody": "...", "issueComments": "...",
  // 或 "requirement": "...(直接需求文本)",
  "repoPath": "/path/to/repo",          // 缺省 = 当前会话工作区
  "baseBranch": "main",
  "roleDir": "dsh/roles",               // 可选，角色提示词目录（相对工作区根）
  "models": {                           // 可选；开发/审核不同模型 = 异源硬规则
    "dev":    { "provider": "...", "model": "..." },
    "review": { "provider": "...", "model": "..." }
  },
  // —— 续跑专用（entry=dev/accept 时需要）——
  "dispatch": { "...": "前次返回的 dispatch 结论" },
  "startRound": 3, "feedback": "人工验收不通过意见 / 打回原因",
  "history": [ { "round": 1, "stage": "review", "verdict": "REQUEST_CHANGES", "reason": "..." } ],
  "priorFailure": "..."                 // 超限重调度时的历史失败记录
}
```

### 4. 按返回状态驱动

| 返回 status | 含义 | 主会话动作 |
|---|---|---|
| `REJECTED_INCOMPLETE` | 三要素缺失 | 呈缺失项与补齐建议 → 人工补齐 issue → 重跑 entry=dispatch |
| `BLOCKED` | 环境/依赖阻塞 | 呈阻塞原因，人工介入后按需续跑 |
| `TECHNICAL_FAILURE` | agent 技术失败 | 检查模型/额度后重试该 entry |
| `AWAITING_HUMAN_ACCEPTANCE` | 验收双报告已产出 | 呈 `acceptance-summary.md` + 人工确认卡：通过 → entry=closeout；不通过 → entry=dev + feedback + startRound+1 |
| `FAILED_MAX_ROUNDS` | 9 轮超限 | 呈 reschedule（归因/拆分建议/人工介入建议）→ 人工决策：拆分后重新调度 |
| `DONE` | 收口完成 | 呈 cleanup-report.md + Draft PR 链接，流程结束（PR 合并由人工在 GitHub 完成） |

人工确认卡建议字段：通过 / 不通过（附意见）。`accept.verdict` 是 AI 的核验结论，
仅供参考，**裁决权在人工**。

## run 目录产物约定

`<目标仓库>/.agent-runs/<task-id>/`（已在 `.gitignore` 中忽略）：

| 文件 | 产出节点 | 对应规格 |
|------|---------|---------|
| `dispatch-result.json` | 调度 | dispatch-result |
| `dev-report.md` | 开发 | dev-report.md |
| `test-report.md` | 测试 | test-report.md |
| `review-report.md` | 审核 | review-report.md |
| `acceptance-summary.md` / `accept-report.md` | 人工验收 | 通俗 + 严格验收报告 |
| `cleanup-report.md` | 收口 | cleanup-report.md |
| `STATE.md` | 每节点更新 | stage / round / status / updated |

## 与 gold-band DSL 概念对照

| gold-band DSL | DSH 实现 |
|---|---|
| `nodes[]` worker | `agent(rolePrompt + ctx, { schema, label, provider, model })` |
| `edges[]` on success/failure | 脚本内 if/continue/break |
| `output` + `success_condition` | `agent()` 的 `schema` 校验（harness 侧，与引擎协议无关） |
| `manual_check: true`（验收节点） | 脚本返回 AWAITING_HUMAN_ACCEPTANCE → 主会话 ask_user_question |
| `control.max_attempts = 9` | 脚本常量 `MAX_ROUNDS` + for 循环 |
| `$new-round` / 超限人工重新调度 | 脚本内自动回调度做归因（FAILED_MAX_ROUNDS 携带 reschedule） |
| `config_options`（思考强度） | 不需要；模型选择在 `args.models` |
| `permission_mode` | 不需要；DSH 沙箱按会话 workspace-write 策略统一管控 |
| `session: new/continue` | 每个节点都是新 subagent；上下文经 run 目录文件 + args 传递 |

## 异源配置（已实测验证，2026-08-16）

当前宿主实测可用路由（workflow `agent()` 的 provider/model 覆盖）：

| provider | model | 说明 |
|---|---|---|
| `kimi-coding` | `k3` | 默认路由（pi-ai 适配器，凭据 KIMI_CODING_API_KEY） |
| `deepseek-official` | `deepseek-v4-pro` | DeepSeek 官方适配器（凭据 DEEPSEEK_API_KEY，已在凭证库） |
| `deepseek-official` | `deepseek-v4-flash` | 同上，高速档 |

推荐节点分配（开发/审核不同 provider = 真异源）：

| 节点 | provider/model | 档位理由（沿用原设计思考强度） |
|---|---|---|
| 调度 | `kimi-coding/k3` | 高：三要素校验与归因分析 |
| 开发 | `deepseek-official/deepseek-v4-pro` | 高：主施工 |
| 测试 | `deepseek-official/deepseek-v4-flash` | 高速：证据采集与验证 |
| 审核 | `kimi-coding/k3` | 高：与开发不同 provider，满足异源硬规则 |
| 人工验收 | `kimi-coding/k3` | 中 |
| 收口 | `deepseek-official/deepseek-v4-flash` | 低：机械整理 + 推送/建 PR |

传入方式：`args.models = { dispatcher: {provider,model}, dev: {...}, test: {...}, review: {...}, accept: {...}, closeout: {...} }`。

备注：kimi `k2.7` 不在 pi-ai 内置 catalog（仅 `k3`/`k3-256k`），如需使用要在设置界面
`llm-pi-ai → providers.kimi-coding` 的 models 中显式添加；不添加也能用上述三路由实现真异源。

## 已知缺口（P0 基线）

1. 技能缺口（已基本补齐）：`implement / triage / to-tickets / to-spec / wayfinder /
   grill-with-docs` 已装入 `~/.agents/skills/` 公共池（2026-08-16 核实）；**DSH 会话的
   技能目录是启动时快照，新装技能需新会话方可 `skill()` 调用**；`to-questionnaire`
   未安装（需求沟通可选辅助，不阻塞主流程）。
2. ~~单 provider~~（已解决 2026-08-16）：`deepseek-official`（v4-pro/v4-flash）与
   `kimi-coding/k3` 双 provider 实测可用，推荐分配见「异源配置」；kimi `k2.7` 不在
   pi-ai 内置 catalog，需要时在设置界面显式添加。
3. workflow 前台执行：长循环会占用会话回合；断点续跑见「按返回状态驱动」。
4. 跨仓库：目标仓库须为会话工作区（或在沙箱授权范围内）；多任务并行用
   git worktree + 各自会话。

## 试跑发现与修复记录

P0 试跑（issue #1，2026-08-16）发现的问题：

1. **开发 agent 还原主会话未提交改动**（已修复）：开发角色「保持工作区干净」
   的执行把主会话未提交的 `.gitignore` 改动一并还原。`dsh/roles/dev.md` 硬规则
   已新增：工作区已存在的未提交改动一律原样保留，不还原、不清理、不提交。
2. **调度结论缺失 acceptance 字段**（已修复）：acceptance 原为可选字段，调度
   agent 可能省略。schema 已将 objective/scope/acceptance 列为 required
   （允许 null 表缺失），保证下游节点一定拿得到验收标准。
3. **DSH 原子写残留 `.tmpdir`**（待跟进）：harness 文件层每次写文件遗留
   `.<file>.<pid>.<uuid>.tmpdir/` 目录（内容为正式文件副本，可安全删除），
   属 DSH 自身卫生问题，与工作流逻辑无关。
4. **schema 的 enum 必须带 type**：`{enum:[...]}` 需写成 `{type:'string',enum:[...]}`，
   否则 workflow 校验拒绝（首次启动即暴露，已修复）。
5. **推送/建 PR 职责归属**（2026-08-16 用户决策）：从开发节点移至收口节点——开发只
   提交到工作分支，收口统一 `git push` + `gh pr create --draft` + issue 评论回写；
   禁止推送 base 分支、禁止合并 PR（合并是人工动作）。已回填 dev.md / closeout.md /
   编排脚本，并在 issue #1 收口补跑中实测通过（Draft PR #2，由 deepseek-v4-flash 执行）。
