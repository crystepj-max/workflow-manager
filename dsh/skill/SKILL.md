---
name: dev-workflow-2-0
description: "在 DeepSeek Harness（DSH）会话中驱动「开发工作流 2.0」：以 GitHub issue（须含任务目标/涉及范围/验收标准三要素）为唯一需求来源，自动完成 调度 → 开发 →（可选）测试 → 审核 → 人工验收 → 收口（推送/合并 PR/关闭 issue） 全流程；打回上限 9 轮、超限自动归因、全程结构化报告留痕、开发与审核异源异模型。当用户说「用开发工作流跑 issue」「开发工作流 2.0」「dev-workflow」「issue 驱动开发」「跑开发流程」「按工作流开发这个需求」「自动开发这个 issue」，或贴出 issue 链接/编号要求走「分析→开发→测试→审核→验收→交付」的多 agent 流程时，必须主动使用本 skill。本 skill 仅适用于具备 workflow 工具的 DSH 会话。"
---

# 开发工作流 2.0 · DSH 运行技能

在任意项目的 DSH 会话中运行「开发工作流 2.0」。本 skill 目录自包含：

- `workflow/dev-workflow-2.0.mjs` —— workflow 工具的编排脚本（`script` 参数来源，原样传入）
- `roles/` —— 六个节点角色提示词：dispatcher / dev / test / review / accept / closeout

加载本 skill 时会给出 base directory（本目录绝对路径），下文记作 `<SKILL_DIR>`。

## 前置条件

- 当前会话具备 workflow 工具、bash（`git`、`gh`）、工作区写权限。
- 目标仓库 = 当前会话工作区根；有 GitHub 远端且 `gh` 已登录（无远端也能跑，收口退化为本地 commit 清单）。
- 宿主模型路由（推荐，异源硬规则依赖）：`kimi-coding/k3`、`deepseek-official/deepseek-v4-pro`、`deepseek-official/deepseek-v4-flash`。
- `.gitignore` 建议含 `.agent-runs/`（run 产物不入库）。

## 人机职责边界（不可绕过）

人工只做两个决策：**确认需求**（issue 三要素）与**验收裁决**。其余全是执行——开发、测试、审核、推送、合并 PR、关闭 issue——由 AI 完成。AI 验收核验结论仅供参考，不得代签；未拿到人工「通过」前禁止进入收口。

## 运行步骤

### 1. 取需求

```bash
gh issue view <N> --json title,body,comments   # 方式 A：GitHub issue（推荐）
# 方式 B：用户直接给需求文本 → 走 args.requirement
```

### 2. 准备 run 目录与角色快照

```bash
TASK=issue-<N>
mkdir -p .agent-runs/$TASK
cp -R <SKILL_DIR>/roles .agent-runs/$TASK/roles
```

角色快照进 run 目录而不是让节点 agent 读 skill 目录，原因有二：节点 agent 的文件沙箱按会话工作区授权，工作区外路径可能不可读；快照随 run 归档满足「全程留痕」——本次 run 用的角色版本可溯。

### 3. 调用 workflow 工具

读取 `<SKILL_DIR>/workflow/dev-workflow-2.0.mjs` 全文，原样作为 `script` 参数；`meta` 与 `args` 如下：

- `meta.name`：`dev-workflow-2-0`；`meta.phases` 标题须为 `调度 / 开发循环 / 人工验收 / 收口 / 超限重调度`（与脚本内 `phase()` 一致）。
- `args` 模板：

```json
{
  "taskId": "issue-<N>",
  "runDir": ".agent-runs/issue-<N>",
  "roleDir": ".agent-runs/issue-<N>/roles",
  "entry": "dispatch",
  "issueRef": "#<N>", "issueTitle": "...", "issueBody": "...", "issueComments": "...",
  "repoPath": "<会话工作区绝对路径>",
  "baseBranch": "main",
  "models": {
    "dispatcher": { "provider": "kimi-coding", "model": "k3" },
    "dev":        { "provider": "deepseek-official", "model": "deepseek-v4-pro" },
    "test":       { "provider": "deepseek-official", "model": "deepseek-v4-flash" },
    "review":     { "provider": "kimi-coding", "model": "k3" },
    "accept":     { "provider": "kimi-coding", "model": "k3" },
    "closeout":   { "provider": "deepseek-official", "model": "deepseek-v4-flash" }
  }
}
```

开发/审核不同 provider 即满足「异源异模型」硬规则；宿主缺某个 provider 时退化为同默认模型（脚本会警告弱异源），流程仍可跑。

### 4. 按返回 status 驱动

| status | 含义 | 主会话动作 |
|---|---|---|
| `REJECTED_INCOMPLETE` | 三要素缺失 | 呈缺失项与补齐建议 → 人工补齐 issue → 重跑 entry=dispatch |
| `BLOCKED` | 环境/依赖阻塞 | 呈阻塞原因，人工介入后按需续跑 |
| `TECHNICAL_FAILURE` | 节点 agent 技术失败 | 检查模型路由/额度后重试该 entry |
| `AWAITING_HUMAN_ACCEPTANCE` | 验收双报告已产出 | 见第 5 步人工门禁 |
| `FAILED_MAX_ROUNDS` | 9 轮超限 | 呈 reschedule（归因/拆分/人工介入建议）→ 人工决策 |
| `DONE` | 收口完成 | 呈 cleanup-report 摘要 + PR 合并/commit + 已关闭 issue |

### 5. 人工门禁（验收裁决）

`AWAITING_HUMAN_ACCEPTANCE` 时：

0. 先确认验证分支：核对 `<runDir>/acceptance-summary.md`（或 accept-report.md）记录的
   verified_branch = dev2/<taskId>（worktree 分支）、verified_head 与 worktree HEAD 一致；
   验收人若要亲手复现，先 `git -C <runDir>/worktree checkout dev2/<taskId>` 切到工作分支再动手，
   避免在主工作区（停在 base 分支）上复现出相反结论。
1. 向用户呈现 `<runDir>/acceptance-summary.md` 的核心内容（逐条 ✅/⚠️/❌ + 确认方式）；
2. 用 ask_user_question 发起裁决：通过 / 不通过（附意见）；
3. **通过** → 以 `entry=closeout` 续跑（收口会推送分支、合并 PR、关闭 issue、收束本地工作区）；
4. **不通过** → 以 `entry=dev` 续跑，args 增加：`feedback`=人工意见、`startRound`=上次 round+1、`dispatch`=前次调度结论、`history`=前次打回历史（保持 9 轮计数连续）。

## 硬规则提醒（约束主会话自己）

- 未获人工「通过」裁决前，禁止以 entry=closeout 续跑。
- 续跑必须回传前次 `dispatch` / `history`，否则 9 轮上限计数会断。
- 目标仓库必须在当前会话工作区内；不要跨工作区读写别的项目。
- 每个 issue 独立会话 + 独立 git worktree（脚本自动建 `.agent-runs/<taskId>/worktree` + 分支 `dev2/<taskId>`）；多任务并行 = 多会话 + 多 worktree 物理隔离。

## 参考

完整设计文档、返回状态机、gold-band 概念对照与试跑记录见
<https://github.com/crystepj-max/workflow-manager> 仓库的 `dsh/README.md`。
