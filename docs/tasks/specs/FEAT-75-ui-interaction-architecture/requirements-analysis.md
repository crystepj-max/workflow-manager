# FEAT-75 需求分析 · 工作流插件 UI / 交互架构定稿

> 分析人：Agent（requirements-analysis，独立开工会话）
> 分析时间：2026-09-19T12:37:16Z
> 输入：会话指令「为 GitHub #75 做需求分析，只到基线呈递、不进开发」+ 前置盘点结论（2026-09-19，8 条缺口，要求复核后采信）
> 产物基线 / **版本**：V1（草案，未确认）

---

## 1. 输入识别与轨道判定

| 项 | 判定 | 依据 |
|---|---|---|
| 输入类型 | **全新设计定稿任务**（#75 自开 Issue 起无本地卡、无规格目录） | `ls docs/tasks/` 无 `*-75-ui-*`；registry 76 条无锚定 github#75 的记录 |
| 需求来源 | github-issue（正文 + 1 条裁定评论） | `gh issue view 75`；`gh api .../issues/75/comments` 返回 1 条 |
| GitHub 可用性 | **可用**（`gh` 已认证，读写正常） | 本轮实测多条 `gh issue view` / `gh api` |
| 交付载具 | **GitHub 轨道**：远端 issue 已存在（#75 OPEN），本卡为设计定稿承载 | `docs/design/ai-task-define-delivery/public-task-contract.md` §1/§2 |
| 是否本地轨道降级 | 否。`GitHub 同步 = synced#75`，不写 `pending` | 同上 §11 |
| 本阶段边界 | 只做需求分析与基线呈递；**不进实现、不改插件源码、不动 DSH** | 会话指令；AGENTS.md「VWF 开发/产品双轨」 |

🔴 前置盘点结论的复核结果：**8 条中 3 条需要修正**（R-1 表述失真、R-4/R-5 已有卡承接、R-6 根因更深），另有 4 项盘点未提但影响结论的事实。下表逐条给证据。

## 2. 现状核实（逐条带证据）

