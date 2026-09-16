# 运行看板 Logical Run 决策卡与工作区 UI（本地任务规格）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V2 |
| 对应 Issue | 待补（本地轨道，`GitHub 同步 = pending`） |
| 任务标识 | `LOC-016` |
| 优先级 | P2 |
| 前置依赖 | 无（LOC-011/012/013 已合并；#79/#80/#93 已落地；DT-01 仅阻塞片2） |
| 施工环境组 | `LOC-016` |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-11（升版保留） |
| 基线确认时间 | 2026-09-15 |
| 当前状态 | 本地已定义 |
| 未决产品事项 | 0 |

> **V1 → V2 变更摘要**：V1 只有三要素（目标含「人工决策/恢复在界面内完成」）且自述「本卡三要素即基线」，无详细规格与 Definition Check。V2 补齐 19 节详细规格：① 实测确认看板无续跑执行通道（`wf_run` 依赖发起 agent，浏览器 RPC 无 initiator），原「不做新 RPC」与②④互斥 → 按 2026-09-15 人工决策**拆两片**，片1 = 呈现层（本基线，可独立 UAT），片2 = 交互续跑（待 DT-01 探路关闭后另立基线）；② 筛选口径收敛为 Lifecycle + Completion Type 且以模板真源枚举为准（允许 `vwf.runs.list` 只读投影扩展）；③ 工作区面板定为「入档快照 + 宿主侧权威解析的实时活动锁」，capability 不下发浏览器；④ 验收条件全部重写为可操作/可复现；⑤ 目标不降级，仅分期。
>
> 决策票：`decision-tickets/DT-01-ui-resume-attribution.md`（片2 前必须关闭）。
> 分析摘要：`requirements-analysis.md`。

---

## 1. 需求背景

产品规格 §11（`docs/design/workflow-manager-v0.1-final-product-spec.md:236-240`）要求 #75 保证 **Lifecycle / Node Business Outcome / Completion Type 分层表达**，且**一个 Logical Run 跨多个 Execution Segment 仍显示为一个 Run**；§13 发布门槛把这三点列为 v0.1 门槛。运行时底座已就绪：#79 冻结了「为 #75 Run Dashboard 准备的数据模型」（`packages/dsh-visual-workflow/src/host.js:1695`），#80 落地暂停/指导/恢复，#93 落地工作区隔离与上下文入档。

但插件客户端目前只把逻辑运行用于 PAUSED 卡（`client.js:2524`）与列表徽标（`:2563-2568`）；看板不能回答「这次运行跑了什么、为什么完成、中途发生过什么」，人工决策与受阻恢复只能复制命令回会话执行（`:2544-2546`）。

## 2. 用户问题

在 DSH 看板上点开一次运行，用户**看不懂这一次运行**：看不到跨段全貌（哪些段、每段什么触发）、看不到快照修订、看不到各节点的业务结果，也看不到「以什么业务原因完成」——`DONE` 只显示一个状态词。遇到 `WAITING_HUMAN` 或 `BLOCKED` 时，用户只能从看板复制一行 `wf_run` 命令，切回会话手动执行；隔离工作区（mode / 分支 / HEAD / 集成检查点 / 活动锁 / 清理状态）在界面上完全不可见。运行多了以后也无法按「完成类型」或「生命周期状态」筛选。

## 3. 目标

让运维者（用户）在**看板内**完整读懂一次 Logical Run：跨多段仍是一个 Run；时间线、执行分段、快照修订、节点业务结果、完成类型逐项可查；人工决策现场（原因/现状/选项/选择后效果/成本收益风险/建议）结构化呈现并可复制等价续跑参数；隔离工作区现场（含实时活动锁）可见；运行列表可按 Lifecycle 与 Completion Type 筛选。

**本基线（片1）的边界**：达成上述**呈现**能力；「在看板内点选直接续跑 / 改模型恢复」不在本基线（见 §4、§13）。

## 4. 非目标

