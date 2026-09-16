# LOC-016 需求分析摘要 · 运行看板 Logical Run / 决策卡 / 工作区 UI

> 分析人：Agent（requirements-analysis）
> 分析时间：2026-09-15
> 输入：会话指令「/requirements-analysis 分析 LOC-016」+ 既有本地任务卡 V1
> 产物基线：**V2**（详细规格 `.scratch/LOC-016-logical-run-ui/task-spec-V2.md`）

---

## 1. 输入识别与轨道判定

| 项 | 判定 | 依据 |
|---|---|---|
| 输入类型 | 已有「本地已定义」任务的**升版分析**（不是全新需求） | `docs/tasks/registry.json` LOC-016：`status=本地已定义`、`baseline=V1` |
| 需求来源 | 会话录入（2026-09-11 开发计划表 v2 / #75 UI 适配） | 任务卡 `来源定位`；仓库内无「开发计划表 v2」文件，只作为 source_ref 存在 |
| GitHub 可用性 | **不可用**（`gh auth status`：keyring token invalid） | 实测命令输出 |
| 交付载具 | **本地轨道**：`docs/tasks/LOC-016-*.md` + 登记册/看板 | `dsh/skills/construction-bootstrap/runbook.md:64-72`；`scripts/local-task-registry.mjs` |
| CNB issue | **仅作记录，不构成 tracker 侧「已定义」** | `requirements-analysis` SKILL §0 第三方 tracker 规则；`scripts/` 中 cnb 零命中；CNB 只出现在 `registry.merge.issue_url` |

结论：本版本属**本地轨道**，对外只称「本地已定义」，`GitHub 同步 = pending`。

## 2. 现状核实（逐条带证据）

数据侧（**已就绪**）：

- `vwf.logicalRuns.get` 已冻结「为 #75 Run Dashboard 的数据模型」（`src/host.js:1695` 注释），返回 `{found, record}`（`:1696-1712`），record 含 `lifecycle{state,reason} / completion{type,node,path} / segments[] / snapshots[] / node_attempts[] / business_outcomes{} / guidance[] / control_events[] / baseline_revisions[] / pause_state / pause_resume / workspace`（`:932-963`）。
- 运行列表摘要经 #79 join 提供 `logical_run_id / segment / segment_count / logical_state / pause_pending`（`:1278-1291, 1682-1692`）；**无 `completion`**。
- 决策材料：挂起 run 记录含 `decision_package{why,current_state,options[{id}],subsequent_effects{},cost,benefit,risk,recommendation}` 与 `blocked_edge`（`scripts/generate.mjs:391-427` 组装、`:430-444` 必填校验；`src/host.js:610-613` 认字段），可经 **`vwf.state(runId)`** 读到（`:1677-1681` 返回完整 run 记录）。
- 工作区入档：`refreshWorkspaceContext`（`src/host.js:1329-1355`）入档 `workspace_id/mode/workspace_path/source_path/source_revision/work_branch/current_head/base_commit/lifecycle/allocated_at/events/resource_locks/integration_checkpoints/cleanup/refreshed_at`；内核 `context` 命令（`scripts/workspace-isolation-host.mjs:459-476`）可只读回放事件；活动锁权威查询 `activeLockFor`（`scripts/workspace-isolation.mjs:519-526`）**本身不校验 capability**（capability 校验在 RPC 层 `src/host.js:2104-2139`）。

UI 侧（**五项零实现**）：

| 待办项 | 现状 | 证据 |
|---|---|---|
| ① Logical Run 详情视图 | 无；`vwf.logicalRuns.get` 仅 `PAUSED` 时调用 | `src/client.js:2524` |
| 多段呈现 | 仅列表徽标「同一次运行 · 第 N 段」 | `src/client.js:2563-2568` |
| ② 结构化人工决策卡 | 无；门禁卡只渲染一行命令文本 | `src/client.js:2533-2548`，命令文本 `:2544-2546` |
| ③ 工作区面板 | 无（`client.js` 中 `workspace` 零命中） | grep 实证 |
| ④ BLOCKED 恢复引导 | 无（提示文本仅存在于宿主返回 `hint`） | `src/host.js:2746` |
| ⑤ Outcome/Completion 筛选 | 无，仅分页与自动轮询 | `src/client.js:2559, 2575-2583` |

门禁/测试/i18n：

- `vwf.run.control` 仅支持 `pause | interrupt | guidance`，**明确不含 WAITING_HUMAN / BLOCKED 续跑**（`src/host.js:1771-1817`）。
- 续跑唯一入口是 `wf_run` 工具，其执行依赖 `agents.requireInitiator()` + `resolveEngine()`（`src/host.js:2603-2605`）；`resolveEngine()` 走 `agents.currentInitiator()` 桥接（`:2506-2512`），而浏览器 RPC 没有发起 agent（同文件 `:81-82` 注释明确「浏览器 RPC / 审批激活都没有会话 cwd」）。→ **看板当前无法发起续跑**。
- 客户端冒烟：`tests/client.smoke.mjs` 无 logical run / 决策卡 / 工作区用例，且 rpc 桩 `default` 抛错（`:194`）→ 任何新 RPC 调用必须同步扩桩。
- i18n：`locales/zh.json`、`locales/en.json`（293 key 对齐），决策选项/详情/工作区/筛选类 key **均不存在**；`dist/locales` 需 build 产出。

## 3. 三要素复核（V1 目标 vs 实测可行性）