| 编号 | 前置盘点断言 | 复核结论 | 证据 |
|---|---|---|---|
| R-1 | "插件侧**无任何**运行 / Invocation 入口" | **不成立（表述失真）**。运行能力已在，形态是 Chat 侧工具调用：`wf_run` 注册于 `src/host.js:3075`（描述即"运行一个可视化工作流"），实际起跑 `engineNow.start` 于 `:3456`，含 `resume_paused` 与 `model_overrides`。真实缺口只有两点：① 浏览器 UI 无运行入口（`src/client.js:5194-5198` 行操作只有 查看流程/模型设置/编辑/删除）；② #83 设想的独立 `Invocation Adapter` 层在 `src/` 零命中（`grep -i invocation`），当前是 Skill → 插件内工具 → 引擎的单层结构 | 见左 |
| R-1b | "Skill / Chat 与插件入口关系仍是待定项，A/B/C 未裁定" | **部分成立**。#75 §3 的三选一确实未裁。但 **LOC-015 已裁掉一个备选**：2026-09-11 决策"发起权归插件（方案 A），备选『结果回灌』方案（B）不采纳，内置 `workflow` 工具降为应急回退"，并真机 UAT 通过（`docs/tasks/LOC-015-skill-invocation-runtime.md` 变更记录 2026-09-12） | `LOC-015` 卡 §变更记录 |
| R-2 | "`outcome-presets.json` 在 `src/` 零引用" | **成立，且比盘点更严重**：文件三条 preset 的 `outcomePath` **全部是 `$.verdict`**，而正式模板实际 `$.route` 14 处 / `$.status` 3 处 / `$.verdict` 仅 `templates/wf-explore.json:336` 一处（18 个声明合计）。**照该文件做选择器会给用户错默认值**。现状配置方式：`client.js:1917-1931` 手填字段名 + 从当前 schema 穷举候选，不读 preset | `cat docs/design/outcome-presets.json` + `grep -rn outcomePath templates/*.json` |
| R-3 | "`client.js` 内 `completionPath` 命中 0" | **成立**。但契约与运行时**全通**：`src/host.js:974` 读 `outcomePath \|\| completionPath`；四套模板均已声明 `"completionPath": "$.completion_type"`（`wf-construction-full-feature.json:452`、`wf-diagnose.json:273`、`wf-explore.json:337`、`wf-optimize.json:222`）。缺的**只是编辑入口**，用户当前只能经"高级设置 / JSON"页签手改 DSL（`ingestEditorJson` `client.js:5347-5367` 逐节点透传） | 见左 |
| R-4 | "没有 Timeline 视图，roadmap:176 仍列此项" | **成立，但已有卡承接**：`roadmap.md:176` 确在列；现状"完整经过"弹窗按**模板节点顺序**生成（`chainEntries` `client.js:3977-4055`，`seq = ni+1`），不含快照/探针/决策/指导事件。但 **LOC-016 V2 片1 已把"按时间排序、由 `segments/control_events/guidance/baseline_revisions` 客户端派生"写进基线**（其 `task-spec-V2.md` §7.1.2），状态「本地已定义」未开工 | `docs/tasks/specs/LOC-016-logical-run-ui/task-spec-V2.md:69` |
| R-5 | "决策卡 / BLOCKED 提交续跑未实现" | **成立，已另立 FEAT-208**（GitHub #208，状态「本地已定义（待派工）」）。FEAT-85 交付的呈现层已相当完整：决策卡含原因/现状/选项/后果表/成本收益风险推荐/`blocked_edge`/理由输入/参数映射（`client.js:4509-4588`），恢复卡含逐节点 Provider/Model 下拉与 `model_overrides` 映射（`:4590-4648`）；**提交按钮两处硬禁用**（`:4581`、`:4646`）。注意 `pause`/`interrupt`/`guidance` 三类控制**已接通**（`:4082`） | 见左 + `FEAT-208` 卡 §2–§3 |
| R-6 | "OBSERVING 呈现未设计" | **成立，根因不在 UI**：全仓 OBSERVING 仅出现在文档（`...-final-product-spec.md:76,119-121`、`workflow-design-principles.md:226`），`templates/`、`scripts/`、`specs/`、`packages/` 命中 0；看板 Completion 筛选按**实际 producer 动态生成**（`client.js:3602-3610`），故该值永不出现。这是"没有生产者"而非"没有界面"→ 需产品裁定呈现来源（DT-03） | `grep -rn OBSERVING` 实测 |
| R-7 | "#54–#57 裁定未入库" | **成立**：四票 GitHub 均 `closed=COMPLETED`（2026-08-26T04:46:58–59Z）、**0 评论**；`docs/design/` 查无裁定记录。#75 §11 要求的 supersede/merge 标记从未落地 | `gh issue view 54..57 --json state,stateReason,closedAt,comments` |
| R-8 | "Run 看板字段缺口"（盘点未列，#75 §6 要求 8 项） | **成立，约 3.5/8**。已有：task/workflow（`client.js:3804,3813-3816`）、Logical Run 跨段聚合为一条（`:3369`）、attention 分桶（`:3336-3338`）、Lifecycle 部分（`statusBadge` 混合 status/lifecycle `:3288-3290`）。缺：current node（宿主已回传 `host.js:715` 但行内不渲染）、last Node Outcome、回退额度 `used/limit`（宿主已有 `host.js:690`，UI 只有"返工 N 次" `:3399`）、当前快照修订（仅详情内）、最近事件（仅 `dashUpdatedAt` 时间戳） | 见左 |
| R-9 | "权威设计材料没有入库" | **成立**，且需修正一处：GitHub #75 **只有 1 条评论**（P1–P10 第五轮），第 1–4 轮审查在 CNB 期、未随迁移带回——即"P1–P10 评论全文"是可取到的，但**更早的推理过程已不可得**。`...-final-product-spec.md:240` §11 与 `:270` Phase D 把 UI 整体推给 #75；实际视觉权威在 `packages/dsh-visual-workflow/prototypes/ui-workbench/`（`DESIGN.md` 78 行三方向 A/B/C、`REVIEW-2.md` 63 行收敛为"统一 A 编排台"，§交付边界明确**未修改正式插件源码、不能直接作为生产实现合入**）与 `docs/tasks/handoffs/H1|H2|H3.md`（2026-09-17，是 FEAT-84/85/86 的**需求来源**，非裁定记录） | `gh api .../comments` 计数 1；`REVIEW-2.md` §交付边界 |

