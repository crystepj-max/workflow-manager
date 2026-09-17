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

## 验证状态

- `scripts/test/ai-task-candidate-collect-m5.test.mjs`：采集闸门 6 项
- `scripts/test/ai-task-night-dispatch-m5.test.mjs`：调度器端到端 6 项
  （并发补位、看门狗、释放契约、dry-run、endAt 截止、未到点 pending）
- 真实拉起链路的 CLI 命令模板属每机器配置，首次启用建议先用
  `--dry-run` 看计划，再挑白天用 1 个小任务实测一次真实唤起。