| V1 三要素 | 复核结论 |
|---|---|
| 目标「让人工决策、恢复、隔离状态在界面内完成而不是复制命令」 | **部分不可达**：呈现部分可达；「在界面内完成」因缺执行通道**不可达**（见 §4-C1）。目标本身不做降级，改为**分期** |
| 范围（5 项） | ①③⑤ 可立即开工；②④ 的「点选续跑」受阻；「不做新 RPC 与数据契约变更」与 ②④ 互斥 |
| 验收（5 条） | 第 1、2 条要求真机点选续跑 → **本版本无法成立**，需重写为可操作验收（规格 §15） |

## 4. 缺口与冲突

- **C1（阻塞级）执行通道缺失**：看板可调的 RPC 面（`runs.list` / `state` / `logicalRuns.get` / `run.control`）没有任何续跑能力；`wf_run` 是 agent 侧工具。②「决策卡点选 → 同一 Run 续跑」与 ④「改 Provider/Model → 恢复」都需要新宿主能力，且必须先决断**执行归属**（谁作为续跑段的 initiator、跨会话/重启如何保持绑定）。
- **C2 列表摘要缺字段**：筛选需要 `completion`，现有摘要没有（`src/host.js:662`）。
- **C3 工作区字段子集**：入档缺 `repository` / `base_ref`（可由 `source_path` / `base_commit` 派生）；「活动锁」入档是事件切片，非实时。
- **C4 枚举真源**：四模板实际可产生的 Completion Type 并集 = `{EVALUATION_PASSED, USER_ACCEPTED, INSUFFICIENT, DELIVERED}`；**诊断模板未声明 `completionPath` → completion 恒 null**；规格 §3.3 举例中的 `COMPLETED_OBSERVING` / `NO_FIX_NEEDED` 全仓无 producer。筛选若照 §3.3 全枚举会出现永不命中的空档。
- **C5 无 timeline 字段**：时间线须客户端由 `segments / control_events / guidance / baseline_revisions` 派生，旧记录字段缺失时需退化。
- **C6 定义门槛缺口**：LOC-016 此前**只有任务卡**，无 task-spec / definition-check，`任务规格位置` 指向「本卡三要素即基线」——`scripts/ai-task-preflight-check.mjs:74,111` 会因规格不可解析而**开工预检红**。

## 5. 人工决策（2026-09-15 会话已确认）

| 决策 | 选择 | 影响 |
|---|---|---|
| 看板内续跑落地方式 | **先探路**：立 DT-01 决策票；本任务先交付呈现层 | 目标保留，范围分两片 |
| 体量与切片 | **拆 2 片**：片1 呈现层（本基线）、片2 交互续跑（待 DT-01） | 片1 不需要新执行通道即可真机验证 |
| 筛选口径 | **只按 Lifecycle + Completion Type**；允许扩展 `vwf.runs.list` **只读投影**；枚举以模板真源为准 | 不改持久化契约 |
| 工作区面板 | 呈现入档快照 **+ 实时活动锁**；活动锁由宿主侧权威解析，capability 不下发浏览器 | 不扩大越权面 |

## 6. 体量与切片判定

- 原 5 项范围含未决设计未知（C1）→ 整块属 **L**，按 §3.2 禁止整块开工。
- 处置：拆出**不依赖 C1 的可 UAT 切片**（片1 呈现层）先定基线开工；C1 转入决策票 DT-01（`decision-tickets/DT-01-ui-resume-attribution.md`），关闭后片2 另立规格基线。
- 片1 路径清晰、影响面限于插件客户端 + 两处只读投影 → **M**（单一任务规格，不再细分）。

## 7. 落档影响清单

| 动作 | 位置 |
|---|---|
| 详细任务规格 V2 | `.scratch/LOC-016-logical-run-ui/task-spec-V2.md` |
| Definition Check | `.scratch/LOC-016-logical-run-ui/definition-check.md` |
| 探路决策票 DT-01 | `.scratch/LOC-016-logical-run-ui/decision-tickets/DT-01-ui-resume-attribution.md` |
| 任务卡更新（基线 V2 / 规格位置 / 前置依赖 / 变更记录） | `docs/tasks/LOC-016-dashboard-logical-run-ui.md` |
| 登记册与看板（baseline/spec_path/deps/env 对齐） | `docs/tasks/registry.json`、`docs/tasks/BOARD.md` |

## 8. Definition Check 结论

未决产品事项 = **0**；9.1–9.6 全部通过 → 状态改「待确认」，呈递人工确认基线 **V2**。详见 `definition-check.md`。

## 9. 附带发现（不在本任务范围，登记为待办）

1. `docs/design/outcome-presets.json` 三条 Preset 的 `outcomePath` 均为 `$.verdict`，与优化模板实际的 `$.route` 不一致（仅推荐用途，校验不强制）——建议另立小票收敛。
2. 诊断模板 `closeout` 未声明 `completionPath` → 诊断 Run 的 `completion` 恒为 null（LOC-012 范围），影响本任务的「未声明完成类型」呈现与筛选分组。
3. 规格 §3.3 的 `COMPLETED_OBSERVING` / `NO_FIX_NEEDED` 无 producer，属规格举例与实现现状的差距，需在模板侧补齐或修订规格。
4. 本工作区分支落后 main（main 已有 LOC-024–033 与 LOC-023 等待验收）；本任务只改 LOC-016 相关条目，合并时须避免用旧看板覆盖 main 的登记数据。
