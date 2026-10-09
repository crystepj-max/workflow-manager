# dsh/ 目录资产：角色库、技能真源与内置模板技能安装

本目录是本仓库面向 DSH 的资产目录，只描述**当前实现**：角色定义、技能真源与安装脚本。

当前正式内置工作流是 `templates/*.json` 下的 4 个蓝图——`wf-construction-full-feature`（完整功能开发）、
`wf-diagnose`（诊断 · 缺陷修复）、`wf-explore`（探索 · 多视角探索）、`wf-optimize`（优化 · 快速迭代）；
生成物在 `.generated/<id>/`（`npm run generate`），技能包装到 `$DSH_HOME/skills/<id>/`
（`npm run install:builtin-skills`）。本目录不再承载独立工作流实现或历史种子资产。

## 目录清单

| 路径 | 说明 |
|------|------|
| `dsh/roles/*.md` | 角色提示词（12 个正式内置角色；用户自建的自定义角色也放这里） |
| `dsh/roles/builtin-roles.json` | 正式内置角色清单事实源（id / name / summary / definition / builtin / readonly） |
| `dsh/skills/requirements-analysis/` | requirements-analysis 技能真源（SKILL.md + evals/ + references/，内联自洽版） |
| `dsh/skills/execution-plan/` | execution-plan（批量调度 / 到点开跑）技能真源 |
| `dsh/install-requirements-analysis.sh` | requirements-analysis 真源 → 公共池安装脚本 |
| `dsh/install-execution-plan.sh` | execution-plan 真源 → 公共池安装脚本 |

## 角色库

12 个正式内置角色（清单事实源 `dsh/roles/builtin-roles.json`，正文在 `dsh/roles/`）：

| 角色 id | 名称 | 定义文件 |
|---|---|---|
| `requirements` | 需求分析 | `dsh/roles/requirements.md` |
| `designer` | 方案设计 | `dsh/roles/designer.md` |
| `dev` | 开发 | `dsh/roles/dev.md` |
| `review` | 审核 | `dsh/roles/review.md` |
| `test` | 测试 | `dsh/roles/test.md` |
| `evaluator` | 评估 | `dsh/roles/evaluator.md` |
| `accept` | 验收助手 | `dsh/roles/accept.md` |
| `closeout` | 收口 | `dsh/roles/closeout.md` |
| `diagnose` | 缺陷诊断 | `dsh/roles/diagnose.md` |
| `orchestrator` | 探索统筹 | `dsh/roles/orchestrator.md` |
| `researcher` | 专家研究 | `dsh/roles/researcher.md` |
| `synthesizer` | 综合分析 | `dsh/roles/synthesizer.md` |

内置角色之外，用户可在工作区 `dsh/roles/<id>.md` 自建自定义角色（`builtin=false`，可编辑 / 删除）；仓库当前没有历史兼容角色。

- 角色正文与蓝图 `nodes[].profile` 一一对应：改角色只改文件，单一事实源；
- 角色文件不进 args：各节点 agent 开工时按 `args.roleDir`（缺省 `dsh/roles`）自行读取对应
  `<role>.md` 并严格遵循；生成技能包内置角色副本，目标工作区没有 `dsh/roles/` 时也能运行。

## 技能真源与安装脚本（仓库 = 真源）

本仓库是若干公共池技能的**版本化真源**：改仓库 → 跑安装脚本 → 公共池生效（改仓库即改全局）。

| 技能 | 真源（本仓库） | 安装脚本 | 公共池目标 |
|------|----------------|----------|------------|
| requirements-analysis | `dsh/skills/requirements-analysis/`（SKILL.md + evals/ + references/） | `dsh/install-requirements-analysis.sh` | `~/.agents/skills/requirements-analysis/` |
| execution-plan | `dsh/skills/execution-plan/`（SKILL.md） | `dsh/install-execution-plan.sh` | `~/.agents/skills/execution-plan/` |

**技能变更落地 GitHub 的同步流程：**

1. 改真源文件（如 `dsh/skills/requirements-analysis/SKILL.md`）；
2. 跑安装脚本部署公共池（`./dsh/install-requirements-analysis.sh`），并 diff 校验真源与线上生效版逐字节一致；
3. 开分支 `dev-<runId>` 提交推送 → PR → 合并 main（分支命名派生规则见
   `docs/design/workspace-directory-convention.md` §1.3）。

**requirements-analysis 为何是自洽（内联）版**：其编排依赖的 `triage` / `grill-with-docs` / `wayfinder` /
`to-tickets` 是「仅限用户调用」的命令型 skill（frontmatter `disable-model-invocation: true`，刻意设计），
模型不可通过 `skill` 工具调用；因此该 skill 将四者知识全部内联，**不调用任何子 skill**——这是
issue #22 的持久修复，真源即内联自洽版。

