# 开发工作流 2.0 · DSH 实现

「开发工作流 2.0」在 DeepSeek Harness（DSH）上的迁移实现。需求基线见
[`docs/开发工作流2.0需求规格.md`](../docs/开发工作流2.0需求规格.md)；蓝图单一事实源见
`templates/dev-workflow-2-0.json`（生成产物 `.generated/dev-workflow-2-0/`，契约见 `docs/design/blueprint-schema.md`）。

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
   ├─ 阶段 调度：dispatcher agent ── schema 闸门 ── 三要素缺失 → FAILED_AT_dispatch（打回人工）
   │
   ├─ 阶段 开发循环（≤9 轮）：
   │     开发 agent → 分流（脚本内 if，无 LLM）→ [测试 agent] → 审核 agent（异源）
   │     测试 FAILED / 审核 REQUEST_CHANGES → 带反馈打回开发，计 1 轮
   │     9 轮超限 → 自动回调度做失败归因 → FAILED_MAX_ROUNDS
   │
   ├─ 阶段 人工验收：accept agent 产双报告 → AWAITING_HUMAN_accept（脚本返回）
   │
   ▼
主会话呈 acceptance-summary.md → ask_user_question 人工裁决（AI 不代签）
   ├─ 通过 → workflow(entry=closeout) → 收口 agent（一致性收口 + 推送/合并 PR + 关闭 issue）→ DONE
   └─ 不通过 → workflow(entry=dev, feedback=人工意见, startRound+1) → 继续开发循环