- 不在本基线实现**看板内续跑执行**（决策卡点选直接续跑、BLOCKED 改 Provider/Model 恢复）——依赖 DT-01 对「执行归属」的探路结论，属片2。
- 不改 Runtime / 引擎 / 编译语义；不改 logical-runs 持久化记录结构与 `vwf.logicalRuns.get` 既有字段语义（只允许**新增只读字段**）。
- 不新增任何能改变运行状态的宿主能力；不把 workspace capability 下发浏览器。
- 不做编辑器改造（LOC-001 / LOC-005 范围）；不做 #75 之外的看板信息架构重构。
- 不按产品规格 §3.3 的全枚举硬编码 Completion Type（含无 producer 的 `COMPLETED_OBSERVING` / `NO_FIX_NEEDED`）。
- 不改 Chat / Skill runbook 口径（LOC-015 已定稿）。

## 5. 修改前

- 运行列表：`taskId / 工作流 / 状态 / 阶段 / runId` + 分页 + 自动轮询，无筛选（`client.js:2557-2583`）。
- 逻辑运行摘要：仅在 `PAUSED` 时调用 `vwf.logicalRuns.get`，仅渲染「同一次运行 · 第 N 段」徽标与暂停卡（`client.js:2524, 2563-2568, 2616-2620`）。
- 门禁队列：`WAITING_HUMAN` 与残留 `AWAITING_HUMAN_*` 各渲染**一行命令文本**（`client.js:2543-2546`），无决策材料、无选项、无后果说明。
- 工作区：界面完全不可见；`vwf.logicalRuns.get` 返回的 `record.workspace` 无人消费。
- 完成类型 / 节点业务结果：界面无任何呈现。

## 6. 修改后

- 选中任一 Run 后，详情视图给出该 Logical Run 的**概览 + 时间线 + 执行分段 + 快照修订 + 节点业务结果 + 完成类型**；多段运行显示为同一次运行。
- 门禁队列与详情内的 `WAITING_HUMAN` 显示**结构化决策材料卡**（原因/现状/选项/每个选项的选择后效果/成本/收益/风险/建议，未知值显式标注「未知」），并给出与实际续跑参数**一致**的等价参数文本可一键复制；`ADD_BUDGET` 明确标出被拦截的 `blocked_edge`。
- 详情内可展开**工作区面板**：mode / repository / 工作分支 / current HEAD / base HEAD / 生命周期 / 分配时间 / 集成检查点 / 清理状态 / **实时活动锁**；无隔离工作区时明确说明。
- 运行列表新增**筛选**：Lifecycle 状态多选 + Completion Type 多选（含「未声明」分组），与分页组合生效。

## 7. 功能范围

1. **Logical Run 详情视图**（消费 `vwf.logicalRuns.get`）
   1.1 概览：`task_id / template_id / title / lifecycle{state,reason} / terminal / created_at / updated_at`。
   1.2 时间线：由 `segments / control_events / guidance / baseline_revisions` **客户端派生**并按时间排序（含段起止、暂停/中断请求、指导提交、基线修订、人工决策段触发）。
   1.3 执行分段表：`index / trigger / status / started_at / ended_at / decision_id / active`。
   1.4 快照修订表：`revision / active / created_at / provider_model`（多修订时展示差异，旧修订保留可查）。
   1.5 节点业务结果：`node_attempts[{node,segment,snapshot_revision,provider,model,outcome,completed_at}]` 与 `business_outcomes{node:{outcome,path,segment,snapshot_revision,at}}`，按节点分组、标注所属段与修订。
   1.6 完成类型：`completion{type,node,path}`；为 `null` 时显示「未声明完成类型」。
2. **决策材料卡（结构化呈现 + 等价参数复制）**
   2.1 数据源：`vwf.state(runId)` 返回的挂起记录（含 `decision_package`、`blocked_edge`、`decision_id`、`results`）；残留 `AWAITING_HUMAN_<node>` 走 `entry + approved` 形态。
   2.2 渲染硬必填：`why / current_state / options[] / subsequent_effects[]`；可选：`cost / benefit / risk / recommendation`；`HD_UNKNOWN` 或缺失显示「未知」，不得省略或代填。
   2.3 `ADD_BUDGET` 必须同时呈现 `blocked_edge{from,to,on}`（缺失时提示「被拦截边未知，需回会话确认」）。
   2.4 提供「复制等价续跑参数」：文本内容与实际续跑参数契约一致（`wf_run { taskId, templateId, decision_id, user_choice, blocked_edge?, feedback? }`；残留门禁为 `entry + approved`）。
