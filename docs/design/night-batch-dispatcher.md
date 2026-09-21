# 夜间批量施工调度器（M5 真实唤起）使用说明

## 它解决什么问题

此前的夜间批次靠一条很长的提示词驱动 AI 会话：筛选、去重、排除、补位、报告格式全写在散文里，
每晚由 AI 重新理解一遍，维护成本高、跨机器/跨 AI 工具易漂移。

现在确定性规则全部下沉到脚本，AI 只做「单任务施工」这一件事：

| 环节 | 承载 | 说明 |
|---|---|---|
| 候选采集（登记册状态 / 已有 run / 依赖 / 环境组 / 黑名单） | `scripts/ai-task-candidate-collect.mjs` | 只读，本地事实 |
| 机械门禁（规格 preflight / 依赖 git 事实）+ 排序 + 快照 + 并发状态机 + 补位 | `scripts/ai-task-execution-plan.mjs`（M3 内核，复用未改规则） | 纯状态机，有测试 |
| 到点等待 | 调度器内建（与 M4 同语义：未到点退出码 3） | |
| 真实唤起施工 | `scripts/ai-task-dispatcher.mjs` | **每任务一个独立 AI CLI 会话**，不用 subagent |
| 看门狗 | 调度器内建 | 单会话墙钟超时 → 终止 + 记受阻 + 释放名额 |
| 批次报告 | 调度器内建 | 落盘 `.scratch/night-batches/<日期>-<批次名>/report.md` |

## 如何定义一个夜间批次（跨机器、跨 AI 工具通用）

1. 每台机器一次性配置 `.scratch/night-batches/machine.json`（不入库；示例见
   `scripts/night-batch-machine.example.json`）：声明本机用哪个 AI CLI 拉起无人值守会话、
   两种权限档（full-access / auto-edit）各自的命令模板、现场创建命令、远端 issue 查询命令。
2. 每个批次一张卡 `schedule.json`（放哪都行，建议 `.scratch/night-batches/`）：

```json
{
  "project": "~/workspace/workflow-manager",
  "batchName": "night-01",
  "maxConcurrency": 2,
  "startAt": "2026-09-16T23:00:00+08:00",
  "endAt": "2026-09-17T06:30:00+08:00",
  "blacklist": [],
  "permission": "full-access",
  "watchdogMinutes": 120
}
```

3. 定时器（cron / launchd / ZCode CronCreate / 任何调度器）只做一件事：

```bash
node scripts/ai-task-dispatcher.mjs <schedule.json路径>
```

换项目 = 换 `project` 字段（及其 `machine.json` 里对应配置）；换 AI 工具 = 换命令模板。
其余不变。

## 任务源：本地登记册 ∩ GitHub 可施工标签（FEAT-237）

批量施工池由**两个来源的交集**决定，两个来源各自承担不可替代的职责：

| 来源 | 提供的事实 | 缺了会怎样 |
|---|---|---|
| 本地登记册 `docs/tasks/registry.json` + 任务卡 + 规格 | 任务**真的有定义材料**（preflight 门禁：规格齐备、无人值守允许、依赖已合并） | 会把「只在远端有个标题」的任务拉进无人值守批次 |
| GitHub issue 标签 `ready-for-agent` | 任务**在远端被标记为可施工**，且是跨机器可读的唯一信号 | 无法跨机器判断「哪些任务现在可以开工」 |

判定分四态（`planTaskSourceAdmission`，纯函数）：

| 判定 | 条件 | 处置 |
|---|---|---|
| `claimed` | issue 带 `施工中` | 硬排除，理由写明认领人 |
| `no-anchor` | 登记册 `remote` 无 `github#N` | 默认放行并在报告标注（历史 LOC-/TMP- 与离线仓依赖此路径）；`taskSource.requireAnchor=true` 时排除 |
| `ready` | issue 带 `ready-for-agent` | 放行 |
| `not-ready` | 有锚点但没有标签 | 定义门禁通过后**自动补标**再放行；补标失败即排除 |

补标刻意排在定义门禁**之后**：标签语义是「需求清晰可执行」，在门禁之前补标会把过不了门禁的任务标记成可施工。

`machine.json` 里的开关（整段可省略，省略即退回「仅本地登记册」的旧行为）：

```json
"taskSource": {
  "readyLabel": "ready-for-agent",
  "wipLabel": "施工中",
  "labelSync": true,
  "onUnavailable": "block",
  "requireAnchor": false
}
```

- `onUnavailable`：`block`（默认）＝远端不可信时**整批不开工**并退出码 1；`local-only` ＝降级为仅本地候选，报告显著标注降级。默认选择 block 的理由：失去认领互斥保护后重复施工的代价高于空跑一夜。
- 批次目录会留一份 `task-source.json`（当次看到的全部就绪 issue），事后可对账「为什么这个任务没跑」。

