# 收口交付动作 close-task 实现：合并后关闭远端 issue 并落账

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 远端锚点 | cnb#106（编号由 CNB 发号） |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 定义时间 | 待人工确认 |
| 当前状态 | 等待验收（开发完成，2026-09-19 松哥验收通过） |

## 1. 需求背景

2026-09-19 对 CNB #36–#77 做账实盘点时发现：该区间 22 个开放 issue 中，**17 个（77%）已开发完成且已合入主干，只是 issue 一直没关**；另有 LOC-016 因范围被取代需人工关单。这 18 个最终由人工逐条关闭。

这不是某一次「忘了关」，而是**收口链路上的能力缺位**：契约层三处明文要求收口关闭 issue，但运行时没有任何代码真正去关。

## 2. 用户问题

**账实不符会持续复发。** 每完成一个任务就多一个「代码在 main、issue 还开着」的条目；当缺口积累到 17 个时，登记册与看板已经无法反映真实进度，只能靠周期性人工盘点补救。更隐蔽的问题是**收口提示词宣称了自己没有的能力**——注入给收口节点的话术写着「本节点会执行创建 PR、合并、关闭 issue」，而 `close-task` 在运行时根本没有实现，于是「关闭」这一步被静默跳过，报告仍显示收口成功。

## 3. 根因（四层，实测证据）

| 层 | 结论 | 证据 |
|---|---|---|
| 1 · 执行主体变更 | GitHub 时代由 closeout **agent 节点直接跑 gh CLI**；现架构把能力收进 WR-014 适配器，但代码没接上 | commit `49cf16c`「收口节点接管合并 PR 与关闭 issue」；`dsh/workflow/` 目录已不存在 |
| 2 · 适配器未实现（决定性） | `close-task` 只在**常量与注释**里声明，无任何 provider 实现 | `operations-host.mjs` L24（注释）/ L50（常量），唯一注册 provider 为 `local-count`（测试计数器）；`delivery-closeout-host.mjs` L27 同样仅常量，全文搜 `issue` 零命中 |
| 3 · GitHub 适配器被显式标为不可用 | 账号暂停期的设计决策，且不回落 CNB | `UNAVAILABLE_ADAPTERS = ['github']`（delivery-closeout-host L26）；`DECLARED_UNAVAILABLE_PROVIDERS = ['github']`（operations-host L53） |
| 4 · 平台关键字通道未接上 | 11 个已合并 CNB PR 正文**全空**；merge commit 尾注写作 `（cnb#77）`（中文全角括号 + `cnb` 前缀），与 `close #77` / `Closes #77` 形态三重不匹配，两平台均无法识别 | 实测 11 个 PR body 为空；主干 merge commit message 样本 |

补充：本批任务实际走的是**本地脚本路线**（`local-task-merge.mjs`），全篇仅 1 处 `issue` 字样（字段默认值），压根没有关闭步骤。引擎蓝图路线与本地脚本路线能力不对等。

## 4. 目标

1. 让 `close-task` 从「声明」变成「可用」：合并成功后关闭对应远端 issue。
2. 让收口**宣称的能力与实际注册的动作一致**，消除「承诺了运行时没有的东西」。
3. 关闭失败时**不再静默**：显式写入交付报告「待人工关闭」并附 issue 号，不得标记 DELIVERED。

## 5. 非目标

- 不改动 GitHub 适配器「已声明未接线」的现状（账号与凭据问题另行决策）；
- 不改动 FEAT-84/85/86 相关的工作流 UI 交互（由 ZCODE 推进，本票不触碰）；
- 不做历史 issue 批量补关（已于 2026-09-19 人工完成）；
- 不重构 WR-014 的幂等与核查框架，只在其既有约定下注册实现；
- 不处理与本票无关的既有红灯。

## 6. 修改前

| 对象 | 现状 |
|---|---|
| `scripts/operations-host.mjs` | `MANAGED_ACTIONS = ['create-review','merge','close-task']`；`close-task` 无 provider 实现；仅 `local-count` 注册 |
| `scripts/delivery-closeout-host.mjs` | `DEFAULT_GIT_ACTIONS = ['create-review','merge','close-task']`；`close-task` 无执行分支；全文无 `issue` |
| 收口节点注入提示词 | 宣称「创建 PR、合并、关闭 issue」 |
| `scripts/local-task-merge.mjs` | 无关闭远端 issue 步骤 |
| `dsh/roles/closeout.md` L22 | 外部动作由适配器声明，不由角色固定自带（契约本身正确，缺的是实现） |

## 7. 修改后

| 对象 | 目标态 |
|---|---|
| `operations-host.mjs` | 注册 CNB 适配器对 `close-task` 的实现（含 `execute` 与 `reconcile`），遵循既有幂等键约定 |
| `delivery-closeout-host.mjs` | `close-task` 走真实执行分支；合并成功后按任务 `remote` 锚点关闭 issue |
| 收口提示词 | 生成动作计划时只声明**已注册**的动作；未注册者不出现在话术中 |
| 失败处理 | 关闭失败或缺 issue 号 → 交付报告记「待人工关闭 <号>」，收口状态不得为 DELIVERED |
| 测试 | 新增用例覆盖：成功关闭、幂等重放、失败不谎报 |

## 8. 验收标准

1. 收口动作计划中的 `close-task` 执行后，目标 issue 在 CNB 侧为 `closed`，`operationsGet` 返回 `confirmed_success`。
2. 同一幂等键重复执行不产生第二次外部效果，返回既有结果。
3. 关闭失败（远端不可达 / 权限不足 / 缺 issue 号）时收口**不得**标记 DELIVERED，报告显式列出「待人工关闭」及 issue 号。
4. 收口节点注入提示词中声称的能力与实际注册动作一一对应，无「宣称但未接线」项。
5. 既有测试全绿，新增用例覆盖上述 1–3。

## 9. 风险与取舍

| 风险 | 说明 | 处置 |
|---|---|---|
| CNB 适配器需凭据 | 关闭 issue 需 `cnb` CLI 已认证 | 沿用 `remote-issue-sync.mjs` 既有的 `remoteAllocate` / `resolveRemoteSlug` 通道，不新引入凭据机制 |
| 误关 issue | 关闭动作不可逆 | 只在「合并已确认成功」后执行；关闭前核查 issue 当前状态（WR-012 防重） |
| 本地脚本路线仍未覆盖 | 本票只补引擎路线，走 `local-task-merge.mjs` 的任务仍不会自动关 | **已裁定（DT-01，松哥 2026-09-19）**：采纳方案 A——不做自动关闭，但收口报告显式列出「待人工关闭 <issue 号>」；`local-task-merge.mjs` 不在本票改动范围 |

## 10. 关联决策记录

| 票 | 主题 | 状态 |
|---|---|---|
| `decision-tickets/DT-01-local-script-route.md` | 本地脚本路线是否也接入关闭动作 | **已关闭** · 裁定 A（只补引擎路线 + 报告显式列「待人工关闭」） |

> 裁定依据：本次缺口根因是「动作被声明但未实现」，直接补实现即命中根因；本地脚本是收口主路径（本批任务全部经过），改动其回归代价远高于收益；且 A 含「报告显式列待人工关闭」兜底，保证不再静默遗漏。后续若本地路线也需自动化，可另立一笔复用本票实现。

---

未决产品事项：0

基线经松哥确认，可开工。