## 内置模板技能安装（`npm run install:builtin-skills`）

内置模板只生成到 `.generated/<id>/`，**不会自动进入 DSH 技能目录**，需显式安装才能按触发词调用：

```bash
npm run install:builtin-skills        # 四套正式内置一次装齐 → $DSH_HOME/skills/<id>/（缺省 ~/.dsh/skills/）
npm run install:builtin-skills:pool   # 追加公共池（默认 ~/.agents/skills，可用 --pool=<目录> 指定）
```

- 产物自包含：`SKILL.md` + `script.mjs` + `meta.json` + 蓝图引用的角色包；
- 幂等，可重复执行；改模板或换机后重跑即可；
- 用户模板走编辑器「保存闭环」，自动产出同形态技能包到 `~/.dsh/skills/<id>/`。

## 运行内置模板（主会话）

### 1. 装配输入

```bash
# 方式 A：GitHub issue（推荐，issue 是唯一需求来源）
gh issue view <N> --json title,body,comments

# 方式 B：直接给需求文本（走 args.requirement）
```

### 2. 调用 wf_run 起跑（首选）

- `templateId`：模板 id（如 `wf-construction-full-feature`）——插件自行编译并交给引擎，
  **不需要传脚本全文**；
- `args`：见「wf_run 参数表」。**不传 `models`**（模型绑定编译时固化于蓝图 `bindings.models`）。

回退（仅当 `wf_run` 不可用、报错无法访问 workflowEngine）：才改用内置 `workflow` 工具——
`script` = `.generated/<id>/script.mjs` 全文（生成物，勿手改；改蓝图后 `npm run generate` 重建）、
`meta` = `.generated/<id>/meta.json`（name/phases 已由生成器按蓝图组装，直接引用）；
并须如实提示用户本次运行记录将退化（单段、无完成类型、不可从看板续跑）。

### 3. 按返回状态驱动

> 状态机以生成器产出的脚本（`.generated/<id>/script.mjs`）为准；行为由运行时排练厅套件
> （`scripts/test/runtime.test.mjs` / `runtime-host.test.mjs`）持续验证。

| 返回 status | 含义 | 主会话动作 |
|---|---|---|
| `WAITING_HUMAN` | Human Decision 门禁（蓝图 `$human-decision`）产出后挂起 | 呈报告 + 人工确认卡；裁决后带 `decision_id` + `user_choice` 续跑 |
| `AWAITING_HUMAN_<节点id>` | 残留人工门禁（`manualCheck` 节点）产出后挂起 | 呈报告 + 人工确认卡：通过 → 以该门禁节点为 entry 且 `approved=true` 续跑（只走 success）；非 true（含 false）→ 仍以同一门禁节点续跑，引擎再挂起，不走 failure（返回体含 `resume` 载荷）。不要手写跳到下游节点。 |
| `PAUSED` | 安全暂停（`wf_control` action=pause）已按检查点生效 | 提交 Guidance 后用 `wf_run` + `resume_paused=true` 恢复同一逻辑运行 |
| `FAILED_AT_<节点id>` | 节点未通过且走 failure 边至终点（如前置检查未通过、dev 受阻） | 呈节点结果（dev 受阻 = `status: "blocked"`），人工补齐后以对应 `entry` 重跑 |
| `FAILED_MAX_ROUNDS` | 超限（auto-reschedule 时含归因 `reschedule`） | 呈 reschedule（归因/拆分建议/人工介入建议）→ 人工决策拆分 |
| `FAILED_ITEM_CAP` / `FAILED_AGENT_CAP` | fanout 超限（4096 items / 1000 累计 agent） | 缩小扇出规模后重跑 |
| `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE` / `ENDED_NO_OUTCOME_EDGE` | 图缺陷（走通性违约的运行时兜底） | 检查蓝图（创作期由校验器规则拦截） |
| `ERROR` / `TECHNICAL_FAILURE` | 未知节点 / agent 技术失败 | 检查模型/额度后重试该 entry |
| `DONE` | 收口完成 | 呈 `cleanup-report.md` 与交付结果，流程结束 |

人工确认卡建议字段：通过 / 未通过（附意见）。AI 核验结论仅供参考，**裁决权在人工**。

> 受阻与等待语义不混用：`WAITING_HUMAN` 归人工决策流程，`BLOCKED` 归外部条件恢复；节点结果枚举
> （test `BLOCKED` / dev `blocked`）仍有效——dev 受阻 = `FAILED_AT_dev`（failure 边兜底）。

### 4. 模型绑定

