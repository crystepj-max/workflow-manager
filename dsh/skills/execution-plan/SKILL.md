---
name: execution-plan
description: "AI 任务批量调度（Execution Plan）：从候选「已定义」任务中筛选可执行项、冻结快照、按 P0、P1、P2 顺序 与定义时间排序、在最大并发内启动单任务交付并在名额释放后自动补位，最后输出批次汇总。不做需求分析/开发/审查/测试/UAT。当用户说「执行计划」「Execution Plan」「批量开工」「按并发跑已定义任务」时使用。"
---

# Execution Plan｜批量调度（M3）
> 本 Skill 属「AI 任务交付」集合（见 `docs/design/ai-task-define-delivery/skill-set.md`）；通用副本同步至 my-agent-skills（下游同步与宿主安装态截至 2026-10-03 未验证，见文末说明）。


本 skill **只负责「哪些任务现在开始」**，不负责把需求谈清楚，也不负责单任务施工。

> 权威：`docs/design/ai-task-define-delivery/execution-plan-m3.md`  
> 公共契约：`docs/design/ai-task-define-delivery/public-task-contract.md`  
> 单任务交付（被启动）：建设 Skill / `single-task-delivery-m2.md`

> 🔴 **迁移遗留边界（W8 旧入口退役）**：本 Skill 保留的排序 / 快照 / 并发补位 / 批次汇总
> 能力仅限显式人工发起的批次。**迁移目标 / 政策口径：候选不再取自旧 registry.json / BOARD.md
> 账本，定时触发（M4）与 M5 夜间自动派发退役，不再无人值守开工**；新任务的身份、认领与状态
> 以 Multica Task 为准。截至本文基线（2026-10-03，main=`861e5a0`），**当前 main 的 M3 实现
> 仍是旧路径**：批次仍由本地 batch.json 提供 issueBasics / taskSpec 材料路径并运行实施前检查
> （`runPreflight`），依赖检查仍读取旧登记册（`loadRegistry` / `collectMergeFacts`）——本 PR
> 只做文档收口，不迁移这些实现。旧入口停写实现见 PR #355，尚未进入 main。
> **在任何分支上都不应再使用定时触发或夜间自动派发**。

## 成功标准

> 多个彼此无前置依赖的已定义任务，能在固定快照与最大并发下稳定批量施工；进入等待验收或执行受阻的任务及时释放名额，后续任务自动补位；自动施工阶段结束时给出可读批次汇总。

## 流程

```text
读取输入（项目 / 候选范围 / 最大并发 / 立即）
  ↓
逐个判定可执行资格
  ↓
冻结本批快照（任务 + 基线版本 + 优先级 + 定义时间）
  ↓
排序（P0>P1>P2，同级定义时间早→晚）
  ↓
在并发上限内启动单任务交付 Run
  ↓
观察 Run 宏观状态：RUNNING 占名额；WAITING_HUMAN / BLOCKED / COMPLETED 释放并补位
  ↓
无 RUNNING 且无可启动剩余 → 结束自动施工阶段
  ↓
输出批次汇总
```

## 硬规则

1. 🔴 **不做**需求分析、产品决策、改基线、开发、审查、测试、代签 UAT  
2. 🔴 快照启动后 **不**动态加入新任务，**不**因版本变化改写快照  
3. 🔴 有前置依赖：不执行，记入未纳入（V0.1）  
4. 🔴 定时与立即运行必须调用**同一**本 Skill（定时逻辑不得复制一套调度规则）（迁移遗留：定时入口已退役，本条仅约束历史行为）
5. 🟡 启动单任务时只触发建设/完整功能开发入口，并把快照中的基线版本交给实施前检查  

## 支撑脚本

| 脚本 | 用途 |
|---|---|
| `scripts/ai-task-execution-plan.mjs` | 资格筛选、快照、排序、并发补位模拟/驱动、批次汇总 |
| `scripts/ai-task-preflight-check.mjs` | 与单任务相同的资格门禁（已定义 / 无人值守 / 版本 / 无依赖） |

## 使用方式

```text
执行计划：最大并发 2，立即跑这些已定义任务
```

或：

```text
批量开工 / Execution Plan（并发=2）
```

定时触发（M4，已退役）：原设计为到点再次调用本 Skill / 同一执行计划脚本，不另写调度内核（历史产品说明：`docs/design/ai-task-define-delivery/scheduled-trigger-m4.md`）。旧触发脚本 `ai-task-scheduled-trigger.mjs` 已退役，不再用于预约或到点派发；其停写实现见 PR #355，进入 main 之前脚本仍可运行，但任何分支上都不应再使用。

**批次前对账（CHORE-73，已退役）**：原流程要求触发脚本唤起执行计划前，先以主干合并事实回写登记册（`registry-reconcile` 的 plan/apply），防止调度按旧账误判依赖。随旧账本停写，`registry-reconcile.mjs apply` 已退役（停写见 PR #358）；`registry-reconcile.mjs plan` 保持只读，可继续用于人工核对主干合并与旧登记册的历史差异，对账结果只供阅读，不回写，也不再作为批次前置步骤。手工跑执行计划无需再执行任何对账命令：

```bash
node scripts/ai-task-execution-plan.mjs path/to/batch.json
```

## 输出

必须落盘或回报「批次汇总」（字段见 `execution-plan-m3.md` §6），并列出等待验收任务的定位信息。（迁移遗留）原到点触发还会额外落盘「夜间批次报告」（字段对齐汇总，见 M4 历史短文）；定时入口退役后不再产生。

## 统一交付边界

- 当前范围与版本已有的需求批准直接复用，不因切换入口重新批准；人工验收是不同决定对象，仍必须由用户作出。
- （迁移遗留，存量口径）原「本地已定义」（本地轨道）与「已定义」**开工资格相同**的规则，仅适用于迁移前已入册的存量任务卡；本地轨道不再产生新候选，新任务的身份与开工资格以 Multica Task 为准，「GitHub 同步 = pending」等旧字段只是历史档案属性。
- 同一任务沿用已经选定的流程；默认新任务使用建设流程，旧版开发工作流仅用于明确指定的迁移期任务，不混用返工额度或验收状态。
- 达到本任务验收要求后完成已授权收尾；不因为存在无关建议或历史欠账无限扩大任务。

## 安装态资料定位

安装或同步后的配套脚本位于本技能 `assets/`；正文的 `scripts/<名称>` 在安装态对应 `assets/<名称>`，`docs/design/ai-task-define-delivery/<名称>` 对应 `assets/ai-task-define-delivery/<名称>`。从技能实际位置使用绝对路径执行，不以当前业务仓库为这些工具的根目录。源码编辑仍在 workflow-manager 的 scripts/docs 中进行。

使用前检查 `source-manifest.json` 和相应脚本、模板；缺少资料先恢复同版本完整技能，不要求用户反复补无关环境。

> 🟡 同步状态（UNKNOWN）：截至本文基线（2026-10-03，main=`861e5a0`），本次收口尚未同步至
> my-agent-skills，各宿主的安装路径与实际加载版本也未验证；一切以 workflow-manager 本仓库
> 源文件为准，不得假定下游副本已是最新。