```

- **人机职责边界**：人工只做两个决策——确认需求（issue 三要素）与验收裁决；
  其余全是执行（开发/测试/审核/推送/合并/关闭 issue），由 AI 完成。

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
| `dsh/roles/dev.md` | 开发角色（worktree 隔离 + tdd 施工 + dev-report.md） |
| `dsh/roles/test.md` | 测试角色（证据驱动 + test-report.md） |
| `dsh/roles/review.md` | 审核角色（双轴审查 + review-report.md） |
| `dsh/roles/accept.md` | 验收角色（acceptance-summary.md + accept-report.md） |
| `dsh/roles/closeout.md` | 收口角色（cleanup-report.md） |
| `dsh/workflow/dev-workflow-2.0.mjs` | 编排脚本（workflow 工具 script 参数的版本控制源） |
| `dsh/skills/requirements-analysis/` | requirements-analysis 技能真源（SKILL.md + evals/ + references/，内联自洽版） |
| `dsh/install-requirements-analysis.sh` | requirements-analysis 真源 → 公共池安装脚本（对齐 install-skill.sh 约定） |

角色正文与蓝图 `templates/dev-workflow-2-0.json` 的 `nodes[].profile` 一一对应（dev 角色有 3 处适配：task.yaml 引用改为
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

### 4. 按返回状态驱动（新契约；旧 mjs 已退役）

> 状态机以生成器产出的脚本（`.generated/<id>/script.mjs`）为准；行为由运行时排练厅套件
> （`scripts/test/runtime.test.mjs` / `runtime-host.test.mjs`）持续验证。

| 返回 status | 含义 | 主会话动作 |
|---|---|---|
| `AWAITING_HUMAN_<节点id>`（如 `AWAITING_HUMAN_accept`） | 门禁节点产出后挂起 | 呈报告 + 人工确认卡：通过 → `entry=<节点id>` + `approved=true` 续跑；不通过 → `entry=dev` + `feedback` + `startRound+1` 续跑（返回体含 `resume` 载荷） |
| `FAILED_AT_<节点id>`（如 `FAILED_AT_dispatch`） | 节点未通过且走 failure 边至终点（含三要素缺失、dev 受阻） | 呈节点结果（dispatch 场景含 `missing`/`reason` 三要素判定；dev 受阻 = `status: "blocked"`），人工补齐后重跑对应 `entry` |
| `FAILED_MAX_ROUNDS` | 超限（auto-reschedule 时含归因 `reschedule`） | 呈 reschedule（归因/拆分建议/人工介入建议）→ 人工决策拆分 |
| `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE` | 图缺陷（走通性违约的运行时兜底） | 检查蓝图（创作期由校验器「successCondition 必须有 failure 边」规则拦截） |
| `ERROR` / `TECHNICAL_FAILURE` | 未知节点 / agent 技术失败 | 检查模型/额度后重试该 entry |
| `DONE` | 收口完成 | 呈 cleanup-report.md + 合并 commit + 已关闭 issue，流程结束 |

人工确认卡建议字段：通过 / 不通过（附意见）。`accept.verdict` 是 AI 的核验结论，
仅供参考，**裁决权在人工**。

> 旧契约语义承接（T-05/候选三修正）：`REJECTED_INCOMPLETE` → `FAILED_AT_dispatch`；
> run 级 `BLOCKED` 已移除——受阻按节点结果呈现（dev 受阻 = `FAILED_AT_dev`，test 受阻 = 打回开发）；
> 节点结果枚举（test `BLOCKED` / dev `blocked`）仍有效。

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

## 多任务隔离（git worktree）

每个任务在物理独立的 git worktree 中作业，取代「共享主工作区 + git checkout 切分支」，
消除两类互踩阻塞——「main 被其它 worktree 占用」与「共享工作区他人未提交改动被覆盖
（would be overwritten）」：

| 节点 | 工作区 |
|------|--------|
| 开发 / 测试 / 审核 | `<runDir>/worktree`（分支 `dev2/<taskId>`），只读写该 worktree |
| 收口（push/pr/merge/close） | 主工作区（编排区，始终停在 base 分支） |

- 开发节点用 `git worktree add <runDir>/worktree -b dev2/<taskId> <base>` 建立
  （续跑时复用已有 worktree），施工与提交都在 worktree 内完成；
- 收口节点合并后用 `git worktree remove <runDir>/worktree` 原子清理，残留本地分支
  用 `git branch -D dev2/<taskId>` 删除；
- 主工作区全程不切换分支、保持干净，只承担 `git push` / `gh pr create` /
  `gh pr merge` / `gh issue close`。
- 验证结论可信度闸门：test/review/accept 三节点开工先自检 worktree 分支 =
  `dev2/<taskId>`、不在则先恢复，且三节点 schema 必填 `verified_branch`（实际验证分支）
  与 `verified_head`（实际 HEAD commit），杜绝「验证跑在错误分支 → 结论不可信、
  验收指引复现相反结果」。

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
| 收口 | `deepseek-official/deepseek-v4-flash` | 低：机械整理 + 推送/合并/关闭 issue |

传入方式：`args.models = { dispatcher: {provider,model}, dev: {...}, test: {...}, review: {...}, accept: {...}, closeout: {...} }`。

备注：kimi `k2.7` 不在 pi-ai 内置 catalog（仅 `k3`/`k3-256k`），如需使用要在设置界面
`llm-pi-ai → providers.kimi-coding` 的 models 中显式添加；不添加也能用上述三路由实现真异源。

### kimi 额度耗尽时的兜底分配（DeepSeek-only）

```json
{
  "dispatcher": { "provider": "deepseek-official", "model": "deepseek-v4-pro" },
  "dev":        { "provider": "deepseek-official", "model": "deepseek-v4-pro" },
  "test":       { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "review":     { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
  "accept":     { "provider": "deepseek-official", "model": "deepseek-v4-pro" },
  "closeout":   { "provider": "deepseek-official", "model": "deepseek-v4-flash" }
}
```

开发(v4-pro) / 审核(v4-flash) 不同模型 + 不同角色 = 弱异源（脚本会提示警告）；
kimi 额度恢复后换回上面的推荐分配即恢复跨 provider 真异源。

## 在其他项目中使用（推荐：技能包，装一次全局可用）

工作流已打包为 DSH 技能 `dev-workflow-2-0`，安装于公共池
`~/.agents/skills/dev-workflow-2-0/`（SKILL.md + roles/ + workflow/ 自包含）。
任何项目的 DSH 会话都能按触发词直接调用，**无需往项目里复制任何文件**。

**在任意项目使用：**

1. 在目标仓库目录打开 DSH 会话（技能目录在会话启动时加载）。
2. 直接说「用开发工作流 2.0 跑 issue #N」——技能触发后按 SKILL.md 的 runbook
   装配 args 并驱动全流程（角色快照自动拷贝进 `.agent-runs/<task>/roles/` 满足留痕）。

**更新/重装技能**：`./dsh/install-skill.sh`（公共池真源 = 本仓库 `dsh/`，改仓库即改全局）。

## 技能真源布局与安装脚本（仓库 = 真源）

本仓库 `dsh/` 是多个公共池技能的**版本化真源**：改仓库 → 跑安装脚本 → 公共池生效（改仓库即改全局）。当前布局：

| 技能 | 真源（本仓库） | 安装脚本 | 公共池目标 |
|------|----------------|----------|------------|
| dev-workflow-2-0 | `dsh/skill/` + `dsh/roles/` + `dsh/workflow/` | `dsh/install-skill.sh` | `~/.agents/skills/dev-workflow-2-0/` |
| requirements-analysis | `dsh/skills/requirements-analysis/`（SKILL.md + evals/ + references/） | `dsh/install-requirements-analysis.sh` | `~/.agents/skills/requirements-analysis/` |

**技能变更落地 GitHub 的同步流程：**

1. 改真源文件（如 `dsh/skills/requirements-analysis/SKILL.md`）；
2. 跑安装脚本部署公共池（`./dsh/install-requirements-analysis.sh`），并 diff 校验真源与线上生效版逐字节一致；
3. 开分支 `dev2/<issue>` 提交推送 → PR → 合并 main（对齐本仓库历史约定，见「试跑发现与修复记录」第 5 条）。

**requirements-analysis 为何是自洽（内联）版**：其编排依赖的 `triage` / `grill-with-docs` / `wayfinder` /
`to-tickets` 是「仅限用户调用」的命令型 skill（frontmatter `disable-model-invocation: true`，刻意设计），
模型不可通过 `skill` 工具调用；因此该 skill 将四者知识全部内联，**不调用任何子 skill**——这是
issue #22 的持久修复，真源即内联自洽版。

**备选：仓库内置方式**——把 `dsh/` 目录复制进目标仓库（角色+脚本随仓库走，
不依赖宿主技能池）。两种方式的编排脚本、角色、返回状态机完全一致。

注意事项：目标仓库需 `gh` 已登录（无远端可跑，收口退化为本地 commit 清单）；
模型分配宿主级共享（kimi 额度不足时用 DeepSeek 双模型兜底，见「异源配置」节）；
多任务并行 = 每个 issue 一个会话 + 一个独立 git worktree（分支 `dev2/<taskId>` + 作业目录
`.agent-runs/<taskId>/worktree`），物理隔离互不阻塞。

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
   提交到工作分支，收口统一 `git push` + `gh pr create --draft` + issue 评论回写。
   同日第二次决策：**合并 PR 与关闭 issue 也由收口节点执行**（squash 合并 + 删分支），
   唯一保留的人工动作是「验收裁决」；唯一禁止项是「绕过 PR 直接推送 base 分支」。
   已在 issue #1 上实测全链路闭环（PR #2 合并、issue 关闭、本地分支收束）。
6. **技能化打包**（2026-08-16）：工作流打包为公共池技能 `dev-workflow-2-0`
   （`~/.agents/skills/`，SKILL.md + roles + workflow + install-skill.sh），任何项目
   会话按触发词调用；本会话技能目录热刷新后已验证可加载。遗留：公共池与工作区的
   `.tmpdir` 原子写残留因安全删除守卫额度限制待下一轮清理（已 gitignore，无功能影响）。

## 可视化插件（vwf）使用说明

「可视化工作流」（Visual Workflow，下文 vwf）把同一套「开发工作流 2.0」状态机做成图形化
入口：在 Web UI 里选内置/用户模板 → 图形化编辑或直接查看流程图 → 点「运行」，插件把 DSL 图
编译成 workflow 脚本并交给 harness 引擎执行，全程零代码。需求基线见
`.scratch/dsh-visual-workflow-p0/requirements-analysis.md`；实现说明见 `docs/design/plugin-layer.md`。

### 插件形态：动态原型 → P2 组合包

- **动态插件（当前形态）**：动态 Cordis 插件，host + client 两半、plain JS（无打包器/JSX/import）。
  运行时用 `cordis_define` / `cordis_run` 定义并激活（重启需重新激活）。Host 半承载 DSL 校验器、
  DSL→script 编译器、双根模板库与运行状态；Client 半在 settings.section 注册「工作流」页
  （模板库 + 大抽屉可视化编辑器 + 运行看板）。**模板数据已持久化**：内置模板只读
  （`.generated/<id>/`），用户模板落盘 `~/.dsh/visual-workflow/templates/<id>.json`，保存即同步
  编译 `~/.dsh/skills/<id>/` 技能（save 即闭环）。
- **P2 组合包（目标形态）**：打包为组合包（`dsh plugin add` / cordis.yml preset），随部署持久化，
  重启仍在、可跨会话复用。按 P0 需求分析的非目标清单：画布编辑、运行看板状态染色已随插件层落地；
  组合包打包、storageDomain 持久化、多工作流并行归 P2。

### wf_run 工具：调用方式与参数表

Host 半把 `wf_run` 注册为模型工具，主会话直接以工具调用驱动——把 `workflow` 工具的「手写脚本」
换成「DSL 图编译」。首次运行从 `entry=dispatch` 起，跑到人工门禁节点即返回，裁决后再以对应
`entry` 续跑。

| 参数 | 必填 | 说明 |
|------|------|------|
| `templateId` | 首次运行* | 内置/用户模板 id（如 `dev-workflow-2-0`，对应「开发工作流 2.0」）；与 `dsl` 二选一 |
| `dsl` | 首次运行* | 原始 DSL JSON（自定义/覆盖图）；与 `templateId` 二选一，两者同给以 `dsl` 为准 |
| `taskId` | 必填 | 任务标识（如 `issue-7`），兼作缺省 runDir 名 |
| `runDir` | 可选 | run 产物目录，缺省 `.agent-runs/<taskId>` |
| `baseBranch` | 可选 | base 分支，缺省 `main` |
| `roleDir` | 可选 | 角色目录，缺省 `dsh/roles` |
| `issueRef` | 可选 | issue 引用（如 `#7`）；无 issue 时用 `requirement` |
| `issueTitle` / `issueBody` / `issueComments` | 可选 | issue 标题 / 正文 / 评论 |
| `requirement` | 可选 | 原始需求文本（无 issue 时） |
| `entry` | 可选 | 起点/续跑点，缺省 `dispatch`；续跑时指向被暂停的门禁节点（如 `accept`）或打回起点 `dev` |
| `approved` | 续跑 | 人工裁决结果：`true` 表「通过」，放行门禁节点走 success 出边 |
| `feedback` | 续跑 | 打回/续跑意见（验收不通过或审核打回时回传） |
| `startRound` | 续跑 | 续跑起始轮次，回传上次返回值以保持 9 轮计数连续 |
| `history` | 续跑 | 前次打回历史，回传上次返回值以保持 9 轮计数连续 |

\* `templateId` 与 `dsl` 至少提供其一。

### 运行状态 AWAITING_HUMAN_* 的人工裁决续跑

编译器把 `manualCheck: true` 节点编译为「运行到该节点即返回」，状态记为
`AWAITING_HUMAN_<节点id>`（如 `AWAITING_HUMAN_accept`，等价于手写脚本的
`AWAITING_HUMAN_ACCEPTANCE`）。返回体给出续跑所需参数（`entry` / `approved` / `startRound` /
`history` / `feedback`），主会话据此呈 `acceptance-summary.md` + 发人工确认卡（AI 不代签）：

- **通过**：以 `entry=<节点id>` + `approved=true` 续跑（并回传 `startRound` / `history` /
  `feedback`），门禁节点走 success 出边进入收口，最终 `DONE`；
- **不通过**：以 `entry=dev` + `feedback=人工意见` + `startRound=上次+1` + `history` 续跑，
  回到开发循环继续（9 轮上限计数连续）。

```jsonc
// 首次运行：选内置模板，entry=dispatch 起（issue 字段为透传输入，与 workflow 工具同源）
{ "templateId": "dev-workflow-2-0", "taskId": "issue-7",
  "entry": "dispatch",
  "issueRef": "#7", "issueTitle": "...", "issueBody": "...", "issueComments": "..." }

// 无 issue 时直接用需求文本
{ "templateId": "dev-workflow-2-0", "taskId": "req-1",
  "requirement": "把登录流程改为无密码邮箱验证码" }

// 收到 AWAITING_HUMAN_accept 后，人工裁决「通过」→ 放行进入收口
{ "templateId": "dev-workflow-2-0", "taskId": "issue-7",
  "entry": "accept", "approved": true,
  "startRound": 1, "history": [], "feedback": "" }
```

### 与技能包 dev-workflow-2-0 的关系

vwf 插件与技能包 `dev-workflow-2-0`（编排脚本版本控制源 = `dsh/workflow/dev-workflow-2.0.mjs`）
是同一套工作流的两种入口：技能包走文本触发（主会话读 SKILL.md runbook，把脚本全文 + args 传给
`workflow` 工具），vwf 插件走图形触发（把同一状态机画成 DSL 图、编译成脚本再交给同一引擎）。
二者共享六角色（`dsh/roles/*.md`）、返回状态机（`AWAITING_HUMAN_*` / `DONE` / `FAILED_MAX_ROUNDS`
等）、9 轮上限与异源模型分配；vwf 编译产物与手写脚本行为对齐（P0 任务 02 的对照验收）。差别只在
入口与脚本来源：技能包脚本手写维护，vwf 脚本由 DSL 编译生成。此外 vwf 编辑器保存用户模板时会
同步生成自包含技能到 `~/.dsh/skills/<id>/`，该技能即可像 `dev-workflow-2-0` 一样按触发词调用
（save 即闭环）。