模型绑定在**编译时固化**于蓝图 `bindings.models`（改分配 = 改 `templates/<id>.json` 后
`npm run generate` 重生成；生成物禁手改）。编辑器（vwf）保存用户模板时在节点上配置模型，
同样落盘为 `bindings.models`。续跑可用 `model_overrides` 更换 Provider / Model（产生追加式快照修订，
仅续跑生效）。

### 5. run 目录产物与工作区隔离

`<目标仓库>/.agent-runs/<task-id>/`（已在 `.gitignore` 中忽略）：各节点报告（如 `dev-report.md` /
`review-report.md` / `test-report.md` / `cleanup-report.md`、人工验收材料）与
`STATE.md`（每节点更新 stage / round / status / updated）均写入该目录；具体文件名以各模板蓝图
`output.files` 的声明为准。

每个任务在物理独立的 git worktree 中作业（相邻容器 `../<仓库名>-worktrees/<分支名>/`，分支
`dev-<runId>`），开发 / 测试 / 审核只读写该 worktree；主工作区全程不切换分支、保持干净，
只承担 push / PR / issue 操作。验证节点开工先自检 worktree 分支 = `run.json.work_branch`，
schema 必填 `verified_branch`（实际验证分支）与 `verified_head`（实际 HEAD commit），
杜绝「验证跑在错误分支 → 结论不可信」。

## 可视化插件（vwf）使用说明

「可视化工作流」（Visual Workflow，下文 vwf）把同一套模板状态机做成图形化入口：
Skill / Chat 入口首选 `wf_run` 工具直接起跑——由插件自身发起，不需要传递脚本；
`wf_run` 不可用时才回退内置 `workflow` 工具执行编译产物，并如实提示运行记录将退化。
实现说明见 `docs/design/plugin-layer.md`。

### 插件形态：组合包与动态开发包

- **组合包（产品形态）**：通过 `dsh plugin add` / `cordis.yml` preset 安装，随部署持久化，
  重启仍在、可跨会话复用。Host 半承载 DSL 校验器、DSL→script 编译器、双根模板库与运行状态；
  Client 半在 settings.section 注册「工作流」页（模板库 + 大抽屉可视化编辑器 + 运行看板）。
  **模板数据已持久化**：内置模板只读（`.generated/<id>/`），用户模板落盘
  `~/.dsh/visual-workflow/templates/<id>.json`，保存即同步编译
  `~/.dsh/skills/<id>/` 技能（save 即闭环）。**内置模板不走保存闭环**：改模板或换机后须执行
  `npm run install:builtin-skills`，把正式内置的自包含技能包装到 `~/.dsh/skills/<id>/`，
  否则会话里按触发词调不到内置工作流（幂等，可重复执行）。
  要同时分发到跨 agent 共享技能池用 `npm run install:builtin-skills:pool`
  （即在上述命令后加 `--pool`，默认池 `~/.agents/skills`，可用 `--pool=<目录>` 指定）；
  池内新增后需补建各 agent 软链（kimi / opencode 原生读池，无需软链）。
- **动态插件（开发迭代形态）**：动态 Cordis 插件，host + client 两半、plain JS
  （无打包器/JSX/import）。
  运行时用 `cordis_define` / `cordis_run` 定义并激活（重启需重新激活）。Host 半承载 DSL 校验器、
  DSL→script 编译器、双根模板库与运行状态；Client 半在 settings.section 注册「工作流」页
  （模板库 + 大抽屉可视化编辑器 + 运行看板）。

### wf_run：正式起跑通道（调用方式与参数表）

宿主 `agents` 可用时，Host 半把 `wf_run` 注册为模型工具，主会话可直接用工具调用完成
「DSL 图编译 + 执行」——**这是 Skill / Chat 入口的正式起跑通道**（LOC-015）：由插件自身发起，
本次运行即同一条 Logical Run（执行分段 / 任务归属 / 完成类型齐全，看板可续跑、暂停、指导）。

`workflowEngine` 推迟到 execute 阶段解析；若解析失败（工具明确报错，无法访问 workflowEngine），
才回退到内置 `workflow` 工具执行编译产物——该路径下脚本返回值只回到会话，插件只能旁观事件流，
运行记录会退化为单段且无完成类型，**回退时必须如实提示用户记录将退化**。
首次运行从模板蓝图入口节点起（缺省取蓝图 `entry`，如 `wf-construction-full-feature` 的 `preflight`），
跑到人工门禁即返回，裁决后再以对应参数续跑。