## 施工认领互斥（FEAT-237）

`cwf-run-init` 开工时对目标 issue 执行「标签 + assignee + 认领评论」三件套：

- 标签 `施工中`、assignee = `gh` 当前登录账号、评论含施工人 / 机器 / run / 分支 / 时间；
- 认领标记 `<!-- wip-claim:<机器>/<run_id> -->`，同 run 重跑幂等（`reused`，不重复评论）；
- **已被他人认领 → 拒绝开工（exit 1）**，并指出认领人；
- 并发认领：评论写入后重读，当前窗口（最后一次释放之后）内最早的 claim 标记胜出，后到者 `claim-raced` 让位且不摘标签；
- 无 GitHub 远端 / gh 不可用 / 任务无锚点时只告警不阻断（本地轨道与离线仓仍可开工）；`--no-claim` 显式跳过。

释放（收口或人工接手）用 `node scripts/github-issues.mjs release --task <id>`：摘掉 `施工中`、留一条结束评论，`ready-for-agent` 保留。

## 会话结束契约

每个施工会话退出前必须写 `<runDir>/release-event.json`：

```json
{"to": "WAITING_HUMAN", "blockedNode": null, "reason": null, "reworkCount": 0, "nextStep": null}
```

`to` 取值 `WAITING_HUMAN / BLOCKED / COMPLETED`。未写而退出、或超看门狗墙钟上限，
调度器一律记「执行受阻」并释放并发名额继续补位，不会卡死批次。

单任务施工的行为边界（不谈需求、不代签验收、不做 DSH 部署与 UAT、产物只写 run 目录等）
固化在 `scripts/night-batch-session-prompt.md`，由调度器渲染后传给会话，跨工具同一份。

## 无人值守权限（2026-09-16 人工拍板）

- 会话在**相邻容器独立工作树**内施工，物理隔离，可授予宽松权限（full-access 或 auto-edit，
  由 `schedule.permission` 选择模板档）；
- AI CLI 登录态与 CNB 凭据按「本机已登录」处理；
- 看门狗兜底：默认 120 分钟/任务，可在 schedule 调整；
- 验收裁决永远留给人：会话停在「等待验收」，次日早晨按报告定位表逐条人工验收。

## 与旧长提示词的关系

- 筛选/排序/补位语义与 `night-batch-prompt-v2.md` 一致，但执行主体从「AI 现场理解」
  变为「脚本机械执行」；规则变更从此改脚本 + 测试，不再改提示词。
- 旧提示词的「调度层事实排除」由采集脚本承担；「脚本机械门禁」仍由 M3 preflight 承担。
- 远端 CNB 核验是**报告性**的：远端有、本地无条目的任务一律「未纳入（缺本地定义）」，
  夜间不做需求补齐（与旧规则一致）。

> **2026-09-17 ZCode 本机实测更新**
>
> - CLI 入口：`node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`（无独立 PATH 命令）。
> - 无人值守参数：`--cwd <dir> -p "<prompt>"` + `--mode yolo`（全权限）/ `--mode edit`（自动编辑）。
> - `~/.zcode/cli/config.json` 必须存在且含 `model` 键（如 `builtin:bigmodel-coding-plan/GLM-5.3-Flash`）
>   与 `provider`；可从桌面 App `~/.zcode/v2/config.json` 镜像。缺它报 "Model config is missing"。
> - 已知问题：`--max-turns` 在 0.16.5 帮助里出现但解析器不认，时长上限交给看门狗；
>   **`-p` 不能漏**——漏了它 zcode 把整段提示词当「未知命令」直接退出（调度器会如实记
>   「会话退出但未写释放事件」并释放名额）。
> - 全链路实测通过：真实 cwf-run-init 建现场 → 真实 ZCode 会话施工 → 释放事件 WAITING_HUMAN
>   → 报告「等待验收」定位表（分支/worktree/run 目录/验收卡齐备）；现场创建失败、重复 run
>   拦截两条保护路径也在实测中触发过并行为正确。`scripts/night-batch-machine.example.json`
>   的 zcode 模板即实测可用版本。

## 验证状态

- `scripts/test/ai-task-candidate-collect-m5.test.mjs`：采集闸门 6 项
- `scripts/test/ai-task-night-dispatch-m5.test.mjs`：调度器端到端 6 项
  （并发补位、看门狗、释放契约、dry-run、endAt 截止、未到点 pending）
- 真实拉起链路的 CLI 命令模板属每机器配置，首次启用建议先用
  `--dry-run` 看计划，再挑白天用 1 个小任务实测一次真实唤起。
