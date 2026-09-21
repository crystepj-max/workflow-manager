# CHORE-273 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-273` |
| 远端 issue | github#273 |
| 需求来源 | 会话录入：CHORE-260 施工顺序第 4 步（M4 取证与修复） |
| 来源定位 | `github#260` 规格 §5 子票 4；机制清单 M4 |
| 任务名称 | CI 可信度 M4 机械验收：为 CI 提供可对账环境（完整克隆 + main 引用） |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P1 |
| 定义时间 | 2026-09-21T06:25:14Z |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-273-ci-260-m4-acceptance-script/task-spec-V1.md` |
| GitHub 同步 | synced#273 |

> 取值约束：`无人值守许可` 只写枚举原值，`GitHub 同步` 只写 `pending` / `synced#N` / `not-applicable`。

## 摘要

未决产品事项：0

### 问题

CHORE-260 机制表 M4：`M4 机械验收脚本通过` 在 CI 上失败（`AssertionError: M4 检查失败：`，明细被 `validate.mjs` 裁剪）。

### 取证结论（先取证后动手）

**纠正两处既有误判**：父票记为「待定位」，本会话早前据两次 run 又推断为「间歇性（flaky）」。**均不准确**——M4 由**事件类型决定**：`push`→`main` 的 run 无 M4，`pull_request` 的 run（#263/#265/#269）都有 M4，全部数据一致。

在临时诊断分支取回完整输出后，失败项唯一为 `报告须含批次前对账段（CHORE-73）`，报告原文为：

```
【批次前对账（CHORE-73）】
对账失败（不阻塞批次）：Command failed: git ... log main ...
fatal: ambiguous argument 'main': unknown revision or path not in the working tree.
```

**根因（证据链闭合）**：CI 默认 `fetch-depth: 1`（浅克隆）+ PR 事件 checkout merge ref → `main` / `origin/main` 引用**都不存在**（`shallow=true`，两个 `rev-parse` 均失败）→ `registry-reconcile.mjs:46` 的 `collectMergeFacts` 首行 `git log main` **未捕获异常** → trigger 依设计降级为「对账失败（不阻塞批次）」→ 而 M4 检查脚本的断言只认成功文案 `/对账：/`。

**定性**：不是被测产品缺陷，而是 **CI 环境欠缺「批次前对账」所需前提**（完整历史 + 主干引用）。

### 处置

在 `validate.yml` 提供可对账环境：`fetch-depth: 0` + 幂等地补 `main` 引用。**不改任何测试断言**（保持检查力），**不改产品代码**（保留 fail-fast 与「不阻塞批次」原语义）。已在诊断分支验证：CI ③ 段 `✅ 引擎层测试全绿`。

### 本票不做

- 不放宽 M4 断言（不把「对账失败」也算通过——那是用降级分支伪装绿）。
- 不改 `collectMergeFacts` 的 fail-fast（静默当「账实一致」会产生**假绿**，比红灯更危险）。