| 参数 | 必填 | 说明 |
|------|------|------|
| `templateId` | 首次运行* | 内置/用户模板 id（如 `wf-construction-full-feature`）；与 `dsl` 二选一 |
| `dsl` | 首次运行* | 原始 DSL JSON（自定义/覆盖图）；与 `templateId` 二选一，两者同给以 `dsl` 为准 |
| `taskId` | 必填 | 任务标识（如 `issue-7`），兼作缺省 runDir 名 |
| `runDir` | 可选 | run 产物目录，缺省 `.agent-runs/<taskId>` |
| `baseBranch` | 可选 | base 分支，缺省 `main` |
| `roleDir` | 可选 | 角色目录，缺省 `dsh/roles` |
| `resource_kind` | 按模板 | 输入资源类型（git / files / document / config / other）；optimize 类工作流必传，由模板声明或运行参数正式传入 |
| `issueRef` | 可选 | issue 引用（如 `#7`）；无 issue 时用 `requirement` |
| `issueTitle` / `issueBody` / `issueComments` | 可选 | issue 标题 / 正文 / 评论 |
| `requirement` | 可选 | 原始需求文本（无 issue 时） |
| `entry` | 可选 | 起点 / 续跑点，缺省取蓝图 `entry`；残留人工门禁续跑时指向被暂停的门禁节点本身 |
| `approved` | 续跑 | 残留人工门禁裁决结果：`true` 表「通过」，放行门禁节点走 success 出边；Human Decision 续跑禁止此字段 |
| `decision_id` / `user_choice` | 续跑 | Human Decision 续跑：稳定 `decision_id` + Decision Result（如 STOP / USER_ACCEPTED / ADD_BUDGET） |
| `resume_paused` | 续跑 | `true` 恢复 `PAUSED` 的同一逻辑运行（按检查点现场） |
| `model_overrides` | 续跑 | 更换 Provider / Model（`{ 节点id \| "$default": { provider, model } }`），产生追加式快照修订 |
| `feedback` / `startRound` / `history` | 续跑 | 打回意见 / 起始轮次 / 前次打回历史，回传上次返回值以保持轮次计数连续 |

\* `templateId` 与 `dsl` 至少提供其一。

### 人工门禁的人工裁决续跑

- **Human Decision（`WAITING_HUMAN`）**：蓝图 `$human-decision` 节点触发，返回体给出 `decision_id`
  与 Decision Result 选项；人工裁决后带 `decision_id` + `user_choice` 续跑（AI 不代签）。
- **残留人工门禁（`AWAITING_HUMAN_<节点id>`）**：编译器把 `manualCheck: true` 节点编译为「运行到该节点即返回」，
  返回体给出续跑所需参数（`entry` / `approved` / `startRound` / `history` / `feedback`）：
  - **通过**：以 `entry=<节点id>` + `approved=true` 续跑（并回传 `startRound` / `history` /
    `feedback`）；引擎只走该节点 success 出边，下游是否收口由蓝图决定，手册不得指定下一跳；
  - **未通过**：仍以同一门禁节点续跑并带上意见；引擎对非 true（含 false）会再挂起，**不走
    failure 边**。不要手写跳到下游节点。

```jsonc
// 首次运行：选内置模板，从蓝图入口节点起（issue 字段为透传输入，与 workflow 工具同源）
{ "templateId": "wf-construction-full-feature", "taskId": "issue-7",
  "issueRef": "#7", "issueTitle": "...", "issueBody": "...", "issueComments": "..." }

// 无 issue 时直接用需求文本
{ "templateId": "wf-optimize", "taskId": "req-1", "resource_kind": "git",
  "requirement": "把登录流程改为无密码邮箱验证码" }

// 收到残留人工门禁挂起后，人工裁决「通过」→ 以门禁节点续跑（approved=true，只走 success）
{ "templateId": "wf-construction-full-feature", "taskId": "issue-7",
  "entry": "uat", "approved": true,
  "startRound": 1, "history": [], "feedback": "" }
```

### 与模板技能包的关系

vwf 插件与模板技能包（内置模板经 `npm run install:builtin-skills` 安装、用户模板经编辑器 save
闭环产出）是同一套工作流的两种入口，**共用单一编译器（`scripts/generate.mjs compileBlueprint`）
产出的同一份脚本**：技能包走文本触发（主会话读 SKILL.md runbook，装配 args 调 `wf_run`），
vwf 插件走图形触发（模板 → DSL 校验 → 磁盘产物或 CLI 编译，交给同一引擎执行）。
二者共享同一角色库（`dsh/roles/*.md`）、同一返回状态机与由蓝图推导的模型分配。
差别只在入口与取脚本的管道：技能包读安装时的技能目录，vwf 内置模板读 `.generated/`、
用户模板读 save 闭环产物、临时图走 CLI 编译。两类入口都首选 `wf_run` 起跑。
