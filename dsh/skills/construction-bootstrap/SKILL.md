---
name: construction-bootstrap
description: "在 DSH 会话中驱动「建设 · 完整功能开发」Bootstrap 工作流：以 GitHub issue 为需求来源，按冻结契约执行 需求基线 → 设计 → 开发 → 独立审核 → 独立测试 → 人工验收 → 收口 七阶段主链；全程产出 schema 可校验的七类证据记录、自动回退额度 3、blocked 挂起恢复、AI 不代签人工门。当用户说「建设工作流」「construction」「用建设工作流跑 issue」「完整功能开发」「按契约跑 issue」「construction-bootstrap」时使用。"
---

# 建设 · 完整功能开发 · DSH Bootstrap Profile

本 skill 是**建设工作流 Portable Contract**（`docs/design/construction-workflow-portable-contract.md`，版本以文档头为准）的 DSH Bootstrap 执行 Profile。

> **语义纪律（契约 §9.2）**：业务语义的唯一来源是契约文档；本 skill 只做驱动纪律与工具映射，**不复制契约正文语义**。下文引用契约小节锚点（如 §3.4）时，以契约文档为权威。

## 自包含内容

- `SKILL.md`（本文件）——入口与使用方式
- `runbook.md` —— controller 逐阶段驱动细则（执行时逐条遵循）
- `shim-map.md` —— 正式 Runtime 未落地能力的 shim 边界与向 #82 收敛的退役映射表

## 支撑工具（仓库内脚本）

| 脚本 | 用途 |
|---|---|
| `scripts/cwf-run-init.mjs` | Run 引导：从 target 建分支 + worktree + run 目录 + portable run identity（契约 §7.1） |
| `scripts/cwf-record.mjs` | 证据记录：组装信封 + schema 校验 + 落盘；回退额度记账（§4.2） |
| `scripts/cwf-checkpoint.mjs` | Integration Checkpoint：从实际仓库状态计算 target 是否前进（§7.3） |
| `scripts/cwf-validate.mjs` | 零依赖 JSON Schema 校验器（七类交接包机械校验） |

## 前置条件

- 当前会话工作区 = 目标仓库；`git` / `gh` 可用；
- 契约文档与 schema 在 `docs/design/`；
- 目标 issue 在 GitHub 可访问（`gh` 已认证）。

## 使用方式

在具备 bash/git/gh 能力的 DSH 会话中：

```
用建设工作流跑 issue #N
```

会话即按 `runbook.md` 驱动一个完整 Run：每阶段产出对应证据记录并通过 schema 校验后才允许推进；人工门（基线确认、条件决策、最终验收）一律挂起呈递、AI 不代签（契约 §3.6/§5.4）。

## 硬规则速览（详见 runbook.md 与契约）

1. 每 Run 独立 worktree/branch，禁止共享 main cwd 开发（§7.2）；
2. review/test 必须独立会话产出（§2 不变量 2），`produced_by` 必须异于 dev；
3. 回退一次一条边、按根因路由、自动额度默认 3（§4）；额度耗尽保留原结果升级人工（§4.3）；
4. 一切 Proof 绑定真实 `verified_branch`/`verified_head`（§7.3）；
5. Role 只报告专业结果，路由由本 runbook（controller）决定（§6.1）。