**盘点未提、但改变结论的三条事实**：

- **F-1 载荷预算贴线**：现值 `289230B / 290816B`，余量约 1.6KB（`docs/tasks/closeout-20260919-integration-round.md` §遗留与待裁决；FEAT-208 §3 已把"载荷预算不上调"写成零回退约束）。**#75 任何新增 UI 切片的成本都被这条抬高**，不能按"加个下拉"估价。
- **F-2 #83 / #79 / #76 均已 closed=COMPLETED**（#83 关闭于 2026-09-19T12:16Z）。盘点把切片描述为"依赖 #83 Runtime"，实际 **#83 已交付且裁定过发起权归属**；真正未落地的是"独立 Invocation Adapter 分层"这一实现形态，而非 Runtime 能力本身。
- **F-3 🔴 并行会话已就同一份 #75 给出相反处置**：`CHORE-113`（状态「待确认」）+ `FEAT-114`（完成映射 + 多层路径）+ `FEAT-115`（面板四段重排）已落盘，其 `task-spec-V1.md` §12 记录"#75 降为需求源并关票，只拆残余"，并把 OBSERVING 裁为 v0.1 非目标、Completion Mapping 裁为不算发布门槛。这与本轮收到的"#75 保留推进"前提互斥 → 见 `decision-tickets/DT-00-issue-75-fate.md`。**本轮独立复核与它有三处分歧**：① Timeline 它判"已实现（形态不同）"，实测"完整经过"弹窗按节点序、不含快照/探针/决策事件，不满足合并时间线定义；② 它把 Outcome Preset 判给 FEAT-114，而 FEAT-114 明确不做 Preset 库，该面无人认领；③ 它把 #54–#57 判"无需再判"，未留裁定依据。

## 3. 三要素复核（#75 正文 14 项完成标准 → 归属）

| #75 §本阶段完成标准 | 结论 | 归属 |
|---|---|---|
| 模板库 Built-in/Custom 信息架构 | 已实现（分区 + 只读 + 徽标） | 定稿见架构文档 §4.1，不再拆卡 |
| Skill/Chat/插件正式 Invocation 关系 | 🔴 **未决** | DT-01 → 切片 S-1（选 A 则取消） |
| Built-in Model Override UI | 已实现（逐节点一行） | §4.1；REVIEW-2 已删"整套流程默认层" |
| 自定义 Workflow 渐进式编辑结构 | 已实现**三段 tab**（基础/结果与去向/高级，`client.js:2106-2112`，注释 `:361` 自述"配置栏三段 tab"）；目标四段 | **FEAT-115**（面板重排）；本文 §4.2 定稿 |
| Outcome Preset + 自定义 Outcome | **部分**：手填已实现（且只认单层路径 → FEAT-114），Preset 无；**preset 数据本身有误** | 先纠偏小票 → DT-02 → S-2；⚠️ CHORE-113 把整项判给 FEAT-114，但 FEAT-114 声明不做 Preset 库 → **无人认领** |
| Completion Mapping | **未实现 UI**（契约/模板/运行时全通） | **FEAT-114**（本轮不再主张为 #75 切片；已裁"不算 v0.1 发布门槛"） |
| Preflight / Snapshot Model 修改 | **部分**：编辑器一键检测 + 只读快照表已实现；缺"运行中改模型 → 新 Revision"的 UI（宿主 `wf_run model_overrides` 已支持） | 与 S-4 同期；改模型提交面归 FEAT-208 |
| Logical Run Dashboard | **部分**（3.5/8 字段） | S-4 |
| Run Detail：流程 / Timeline / 成果证据 | 流程 ✅、成果证据 ✅（三分组 + 快照卡）、**Timeline ❌** | Timeline 归 **LOC-016 片1**；本文 §4.3 定稿三类视角 |
| PAUSED / Guidance | 已实现（控制已接通 `client.js:4082`） | P6/P7 记入约束，不拆卡 |
| WAITING_HUMAN / Human Decision | 呈现 ✅ / 提交 ❌；**三层同屏（Outcome+Lifecycle+reason）未定稿** | 提交归 FEAT-208；三层同屏补入本文 §4.5，视觉细化随 S-4 |
| BLOCKED / 模型替换 / Probe / Resume | 呈现 ✅（恢复卡）/ 提交 ❌ | FEAT-208；P5"不静默换模型"已记入铁律 |
| COMPLETED / STOPPED / FAILED / Observing | 终态 ✅ / **OBSERVING ❌ 无 producer** | DT-03 → S-5 |
| #54–#57 保留/合并/supersede 决策 | **本轮成文**（架构文档 §7） | S-0，已完成草案 |