3. **工作区面板（只读，含实时活动锁）**
   3.1 呈现 `workspace_id / mode / repository / workspace_path / work_branch / current_head / base_commit / lifecycle / allocated_at / integration_checkpoints / cleanup`；`repository` 由 `source_path` 派生（取仓库名），`base HEAD` 用 `base_commit`。
   3.2 实时活动锁：宿主侧只读解析（由该 Run 的锁事件取出 `resource_key`，再经既有 `activeLockFor` 权威查询，含过期判定），返回未释放锁；**capability 不出宿主**。
   3.3 `record.workspace` 为 `null` 时显示「无隔离工作区（该 Run 未分配）」。
4. **Lifecycle + Completion Type 筛选**
   4.1 列表筛选控件：Lifecycle 多选（八态）+ Completion Type 多选 + 「未声明」分组。
   4.2 Completion 取值来自四模板真源并集 `{EVALUATION_PASSED, USER_ACCEPTED, INSUFFICIENT, DELIVERED}`，另设「未声明」承接 `completion=null`（含诊断模板与停机/未走 `$end` 的运行）。
   4.3 筛选与分页组合：筛选变化时回到第 0 页；结果为空显示空态。

## 8. 不修改范围

- 运行语义：引擎、编译产物、Lifecycle 状态机、Human Decision / Guidance / 额度会计语义。
- 数据契约：logical-runs 记录结构、`decision_package` / `control_event` / `Formal Record` 字段；`vwf.logicalRuns.get` 既有字段语义（仅新增可选只读字段）。
- 工作区内核：`workspace-isolation.mjs` 的分配/锁/清理语义与 capability 校验口径。
- 编辑器（画布、Inspector、角色库）；Chat / Skill runbook；产品规格正文。
- `vwf.run.control` 既有 `pause | interrupt | guidance` 语义。

## 9. 业务规则

- **R1 一次运行一个 Run**：详情视图以 `logical_run_id` 为单位；执行分段只作为该 Run 的内部结构，不产生新的列表行（产品规格 §11）。
- **R2 只读优先**：本基线对宿主面的新增/改动**只允许只读投影**（`vwf.runs.list` 摘要新增 `completion`；`vwf.logicalRuns.get` 新增可选 `refresh_workspace` 入参与 `workspace.active_locks` 只读字段）。不得引入任何可改变运行状态的能力。
- **R3 分层不混用**：Lifecycle / Node Business Outcome / Completion Type 分区表达；业务结果不得渲染成技术 pass/fail。
- **R4 枚举以真源为准**：Completion Type 筛选值取自 `templates/*.json` 的 `completionPath` 枚举并集；无 producer 的枚举不入筛选；模板未声明 → 归「未声明」。
- **R5 决策材料如实呈现**：硬必填四项缺一即视为材料不完整并显式提示；未知值显示「未知」，不代填、不省略。
- **R6 续跑参数唯一来源**：可复制参数由 `decision_id / user_choice / blocked_edge / entry / approved` 现场值生成，禁止硬编码占位符替代真实值（当前 `client.js:2545-2546` 的 `"USER_ACCEPTED|ADD_BUDGET|STOP"` 占位写法必须替换为真实选项）。
- **R7 capability 不下发浏览器**：活动锁等需授权查询一律由宿主侧完成；客户端只能拿结果。
- **R8 缺字段不猜**：无逻辑运行归属的旧 run 记录不显示筛选值，归入「旧记录」，详情给出退化说明而非报错。
- **R9 新旧兼容**：`vwf.logicalRuns.get` 返回 `found:false` 时详情降级为提示，不影响列表与其它面板。

## 10. 用户操作路径

1. 打开看板 → 在运行列表按 Lifecycle / Completion Type 缩小范围（可选）。
2. 点选一行 → 详情视图出现：概览 → 时间线（多段/暂停/指导/基线修订）→ 执行分段表 → 快照修订表 → 节点业务结果 → 完成类型。
3. 若列表顶部存在门禁队列或该 Run 处于 `WAITING_HUMAN`：展开决策材料卡 → 阅读选项与各自后果（含 `blocked_edge`）→ 点「复制等价续跑参数」带回会话执行（片2 起改为卡内直接点选续跑）。
4. 展开工作区面板 → 读取隔离现场与实时活动锁；无工作区时得到明确说明。
5. 完成类型为 `null` 时看到「未声明完成类型」而不是空白。

