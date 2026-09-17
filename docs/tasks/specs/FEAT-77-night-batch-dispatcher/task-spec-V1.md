# M5 夜间批次调度器实现（本地任务规格）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 任务标识 | `FEAT-77` |
| 任务类型 | 功能（FEAT） |
| 优先级 | P1 |
| 前置依赖 | `CHORE-73`（cnb#73，已合并，提供对账与账本锁底座） |
| 施工环境组 | `FEAT-77` |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-17 |
| 当前状态 | 定义中 |
| 未决产品事项 | 0 |
| 远端 issue | cnb#77 |
| 代码落点 | 分支 `feat/FEAT-77-night-batch-dispatcher`（提交 `566d774`） |

> 本票为**补票**：实现代码已在分支提交，本规格回顾性固化已实现能力与验收标准。

---

## 1. 背景

夜间批次原先由 M4 定时触发器唤起 M3 执行计划，在**单个 AI 会话内**完成筛选、排序、补位与全部任务施工（每任务经 subagent）。该形态下：长提示词散文驱动 AI 重新理解规则，跨机器/跨工具易漂移；单会话崩溃会拖垮整批；上下文随批次增大。

本轮实现 M5 夜间批次调度器：把确定性调度规则下沉到脚本，**每任务开一个独立 AI CLI 会话**（非 subagent），调度与施工彻底分离。

## 2. 目标

- 调度由脚本机械执行（候选采集 → 快照冻结 → 并发拉起独立会话 → 看门狗 → 补位 → 报告）；
- 每个任务在独立会话内施工，物理隔离（独立工作树/run 目录），单会话异常不拖垮整批；
- AI 只做"单任务施工"一件事，行为边界由渲染后的会话提示词固化。

## 3. 涉及范围

- **做（已实现）**：
  1. `scripts/ai-task-candidate-collect.mjs`：候选采集（登记册状态 / 已有 run / 依赖 / 环境组 / 黑名单），只读本地事实，产出 M3 兼容候选列表；
  2. `scripts/ai-task-dispatcher.mjs`：调度器主体——读 schedule、冻结快照、按并发上限拉起独立 AI CLI 会话、看门狗（默认 120 分钟/任务）、解析 `release-event.json` 契约、补位、落盘批次报告；
  3. `scripts/night-batch-session-prompt.md`：单任务会话提示词默认模板（8 个 `{{占位符}}` 由调度器渲染）；
  4. `scripts/night-batch-machine.example.json`：运行机器配置样例（AI CLI 命令模板、权限档、现场创建命令）；
  5. `docs/design/night-batch-dispatcher.md`：调度器设计文档与 ZCode 实测记录；
  6. `scripts/test/ai-task-candidate-collect-m5.test.mjs` + `scripts/test/ai-task-night-dispatch-m5.test.mjs` + `scripts/test/fixtures/night-batch/`：采集闸门 6 项 + 调度器端到端 6 项（并发补位/看门狗/释放契约/dry-run/endAt 截止/未到点 pending）；
  7. `scripts/ai-task-execution-plan.mjs` 联动改动：复用其 M3 内核（assessAndSort / 依赖判定）未改规则。
- **不做**：改动执行计划内核规则；改动账本写入路径；把调度逻辑回填进长提示词（相反，调度逻辑已从提示词移除）。

## 4. 实现说明

| 环节 | 承载 | 说明 |
|---|---|---|
| 候选采集 | `ai-task-candidate-collect.mjs` | 只读本地事实 |
| 机械门禁 + 排序 + 快照 + 并发状态机 + 补位 | `ai-task-execution-plan.mjs`（M3 内核复用） | 纯状态机，有测试 |
| 到点等待 | 调度器内建（未到点退出码 3） | 与 M4 同语义 |
| 真实唤起施工 | `ai-task-dispatcher.mjs` | 每任务一个独立 AI CLI 会话，不用 subagent |
| 看门狗 | 调度器内建 | 单会话墙钟超时 → 终止 + 记受阻 + 释放名额 |
| 批次报告 | 调度器内建 | 落盘 `.scratch/night-batches/<日期>-<批次名>/report.md` |

**会话隔离**：每任务独立工作树/run 目录，物理隔离；单会话崩溃只影响自身，名额释放后补位。

**结果汇总**：每任务会话退出前写 `<runDir>/release-event.json`（`to ∈ {WAITING_HUMAN, BLOCKED, COMPLETED}`），调度器轮询解析，聚合为批次报告；会话异常单列、不阻塞整批。

## 5. 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 1 | 代码已提交至 `feat/FEAT-77-night-batch-dispatcher` 分支，main 工作树干净 | `git status` 无未提交改动 |
| 2 | 调度器 dry-run 可抓候选并排程 | `node scripts/ai-task-dispatcher.mjs <schedule> --dry-run` 输出候选与启动顺序 |
| 3 | 单任务会话提示词渲染正常 | 占位符 `{{TASK_ID}}` 等由调度器填充，落 `<runDir>/session-prompt.md` |
| 4 | 测试全绿 | `ai-task-candidate-collect-m5.test.mjs` + `ai-task-night-dispatch-m5.test.mjs` 通过 |
| 5 | 验收门通过 | `npm run validate:task-context` 通过 |

## 6. 关联

- **FIX-76**（cnb#76，M5 调度器内建登记册对账）：治本项。FIX-76 落地后，总控提示词（`.scratch/night-batches/night-batch-prompt-v2.md`）第 0 步手动对账可移除，本链路仍保持正确。
- **CHORE-73**（cnb#73）：对账与账本锁底座，本调度器复用其 `collectMergeFacts`。

## 7. 流程约定

本票为补票，代码已实现并落分支。收口动作 = 走 PR 合并分支到 main + 规格入库 + 验收确认。