14 项中：7 项已由既有实现承接（本文只写定稿，不重复立项）、1 项待裁归属（Timeline：LOC-016 vs 已实现）、4 项待产品裁定或已由并行会话裁定（DT-00 冲突 + DT-01/02/03，其中 DT-03 可能已裁）、3 项为净新增/补齐施工面且**其中 S-3 已被 FEAT-114 认领**（#75 派工面实际收缩为 S-2 + S-4）。

## 4. 缺口与冲突

- **C1（决策阻塞级）** 运行入口 A/B/C 未裁 → S-1 无法定范围。附带未知：插件浏览器侧能否唤起 Skill 会话（本轮**未取证**，需在裁 B/C 前探路，理由同 LOC-016 C1：浏览器 RPC 没有发起 agent）。
- **C2（数据缺陷）** `outcome-presets.json` 的 `outcomePath` 与实际模板不符。**不修数据就接选择器 = 把错默认值交付给用户**。这是本卡唯一发现的、盘点未识别的实质错误。
- **C3（范围冲突风险）** Timeline 与"看板续跑"分别已有 LOC-016 片1 / FEAT-208 的**有效基线**。#75 若另立同名卡会抢改同一文件（`client.js` Run Detail 区），须显式避让。
- **C4（成本误判）** 载荷余量 1.6KB。S-3/S-4/S-2 每一片都必须附瘦身评估，否则实现到一半撞闸门（CHORE-104 瘦身专项刚为此做过 −14028B）。
- **C5（验收空档）** OBSERVING 与"诊断模板 `completion` 恒 null"（`LOC-016` 附带发现 2）同属"规格举例无 producer"。若按 #75 正文枚举直接验收，会出现永不命中的空档。
- **C6（治理）** 卡号 `FEAT-75` 与既有 `CHORE-75` 数字重叠，根因是发号源迁移（CHORE-111 / GitHub #215）仍「待确认」未生效。本卡沿用登记册现有口径并注明，不自行改规则。
- **C7（🔴 最高优先，治理冲突）** 与并行会话 `CHORE-113` 对同一份 #75 得出互斥处置结论（保留推进 vs 关票），且五方（CHORE-113 / FEAT-114 / FEAT-115 / LOC-016 片1 / FEAT-208）与本卡 S-2/S-4 共用 `client.js` 的编辑器面板与 Run Detail 改动面。**未裁前 #75 不得进「待确认」，也不得由任一方在 GitHub 上动票**。→ `decision-tickets/DT-00-issue-75-fate.md`。

## 5. 人工决策（本轮呈递，未代签）

| 决策 | 状态 | 票 |
|---|---|---|
| **#75 保留推进 vs 降为需求源关票**（会话间冲突） | 🔴 待裁定（先决，阻塞其余三票归属） | `DT-00-issue-75-fate.md` |
| 并行会话记录的三条"产品（本会话）"裁定是否为您本人所做（OBSERVING 非目标 / Completion Mapping 不算门槛 / 先补能力再重排） | 🔴 待确认；若为真，DT-03 直接以方案 A 关闭 | 同 DT-00 §4 |
| 插件运行入口 A/B/C | 🔴 待裁定 | `DT-01-plugin-run-entry.md` |
| Outcome Preset 呈现深度 | 🔴 待裁定 | `DT-02-outcome-preset-surfacing.md` |
| OBSERVING 呈现口径 | 🔴 待裁定（可能已裁） | `DT-03-observing-presentation.md` |
| preset 数据纠偏（C2） | 建议批准，纯数据修复不含产品取舍 | 随 DT-02 一并确认 |
| 卡号是否避开 `-75`（C6） | 建议在本轮定，改名成本随施工开始而上升 | 卡 §说明① |

