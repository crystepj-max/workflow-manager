# CHORE-106 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-106` |
| 远端 issue | cnb#106（编号由 CNB 远端发号） |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-19 CNB #36–#77 账实盘点（见 `wayfinder/tickets/SYNC-02-cnb-issue-inventory.md`）与收口缺口根因分析（见 `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`） |
| 任务名称 | 收口交付动作 close-task 实现：合并后关闭远端 issue 并落账 |
| 任务类型 | 维护性（编号类型 CHORE） |
| 优先级 | P1 |
| 当前状态 | 定义中 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-106-close-task-issue/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | pending |

> 说明（不进机器解析字段）：
> - `无人值守许可 = 允许` 的依据：补齐既有契约已声明的动作实现与提示词对齐，施工中无需要人取舍的产品问题。
> - 取值约束：`无人值守许可` 只能写枚举原值，`GitHub 同步` 只能写 `pending` / `synced#N` / `not-applicable`，附加自然语言会导致实施前检查失败。

## 摘要（三要素速览）

### 任务目标

让「PR 合并后远端 issue 自动关闭」从**契约承诺**变成**真实能力**，消除「代码已合入主干、issue 一直开着」的账实不符，并使关闭失败时能被显式发现而不被静默吞掉。

### 涉及范围

- 做：
  - 在 WR-014 交付适配层实现 `close-task` 动作（CNB 适配器注册 + 幂等与核查）
  - 使收口注入提示词与实际能力一致：不再宣称未实现的动作
  - 收口关不掉 issue 时，显式写入交付报告「待人工关闭」，不得记为 DELIVERED
  - 统一 merge commit / PR 尾注为平台可识别的关联格式，或明确记录「不依赖平台关键字、由适配器显式关闭」
- 不做：
  - 不改动 GitHub 适配器「已声明未接线」的现状（账号与凭据问题另行决策）
  - 不改动 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进）
  - 不做历史 issue 的批量补关（已于 2026-09-19 人工完成）

### 验收标准

1. 收口动作计划中的 `close-task` 被执行后，目标 issue 在 CNB 侧状态为 `closed`，且 `operationsGet` 能核查到 `confirmed_success`。
2. 重复执行同一 `close-task`（幂等键不变）不产生第二次外部效果，返回既有结果。
3. 关闭失败（远端不可达、权限不足、issue 号缺失）时：收口**不得**标记 DELIVERED，交付报告中显式列出「待人工关闭」及 issue 号。
4. 收口节点注入提示词中声称的能力，与实际注册的动作一一对应；无「宣称但未接线」项。
5. 既有测试全绿，新增用例覆盖上述 1–3。

## 关键证据（2026-09-19 实测）

| 项 | 实测结果 |
|---|---|
| 账实缺口 | CNB #36–#77 区间 22 个开放 issue 中，17 个（77%）已开发已合入仅差关单；已人工关闭 |
| `operations-host.mjs` | `MANAGED_ACTIONS = ['create-review','merge','close-task']`；`close-task` 全文仅出现在注释（L24）与常量（L50），**无任何 provider 实现**；唯一注册 provider 为 `local-count`（测试计数器） |
| `delivery-closeout-host.mjs` | `DEFAULT_GIT_ACTIONS = ['create-review','merge','close-task']`（L27）；`close-task` 同样仅常量一处，无执行分支；全文搜 `issue` 零命中 |
| 适配器可用性 | `UNAVAILABLE_ADAPTERS = ['github']`（L26）；`DECLARED_UNAVAILABLE_PROVIDERS = ['github']`（`operations-host.mjs` L53）；遇 github 目标返回 `capability_unavailable` 且不回落 CNB |
| 角色契约 | `dsh/roles/closeout.md` L22：外部动作机制由 WR-014 适配器与动作计划声明，**不由本角色固定自带** |
| 历史实现（GitHub 时代） | commit `49cf16c`「收口节点接管合并 PR 与关闭 issue」——由编排脚本中的 closeout **agent 节点直接执行 gh CLI**；该编排脚本目录 `dsh/workflow/` 现已不存在 |
| 平台关键字 | 11 个已合并 CNB PR 正文**全空**；merge commit 尾注格式为 `（cnb#77）`（中文全角括号 + `cnb` 前缀），非 `close #77` 形态，两平台均无法识别 |
| 本地脚本路线 | `local-task-merge.mjs` 全篇仅 1 处 `issue` 字样（字段默认值），无关闭步骤 |

## 关联

- `wayfinder/tickets/SYNC-02-cnb-issue-inventory.md`（账实盘点）
- `wayfinder/tickets/SYNC-03-closeout-gap-and-stash-audit.md`（根因分析）
- `wayfinder/tickets/SYNC-01-cnb-panel-deferred.md`（CNB 面板 UI 推迟，与本票无关）
- `docs/design/ai-task-define-delivery/`（编号与远端同步设计）
