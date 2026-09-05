---
name: construction-bootstrap
description: "在 DSH 会话中驱动「建设 · 完整功能开发」单任务交付：从「已定义」任务开工，按 实施前检查 → 开发 → 收敛审查 → 测试 → UAT 验收卡 → 等待人工验收 → 收口；自动返工上限 3；验收严格三态（通过/退回/有条件通过）；AI 不代签。当用户说「建设工作流」「construction」「用建设工作流跑 issue」「完整功能开发」「单任务交付」「按已定义开工」「construction-bootstrap」时使用。"
---

# 建设 · 完整功能开发 · 单任务交付（M2）

本 skill 是**建设工作流**的 DSH Bootstrap 执行 Profile，产品主链以 **AI 任务定义与批量交付 V0.1 / M2** 为准：

> 权威产品主链：`docs/design/ai-task-define-delivery/single-task-delivery-m2.md`  
> 公共字段/状态/验收三态/返工上限：`docs/design/ai-task-define-delivery/public-task-contract.md`  
> 证据底物契约：`docs/design/construction-workflow-portable-contract.md`（内部交接包；**不得**在交付中重开定义决策闭环）

## 产品可见主链

```text
实施前检查 → 开发 → 收敛审查 → 测试 → UAT 验收卡 → WAITING_HUMAN → 人工三态 → 收口
```

- **定义外置**：需求分析（`requirements-analysis`）先产出「已定义」；本 skill **从已定义开工**，不在主链内做需求分析 + 方案设计人工门。
- **自动返工上限**：**3**（产品拍板；`auto_rework_limit = 3`，与 run `rollback_budget` 默认一致）。
- **验收严格三态**：通过 (`accept`) / 退回 (`reject`) / 有条件通过 (`conditional_pass`)。有条件通过 = 本任务收口 + 优化意见留给下次定义。**禁止**用历史 `user_accepted` 表达有条件通过。

## 自包含内容

- `SKILL.md`（本文件）——入口与使用方式
- `runbook.md` —— controller 逐节点驱动细则
- `shim-map.md` —— shim 边界与退役映射

## 支撑工具（仓库内脚本）

| 脚本 | 用途 |
|---|---|
| `scripts/ai-task-preflight-check.mjs` | 实施前检查（已定义 / 无人值守 / 版本一致 / 无前置依赖） |
| `scripts/cwf-run-init.mjs` | Run 引导：分支 + worktree + run 目录 |
| `scripts/cwf-record.mjs` | 证据记录 + 返工额度记账 |
| `scripts/cwf-checkpoint.mjs` | Integration Checkpoint |
| `scripts/cwf-validate.mjs` | 交接包 schema 校验 |
| `scripts/cwf-evidence-verify.mjs` | 呈递/签收前证据链校验 |

> 安装后 `cwf-*.mjs` 与 schema 随 skill 分发到 `<SKILL_DIR>/assets/`；实施前检查脚本一并复制。

## 前置条件

- 目标任务已由「做需求分析」落成 **已定义**（Issue 基本信息 + 本地任务规格版本一致）；
- 当前会话工作区 = 目标仓库；`git` / `gh` 可用；
- 无人值守许可 = 允许（否则不得自动施工到等待验收）。

## 使用方式

```
用建设工作流跑已定义 issue #N
```

或：

```
完整功能开发 / 单任务交付 #N
```

会话按 `runbook.md` 驱动：实施前检查不过则受阻停止；通过后无人值守跑到 UAT 验收卡并挂起等人；人工三态裁决后从**原 Run**继续收口或返工。

## 硬规则速览

1. 未通过实施前检查 → 禁止开发；
2. 交付中不得自行改需求基线；必须改产品结果 → `BLOCKED：需要重新定义`；
3. review/test 独立会话；自动返工最多 3 轮；
4. AI 不代签人工验收；
5. 有条件通过须保留优化意见供下次定义，且本轮正常收口。