## 11. 异常和边界场景

- `vwf.logicalRuns.get` 返回 `found:false`（旧记录或已清理）→ 详情显示「逻辑运行摘要缺失」，其余视图不受影响（R9）。
- 挂起记录无 `decision_package`（残留 `AWAITING_HUMAN_*` 门禁）→ 显示旧门禁形态与 `entry + approved` 参数，不显示空卡。
- `decision_package` 缺硬必填项 → 卡片顶部显式标注「材料不完整：缺 <字段>」，仍展示已提供项。
- `add_budget` 场景 `blocked_edge` 缺失 → 提示需回会话确认，不生成不完整参数。
- `completion` 为 `null`（诊断模板 / 停机 / 未走 `$end`）→ 「未声明完成类型」，并进入筛选的「未声明」分组。
- 旧记录无 `control_events / guidance / baseline_revisions` → 时间线退化为仅分段序列，不报错。
- `pause_resume.degraded === true`（检查点降级）→ 在时间线与暂停卡显式标注「检查点降级」。
- 工作区实时锁查询失败 / 内核不可用 → 面板显示「锁状态未知（只读刷新失败）」，其余字段照常显示。
- `record.workspace === null` → 「无隔离工作区（该 Run 未分配）」。
- 筛选组合无结果 → 空态文案 + 一键清除筛选。
- 运行列表分页与筛选叠加 → 筛选变更回到第 0 页，避免越界空白页。
- i18n：新增 key 必须 zh/en 成对；缺 en 时既有机制回落 zh（`host.js:1835-1842`），但不得依赖回落掩盖漏译。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| 看板内续跑（原范围②④的交互部分） | **先探路**：立 DT-01；本基线只交付呈现层 | 实测看板无续跑通道，`wf_run` 依赖发起 agent；执行归属未决前实施风险不可控 | 用户 | 2026-09-15 |
| 体量与切片 | **拆 2 片**：片1 呈现层（本基线）、片2 交互续跑（待 DT-01） | 片1 不依赖未决设计即可独立 UAT；符合「禁止整块开工」 | 用户 | 2026-09-15 |
| 筛选口径 | **Lifecycle + Completion Type**；允许 `vwf.runs.list` 只读投影扩展 | 覆盖发布门槛所需筛选，代价最小且不改持久化契约 | 用户 | 2026-09-15 |
| 筛选枚举来源 | 四模板 `completionPath` 真源并集；含「未声明」分组 | 规格 §3.3 举例含无 producer 枚举，照抄会出现永不命中项 | 用户 | 2026-09-15 |
| 工作区面板口径 | 入档快照 **+ 宿主侧权威解析的实时活动锁** | 用户要求锁信息实时；capability 不下发浏览器以不扩大越权面 | 用户 | 2026-09-15 |
| 目标是否降级 | **不降级**，仅分期（片2 仍以「界面内完成」为目标） | 保持 V1 已确认目标语义一致 | 用户 | 2026-09-15 |
| 无人值守许可 | 允许 | 本基线无必须由人选择的产品问题 | 用户 | 2026-09-15（沿用 V1） |

未决产品事项：0。

## 13. 功能切片关系

- **本切片（片1 · 呈现层，本规格）**：Logical Run 详情视图 + 决策材料卡（只读呈现 + 等价参数复制）+ 工作区面板（含实时活动锁）+ Lifecycle/Completion 筛选。可在不新增执行能力的前提下完成真机 UAT。
- **兄弟切片（片2 · 交互续跑）**：决策卡点选续跑（`decision_id + user_choice + feedback`，`ADD_BUDGET` 带回 `blocked_edge`）与 BLOCKED 改 Provider/Model 恢复（`model_overrides` → 新 Snapshot Revision → 探针 → 恢复同一逻辑运行）。
  - **前置**：DT-01「UI 发起续跑的执行归属」关闭（含可运行探路结论）。
  - **载具**：待 DT-01 关闭后另立规格基线；任务标识届时按登记册分配（本工作区登记册落后于 main，禁止在旧快照上自行推断新序号，避免与并行会话冲突）。
