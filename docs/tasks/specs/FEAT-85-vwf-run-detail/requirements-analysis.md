# FEAT-85 需求分析摘要（多工作空间运行列表与 Logical Run 详情落地）

| 项 | 值 |
|---|---|
| 任务标识 | `FEAT-85`（远端 cnb#85） |
| 任务名称 | 多工作空间运行列表与 Logical Run 详情落地 |
| 需求来源 | Codex UI 原型 handoff（H2） |
| 来源定位 | `docs/tasks/handoffs/H2-run-detail.md`；共同说明 `docs/tasks/handoffs/README.md`；原型 `packages/dsh-visual-workflow/prototypes/ui-workbench/` |
| 编号 | 由 CNB 远端发号：`FEAT-85` / cnb#85 |
| 轨道判定 | 本地轨道（CNB 远端可达并已建 issue）→ 载具 = 本地任务卡 + 登记册；`GitHub 同步 = pending` |
| 分析时间 | 2026-09-17 |
| 当前状态 | 本地已定义（2026-09-17 松哥确认基线 V1） |

> **决策记录（2026-09-17，松哥裁定）**：与 `LOC-016` 的关系 → **按 handoff 原文独立立单**（不并入、不降级为增量）；重叠后果显式计入规格 §17/§18；`DT-01` 阻塞的提交路径按「受阻交出、不伪造成功」处置。

---

## 1. 需求背景

同一轮 UI 交互更新（见 `docs/tasks/handoffs/README.md`）拆出三份施工 handoff，本任务承接 H2：多工作空间运行列表与 Logical Run 详情。

使用侧的现实是**多机多 AI 并行**：同一台机器上会有多个工作空间、多个任务同时推进。现有看板缺三层能力——多空间视图、Logical Run 单一任务视图、界内人工决策。

## 2. 用户问题（业务语言）

1. **管理不了多空间**：不同工作空间的任务混在一个列表里，看不出归属，也不能按空间筛。
2. **看不懂一次运行**：列表只给状态；详情里节点详情、产物、日志分散在上下两块，来回找。
3. **返工历史被掩盖**：多轮返工看起来像若干新任务；上一轮的成果可能被误读成本轮结果。
4. **人工决策要手抄命令**：部分人工决策仍展示可复制的 `wf_run` 命令文字。

## 3. 目标

1. 列表：多空间分组 + 空间 / 状态 / 结果 / 完成类型筛选 + 分页 + 返回位置保留。
2. 详情：生命周期、当前分段、快照修订、节点尝试、业务结果、完成类型、产物、活动，且**只有一个选中节点结果出口**。
3. 返工可读：attempt / round、退回意见归属正确、旧下游结果标为上一轮成果。
4. 扇出可读：并行组、子任务结果、汇总输入、未完成状态。
5. 决策与恢复在界内完成：结构化决策卡与恢复卡，界面提交而非复制命令。

## 4. 非目标

- 不改执行引擎的重试 / 回环 / 返工上限 / 生命周期语义。
- 不在运行页编辑工作流结构（FEAT-84）。
- 不重新设计供应商 / 模型配置。
- 不加成功 / 失败二元模型。
- 不用新 RPC 替代既有协议。
- 不新造与 `LOC-016` 冲突的生命周期定义。

## 5. 体量判定

| 维度 | 判定 |
|---|---|
| 体量 | L（大型）—— 列表分组与筛选 + 详情工作区重构 + 返工 / 扇出可读性 + 决策与恢复卡 + 工作空间面板 |
| 切片 | 本切片 = H2 全量；与 FEAT-84 / FEAT-86 构成三个可独立验收的切片 |
| 主要载体 | `packages/dsh-visual-workflow/src/client.js`（`Dashboard` 约 2467 行）；可能触及 `src/host.js`（`summary()` 约 662 行、`vwf.runs.list` 约 1680 行后、`vwf.logicalRuns.get` 约 1696 行后、`vwf.run.control` 约 1771 行后、`wf_run` 续跑约 2524 行后） |
| 测试 | `tests/runs-persistence.test.mjs`、`records-runtime.test.mjs`、`runtime-host.test.mjs`、`host.test.mjs`、现有 Dashboard / client 测试 |
| 无人值守 | 允许（决策卡提交路径的受阻规则已定义为边界行为） |

## 6. 现状复现与证据（含对既有任务的核查）

### 6.1 与 `LOC-016` 的重叠（本任务最重要的现状事实）