## 6. 体量与切片判定

- 整块（#75 全部 14 项）含 3 项未决产品决策 + 跨 5 个界面区 → **L 型，按硬规则禁止整块开工**。
- 处置：S-0（权威落库，本卡）先出；S-2 纠偏 / S-3 / S-4 三片路径清晰、影响面各自限于一处，均为 **M**，可在无决策依赖下并行；S-1 / S-5 挂起至对应 DT 关闭。
- S-3 与"运行中改模型 → 新 Snapshot Revision"可合成一片（同为"结果与去向 + 快照"链路，避免两次改同一文件），拆分原则仍是最小可独立 UAT。

## 7. 落档影响清单

| 动作 | 位置 | 状态 |
|---|---|---|
| UI/交互架构权威文档 | `docs/design/workflow-ui-interaction-architecture.md` | 已落盘（S-0） |
| 任务卡 | `docs/tasks/FEAT-75-ui-interaction-architecture.md` | 已落盘 |
| 需求分析 / Definition Check / DT-00~03（4 张决策票） | `docs/tasks/specs/FEAT-75-ui-interaction-architecture/` | 已落盘 |
| 登记册新增本卡（status 定义中、remote `GitHub #75`、github_sync `synced#75`） | `docs/tasks/registry.json` | **已写**（revision 115→116；写入前读到并行会话新增的 CHORE-113/FEAT-114/FEAT-115/TMP-* 条目，均原样保留，只追加本卡一条）。⚠️ `deps` 字段留空未设：DT-00 冲突裁定前不把依赖关系写死，且该字段在进入「已定义」时才必填 |
| 看板重写 | `docs/tasks/BOARD.md`（脚本产出，勿手改） | 已用 `node scripts/local-task-registry.mjs board` 重生成 |
| 权威链登记（V-2） | `AGENTS.md` 权威资料节 / `docs/design/workflow-capability-index.md` | **未做**，等基线确认可改规则文件后一并处理 |
| 在 GitHub #75 回填裁定指针 | 远端评论 | **未做**（对外动作，须授权） |
| S-2 / S-4 施工卡（S-3 已归 FEAT-114） | `docs/tasks/` | DT 关闭后另立 |

## 8. Definition Check 结论

9.1 / 9.2 / 9.4 / 9.5 / 9.6 通过；**9.3 未通过**（未决产品事项 = **4**：DT-00 冲突 + DT-01 / DT-02 / DT-03）。按 Definition Check 模板与契约：未决 > 0 **禁止**标「已定义」，也不进「待确认」。

结论：**保持「定义中（待决策，含冲突）」**，优先呈递 DT-00（#75 处置 + 并行会话三条裁定的归属确认）；其后 DT-01～DT-03 与 preset 纠偏 + 卡号两项确认。DT-00 落定后，S-2/S-4 可先行推进基线确认，不必等 DT-01。详见 `definition-check.md`。

## 9. 附带发现（不在本卡范围，登记待办）

1. `docs/tasks/FEAT-208-*.md` 的 `GitHub 同步 | #208` 违反枚举（`pending`/`synced#N`/`not-applicable`）——格式违规，不照抄，建议由 #208 侧会话自行修正。
2. 诊断模板 `closeout` 未声明 `completionPath` → 诊断 Run 的 `completion` 恒 null（`LOC-016` 附带发现 2，属模板/LOC-012 范围），影响 S-4 的 Completion 分组呈现。
3. LOC-015 在 registry 标「已合并」而卡面记录「待人工三态裁决」——按仓库既有口径「已合并 ≠ 已验收」，#75 引用其裁定结论时应以卡面为准。
4. GitHub #75 仅剩 1 条评论，CNB 期第 1–4 轮审查记录未随迁移带回；若日后需要完整推理链，须回 CNB 仓库取。