- 拆分原则：最小可独立 UAT 的完整功能切片；片1 与片2 各自可独立验收，片2 不阻塞片1 交付。

## 14. 前置依赖说明

```text
前置依赖：无
```

- LOC-011 / LOC-012 / LOC-013 均已合并（枚举与模板已定稿）。
- #79 / #80 / #93 已落地（数据模型、控制面、工作区入档）。
- DT-01 仅阻塞**片2**，不阻塞本基线。

## 15. 验收条件

- [ ] 详情视图字段与持久化摘要逐项一致：对一个**多段** Logical Run（先经 PAUSED 恢复或人工决策续跑产生第 2 段）展示 `segments / snapshots / node_attempts / business_outcomes / completion`，且显示为**同一次运行**（不新增列表行）。
- [ ] 完成类型：`wf-optimize` / `wf-construction-full-feature` / `wf-explore` 的 `DONE` Run 显示 `completion.type`；`wf-diagnose` 的 Run 显示「未声明完成类型」。
- [ ] 决策材料卡：对 `WAITING_HUMAN` Run 呈现 `why / current_state / options / subsequent_effects / cost / benefit / risk / recommendation`；未知值显示「未知」；`ADD_BUDGET` 场景呈现 `blocked_edge`。
- [ ] 等价续跑参数可复制且与现场一致（无占位符），人工/会话按该参数可成功续跑**同一逻辑运行**（真机验证一次，属人工 UAT）。
- [ ] 工作区面板与 workspace 注册表实况一致：`mode / repository / work_branch / current_head / base_commit / lifecycle / 集成检查点 / 清理状态`，且**实时活动锁**与宿主 `activeLockFor` 结果一致（含释放后消失）。
- [ ] 筛选：Lifecycle 与 Completion Type 组合筛选结果与数据一致；「未声明」分组包含诊断 Run 与停机 Run；筛选后分页正确。
- [ ] 旧记录兼容：无 `logical_run_id` 的 run 不报错，显示退化说明且不进筛选统计。
- [ ] 只读性回归：本轮未新增任何可改变运行状态的宿主能力（代码审阅 + `grep` 断言 `vwf.run.control` 未扩 action、无新 "resume" RPC）。
- [ ] zh/en 文案齐全（新增 key 成对且无残留硬编码中文）；插件包测试绿（含新增客户端冒烟用例与 rpc 桩扩展）；LOC-005 parity 门禁通过；`build` + `check:dist` 通过（dist 一致）；包体未超上限。
- [ ] 未新增/未修改 logical-runs 持久化记录结构（仅 `vwf.runs.list` 摘要新增 `completion`、`vwf.logicalRuns.get` 新增可选只读字段）。

## 16. UAT 场景

### UAT-01 多段 Logical Run 详情（真机）

- 验收目的：一个跨多段的 Run 在看板上仍是一个 Run，且各层信息完整。
- 前置条件：1) 开发/产品 DSH 已加载本版本插件；2) 存在一个产生 ≥2 段的逻辑运行（暂停恢复或人工决策续跑）。
- 操作步骤：1) 打开看板并选中该 Run；2) 查看概览与时间线；3) 查看执行分段表（第 1/2 段）；4) 查看快照修订表；5) 查看节点业务结果；6) 查看完成类型。
- 预期结果：1) 列表仍只有一行该 Run；2) 时间线含段起止与触发原因；3) 分段表段数与 `segments` 一致；4) 修订表含 `active` 标记与 provider/model；5) 节点结果标注所属段与修订；6) 有 `completionPath` 的模板显示类型，无则显示「未声明完成类型」。
- 建议人工关注：多段归属是否清晰；空值是否被如实标注而非留白。

### UAT-02 决策材料卡与等价参数（真机）

