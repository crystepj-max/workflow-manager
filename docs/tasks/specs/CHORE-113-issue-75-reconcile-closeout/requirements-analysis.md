# GitHub #75 需求分析（收口轮）

| 项 | 值 |
|---|---|
| 需求源 | GitHub issue `crystepj-max/workflow-manager#75` |
| 标题 | design: 工作流插件整体 UI/交互架构重构——模板库、编辑器、Skill 调用与 Run 看板统一设计 |
| 开票时间 | 2026-08-29 |
| 分析时间 | 2026-09-19 |
| 轨道 | **本地轨道**（交付流程只读本地任务卡 + 已入库规格 + 登记册；GitHub issue 不是开工载具） |
| 定义主源 | **`FEAT-75` 伞卡 + `docs/design/workflow-ui-interaction-architecture.md` 定稿**（产品 2026-09-19 裁定，见 §6） |
| 本会话产出 | `CHORE-113`（权威引用回写与关票材料）、`FEAT-114`（= 定稿 S-3）、`FEAT-115`（**已取消**） |

## 1. 结论

#75 不是一张「待建的大设计票」，而是 **v0.1 目标期的伞票，从来没有跟已上线内容对过账**。

实际 UI 走了另一条路线做完：CNB 发号的 `LOC-*` / `FEAT-*` / `FIX-*` 任务链 + Codex 原型 handoff（`docs/tasks/handoffs/H1~H3`）+ 产品逐条给出的真机验收差距批次。14 项完成标准里 **11 项已有主**，2 项无人认领，1 项前提本身待裁定。

本轮另有一个并行会话在同一天完成了 #75 的架构定稿（`FEAT-75` + 定稿文档），产品裁定以它为主源；本会话的定义已按该裁定收敛，详见 §6。

## 2. 14 项逐条判定

「已核实」= 本轮在当前 main 工作区直接读取代码或登记册确认，非引用文档宣称。

| # | #75 完成标准 | 判定 | 归属 / 证据 |
|---|---|---|---|
| 1 | 模板库 Built-in/Custom 信息架构 | 已实现（已合并） | 流程库「全部/内置/我的」子页签 `client.js:4769`、`:5168` |
| 2 | Skill/Chat/插件正式 Invocation 关系 | 已由既有任务覆盖；**是否新增插件运行入口 = 未决** → 本轮裁 A | `LOC-015`（等待验收）；实测 `client.js` 无「立即执行」等任何运行入口，`wf_run` 在 `host.js:3075` |
| 3 | Built-in Model Override UI | 已实现 | 覆盖对话框与还原二次确认 `client.js:5196`、`:5260`；归 `LOC-014`（等待验收） |
| 4 | 自定义 Workflow 渐进式编辑结构 | 部分：现状三段 | 配置栏三段 tab `client.js:360`、渐进披露 `:1460`。定稿 §4.2 已裁**三层为定稿**，完成映射归入结果层 |
| 5 | Outcome Preset + 自定义 Outcome | 部分：面板只认单层字段名，且无选择器 | 编辑器 `routingNameOf` 限单层 `client.js:5552`；校验内核允许多层 `validate-core.cjs:123`。多层保真 → **`FEAT-114`**；Preset 纠偏与选择器 → 定稿 **S-2** |
| 6 | Completion Mapping | **未实现**（编辑侧） | `client.js` 内 `completionPath` 出现 0 次（全文计数核实）；四套模板靠手写 `output.completionPath`（如 `templates/wf-diagnose.json` closeout）→ **`FEAT-114`**（= S-3） |
| 7 | Preflight / Snapshot Model 修改 | 大部分已实现 | 实时静态校验 `client.js:2672`、`vwf.probe` `:4974`、修订只读表 `:4676`；「受阻卡内改模型不能提交」属 `LOC-016`/`FEAT-208` |
| 8 | Logical Run Dashboard | 部分：八项约 3.5 项有 | 多段折叠 `client.js:3363`。缺 当前节点 / 上个节点结果 / 回退额度 used·limit / 当前快照修订 / 最近事件 → 产品裁定归 **#75 切片 S-4 另立卡**（本会话早前记为「归 LOC-016」，已更正） |
| 9 | Run Detail 流程 / Timeline / 成果证据 | 已实现（形态为结果/检查/活动页签）；**无真正 Timeline 事件流** | `client.js:4236` 三页签 + `chainEntries` 按模板节点序（`:3977`，非时间序）。Timeline 归 `LOC-016` V2 片1，定稿 §4.3 已确认 |
| 10 | PAUSED / Guidance | 部分，已有主 | 暂停原因与多轮指导 `client.js:4463`、经 `vwf.run.control` 生效 `:4083`；「一键恢复」缺，归 `LOC-016` |
| 11 | WAITING_HUMAN / Human Decision | 部分，已有主 | 决策卡材料齐 `client.js:4509`；提交按钮硬禁用 `:4581` → 归 `FEAT-208`（待派工） |
| 12 | BLOCKED / 模型替换 / Probe / Resume | 部分，已有主 | 逐节点双列下拉与修订保留说明 `client.js:4591`；提交闭环归 `LOC-016` + `FEAT-208` |
| 13 | COMPLETED / STOPPED / FAILED / Observing | 终态已实现；**Observing 本轮已裁退出 v0.1** | 全仓无 `COMPLETED_OBSERVING` 生产者；`workflow-design-principles.md:226` 明示它不是 Lifecycle |
| 14 | #54–#57 保留/合并/supersede 决策 | 无需再判 | 四张 GitHub 票 `stateReason` 均为 `COMPLETED`（2026-08-26T04:46Z，0 评论）；裁定表已由定稿 §7 入库 |