| 事实 | 证据 |
|---|---|
| `LOC-016`「运行看板 Logical Run 决策卡与工作区 UI」是运行看板语义权威，其范围（Logical Run 详情、结构化决策卡、工作空间面板、BLOCKED 恢复、Outcome / Completion 筛选）与本任务高度重叠 | `docs/tasks/LOC-016-dashboard-logical-run-ui.md` |
| `LOC-016` 的**呈现层实现已存在**，落在未合并分支 `dev-loc-016-r1` | `git merge-base --is-ancestor dev-loc-016-r1 main` → 未并入；`git diff --stat main...dev-loc-016-r1` → `src/client.js` +1319、`src/host.js` +77、`tests/client.smoke.mjs` +535、新增 `tests/logical-run.test.mjs`、`locales/{en,zh}.json` 各 +109 |
| `LOC-016` 当前停在人工验收，返工额度已耗尽 | `.agent-runs/loc-016-r1/run.json`：`stage=human_acceptance`、`attempt=11`、`rollback_used=3`、`rollback_budget=3`；工作树 `workflow-manager-worktrees/dev-loc-016-r1` 存在 |
| `LOC-016` 的**交互层被未决决策票阻塞** | `docs/tasks/specs/LOC-016-logical-run-ui/decision-tickets/DT-01-ui-resume-attribution.md`：`状态 = open`，`阻塞 = LOC-016 片2「交互续跑」（决策卡点选续跑、BLOCKED 改模型恢复）` |
| `LOC-016` 的呈现层在验收阶段被拆为「列表页 + 详情窗口」两页 | `dev-loc-016-r1` 提交 `fa2831d`「运行看板拆为列表页 + 详情窗口」、`e8f9c21`「基线升 V3（验收反馈：列表/详情两页）」 |

**结论**：本任务与 `LOC-016` 存在实质重叠，且重叠的两部分各自处于不同状态——呈现层「已实现待验收」，交互层「未决票阻塞」。人工裁定按 handoff 原文独立立单，因此规格把两项后果显式写入 §17 风险、§18 已知限制，并把「与 `LOC-016` 的分歧裁决」立为验收项 V-12 / UAT-07。

### 6.2 现有 RPC 与字段

| 用途 | 现有协议 |
|---|---|
| 运行列表 | `vwf.runs.list`（含 `logical_run_id` / `segment` / `segment_count` / `logical_state`） |
| 详情 | `vwf.logicalRuns.get`（`lifecycle` / `snapshots` / `node_attempts` / `business_outcomes` / `guidance` / `control_events` / `workspace`） |
| 控制 | `vwf.run.control`（`pause` / `interrupt` / `guidance`） |
| 决策与恢复 | `wf_run` 续跑参数（`decision_id + user_choice`、`resume_paused`、`model_overrides`） |

**注意**：上表来自 handoff 描述，**未在当前宿主上逐字段实测**；施工方须以真实样例确认，不根据截图猜字段名（handoff §7 已明确要求）。

## 7. 决策与裁定

三项关键取舍已在同一轮问询内裁定，以**已关闭的决策记录**形式入库，见同目录 `decision-tickets/DT-01-loc016-overlap-and-resume-path.md`。未决探路票：无（`LOC-016` 的 `DT-01-ui-resume-attribution` 保持 open，但它的处置规则已在本规格 §11 定义为受阻行为，不构成本任务的未决产品事项）。

## 8. 与既有任务的关系

| 既有任务 | 关系 |
|---|---|
| `LOC-016` 运行看板 Logical Run 决策卡与工作区 UI | **范围重叠**（人工裁定独立立单）。其未合并分支实现与本任务可能重复；收口前必须完成分歧裁决（V-12 / UAT-07） |
| FEAT-84 编排台编辑器 | 兄弟切片；本任务复用其工作区头部、返回、只读画布与页签 token |
| FEAT-86 角色库、主题与窄屏收口 | 兄弟切片；本任务向其输出运行页的状态色、状态图标、页签、错误 / 空态与窄屏折叠规则 |
| LOC-014 内置模板模型覆盖 | `BLOCKED` 恢复只调用既有 `model_overrides` 续跑语义，不改其边界 |

## 9. 已知限制

1. 范围重叠已被人工接受，收口阶段必然需要一次分歧裁决；结论不在本规格内预设。
2. 决策卡与恢复卡的**提交路径**可能因 `DT-01` 未决而无法闭环，本任务可能只交付界面与字段映射。
3. 未设机器依赖，可能与前两切片并行施工并产生合并冲突。
4. 原型示例数据不作为生产数据与验收证据。
5. 正式 DSH 真机 E2E 依赖运行环境；无法完成时如实标注。