- 验收目的：`WAITING_HUMAN` 现场可读、可复制、参数真实。
- 前置条件：构造一个 `WAITING_HUMAN` Run（额度耗尽 `MAX_ROUNDS_REACHED` 或业务 `CONFIRM`）。
- 操作步骤：1) 在看板门禁队列或详情内展开决策材料卡；2) 核对原因/现状/选项/各选项后果（含成本收益风险建议）；3) 点击「复制等价续跑参数」；4) 回会话按该参数执行 `wf_run`。
- 预期结果：1) 材料硬必填齐全，未知值标注「未知」；2) 选项来自 `decision_package.options`，不含硬编码占位符；3) 复制文本与现场 `decision_id` 一致；4) 续跑落为**同一逻辑运行的新段**（第 2 段），不产生新 Run。
- 建议人工关注：`ADD_BUDGET` 的 `blocked_edge` 是否正确带出；`feedback`/理由字段是否可填入（片2 起为卡内输入）。

### UAT-03 工作区面板与活动锁（真机）

- 验收目的：隔离现场与锁状态可见且与注册表一致。
- 前置条件：存在一个已分配隔离 workspace 的运行（如 optimize/construction 类），期间产生资源锁。
- 操作步骤：1) 展开工作区面板并记录字段；2) 与 `workspace-isolation` 注册表实况比对；3) 触发锁获取/释放后重新打开面板。
- 预期结果：1) mode/repository/分支/current vs base HEAD/集成检查点/清理状态一致；2) 活动锁与 `activeLockFor` 一致，释放后消失；3) 无工作区的 Run 显示明确说明。
- 建议人工关注：锁「实时」口径（打开面板即刷新）是否满足预期；面板是否声明「只读」。

### UAT-04 筛选与未声明分组（真机）

- 验收目的：列表可按发布门槛关心的维度筛选。
- 前置条件：存在多种 Lifecycle 状态与多个 Completion Type 的运行，含至少一条 `completion=null`。
- 操作步骤：1) 选择若干 Lifecycle 状态；2) 叠加 Completion Type；3) 选择「未声明」；4) 清空筛选；5) 翻页。
- 预期结果：结果与数据一致；「未声明」包含诊断 Run 与停机 Run；筛选变化回到第 0 页；空结果显示空态。
- 建议人工关注：筛选值列表是否只含真实可产生的枚举。

## 17. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 摘要只读扩展与 #79 冻结模型口径漂移 | 筛选值与详情不一致 | 字段来源单一（一律取自 logical run record），测试断言逐项一致 |
| 实时活动锁的宿主侧解析依赖内核事件与 `activeLockFor` | 锁显示不准或失败 | 失败即降级显示「锁状态未知」，不阻塞面板；以 UAT-03 比对实况 |
| 客户端看板无既有冒烟覆盖且 rpc 桩 `default` 抛错 | 冒烟红/回归漏网 | 新增用例必须同步扩桩（`tests/client.smoke.mjs:194`） |
| 包体上限（160KiB 软水位 / 190KiB 硬上限） | 构建告警或失败 | 详情视图组件拆分复用，避免重复渲染逻辑 |
| LOC-015 暴露的两坑：vm 沙箱缺 `structuredClone`、收口节点无 `completionPath` | 真机异常/完成类型恒空 | 展示层按缺省值处理；完成类型空值显式呈现 |
| 本地登记册落后 main（main 已含 LOC-024–033） | 合并时覆盖他人登记数据 | 只改 LOC-016 条目；合并前先同步 main |
| 片2 执行归属探路若无解 | 「界面内完成」目标无法闭环 | DT-01 若判定不可行，回人工重新决策目标（界面内 vs 命令式） |

## 18. 已知限制

- 本基线看板**不能发起续跑**：决策卡为「材料呈现 + 等价参数复制」；点选续跑与受阻恢复属片2。
- 无 `timeline` 字段，时间线为客户端派生，旧记录可能退化。
- 活动锁为宿主侧只读解析，存在刷新时序延迟（打开面板时刷新一次）。
- `repository` 由 `source_path` 派生、base HEAD 用 `base_commit`，非独立字段。
- 诊断模板 `completion` 恒为 `null`（LOC-012 模板侧待补，不属本任务）。
- 无 producer 的 Completion Type（`COMPLETED_OBSERVING` / `NO_FIX_NEEDED`）不出现在筛选中。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-11 | 初版基线（任务卡三要素，会话指令确认） | 用户 |
| V2 | 2026-09-15 | 补齐详细规格；按实测拆两片（片1 呈现层为本基线）；筛选/工作区/只读投影口径确认；验收重写为可操作；目标不降级仅分期 | 用户 |