## 3. 口径冲突与本轮新发现

### 3.1 #75 §1 的探索硬用例已被取代（定稿已记录）

`LOC-036`（用户 2026-09-16 确认，`docs/tasks/specs/LOC-036-exploration-coverage/task-spec-V1.md:117`）把「补充额度耗尽」改为：保留原 `NEEDS_RESEARCH` 裁决、有效终态记 `INSUFFICIENT` 直接结束，**不再转人工**。代码事实：`scripts/generate.mjs:840-846` 的探索专属分支先于 `:855` 的通用 `haltWaitingHuman(..., 'MAX_ROUNDS_REACHED')`，且 `scripts/validate-core.cjs:642` 限定只有 `wf-explore` 可声明。分层铁律本身不变，示例须换到未被取代的三套模板。定稿 §2 已记此事，本会话不再重复回写。

### 3.2 本轮独有发现：多层结果字段路径被静默覆盖（缺陷，非增强）

- 校验内核接受多层：`validate-core.cjs:123` 的 `JSON_PATH_RE = /^\$\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/`（错误文案「需为 $.field 形式」是过期的）；宿主 `host.js` 的 `readOutcomePath` 按 `.` 逐层取值。
- 编辑器面板只认单层：`client.js:5552` `routingNameOf` 用 `^\$\.([A-Za-z_][A-Za-z0-9_]*)$`，多层返回 `''`。
- 后果：`routingName=''` → `routingProp=undefined` → 面板把已存在的手写多层路径显示成「未配置」；此时在该面板任何编辑动作都走 `applyRoutingWrite`（`client.js:5600-5618`），第 5614 行把 `outcomePath` 整体改写为 `routingPathOf(name)`（单层），且 `:5605` 的 `prev` 取值为空导致 schema 里旧属性不被清理 → **路径静默丢失 + 孤儿属性残留**。

定稿的 R-2 / S-2 只覆盖「Preset 内容与模板不符」，未覆盖此条，故并入 `FEAT-114` 验收。

### 3.3 Preset 数据本身是错的

`docs/design/outcome-presets.json` 三条 preset 的 `outcomePath` 全为 `$.verdict`，而正式模板实际使用 `$.route`（17 处）/ `$.status`（3 处），`$.verdict` 仅出现在 `templates/wf-explore.json`。照文件接选择器会给用户错默认值 → 必须先纠偏（定稿 S-2）。

## 4. 本轮人工裁定（2026-09-19 会话）

| 裁定主题 | 选择 |
|---|---|
| #75 本身怎么处置 | 降为需求源、关票，只拆残余 |
| 自建工作流配不了完成映射算不算 v0.1 发布门槛 | 不算门槛，排发布后第一批 |
| 编辑器三块残余的先后 | 先补能力，再重排结构（**后被下一项取代**） |
| 「已完成·观察中」在 v0.1 | 明确不做，列为非目标 |
| #75 定义主源给谁 | **`FEAT-75` 伞卡与定稿**（本会话不重复制定义） |
| 三段还是四段 | **三层为定稿**，完成映射归入「结果与去向」层 → `FEAT-115` 取消 |
| 插件运行入口（定稿 DT-01） | **A：Skill / Chat 仍是唯一正式入口** |
| 看板缺的五项归谁 | 归 #75 切片 **S-4，另立卡**（不归 `LOC-016`） |

## 5. 体量判定

- #75 按原始描述属 L，但其路径已由既有交付走通，不存在「先拆决策地图」的前提；本轮**不产出 OpenSpec 与决策地图**。
- 可施工残余切成：`FEAT-114`（= S-3，M）、定稿 S-2（Preset 纠偏/选择器）、定稿 S-4（看板五项字段，产品已裁另立卡）、`CHORE-113`（S，文档回写）。
- 共同硬约束：插件载荷余量约 1.6 KB（闸门 290816 B / 现值 289230 B），且 `CHORE-104` 的 −14028 B 瘦身尚未并入 main。任何新增 UI 切片都受这条制约。

## 6. 与并行会话的撞车与收敛

本轮分析进行中，同一检出（多会话共用）出现另一会话今天产出的 #75 定义：`docs/tasks/FEAT-75-ui-interaction-architecture.md`（伞卡，状态「定义中·未决 3 项」）+ `docs/design/workflow-ui-interaction-architecture.md`（172 行定稿，含 P1–P10、R-1…R-9 缺口台账、S-0…S-5 切片、DT-01…03 决策票）。两者均**未被 Git 跟踪、也不在登记册里**；其 `docs/tasks/specs/FEAT-75-ui-interaction-architecture/` 目录尚未写出。

处理：产品裁定以该伞卡为 **#75 定义主源**。本会话据此收敛——

| 本会话原产物 | 收敛后 |
|---|---|
| `CHORE-113`「14 项对账表 + 取代记录」 | 删除重复部分，收缩为「六处权威引用回写 + 目标规格状态标注 + 关票材料」（主源明确不做的三项）；前置依赖改为 `FEAT-75` |
| `FEAT-114` | 保留，标记为主源切片 **S-3** 的施工卡，并并入本会话独有的多层路径保真发现 |
| `FEAT-115`（三段→四段重排） | **取消**（三层为定稿），`cnb#115` 关闭为 not planned |
| 看板五项归属 `LOC-016` | 更正为归 #75 切片 **S-4**（另立卡），由主源侧派工 |
| S-2 / S-4 立卡 | 不抢：交主源会话按其 V-9 执行 |

遗留给主源或产品的两件事（本会话不代做）：

1. `FEAT-75` 卡号与既有 `CHORE-75`（`cnb#75 + github#214`）数字重叠，且其卡未进登记册 —— 属 `CHORE-111` 号段冲突的具体实例，需产品裁定改名或补登记。
2. 定稿 §3 仍写「是否新增插件运行入口是唯一悬而未决的产品选择」，需按 DT-01=A 收口。

## 7. 本轮自纠记录

调研由并行子代理提供初稿，其中**三条断言经一手复核判伪并已剔除**，记录以防回灌：

| 断言 | 复核结果 |
|---|---|
| 「探索模板里有 `TODO(#82/#77)` 未接线注释，业务路由靠通用兜底」 | **不成立**。JSON 不允许注释；`templates/wf-explore.json` 的 `evaluate → orchestrate` 带 `outcome: NEEDS_RESEARCH` + `countRound: true`，`control.maxRounds: 2`，路由完整 |
| 「#75 §4 要求的 `RECONFIRM_REQUIRED → 目标确认` 且 `countRound=false` 未落地」 | **不成立**。`templates/wf-optimize.json` 已有该边，逐字符合要求 |
| 「三处 stale 指向：`CONTEXT.md:115`、`client.js:1379`、`capability-index:256`」 | **不成立**。全仓搜索后真实引用是目标规格三处 + `blueprint-schema.md:145` + `CONTEXT.md:254` + 并行开发计划 11 处，已按实测重写 `CHORE-113` 范围 |
| 「插件已有『立即执行』运行入口」（本会话曾据此转述） | **不成立**。`client.js` 搜不到该文案，模板行只有查看流程 / 模型设置 / 编辑 / 删除；据此才暴露 DT-01 是真未决项 |
