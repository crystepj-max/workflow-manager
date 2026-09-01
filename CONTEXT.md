# CONTEXT.md — 领域术语表（workflow-manager）

> 本仓库的共享领域语言：架构评审 / 设计 / 实现会话的权威词汇来源。新增术语在此登记。
> 由 improve-codebase-architecture 会话（候选三收口）懒创建。决策记录见 `wayfinder/MAP.md` 与
> `docs/design/`；本文件只收词汇，不收决策。
>
> **Current / Target：** 上文到「流程与协作层」为止描述 **当前 main 已实现** 的词。文末「v0.1 目标词汇」登记 Target 规格里已出现、但代码尚未替换的词，供 #77 / #87 等决策使用。机器结构保持英文；本表给中文注释，不是把字段改成中文。

## 核心对象

- **蓝图（blueprint）**：`templates/*.json`，工作流唯一事实源——人只改它，生成物禁手改。
- **生成物（artifact）**：`.generated/<id>/` 四件套（`script.mjs` / `vwf-dsl.json` / `SKILL.md` / `meta.json`），gitignore + 重生成比对保护。其中 `SKILL.md` 含 **runbook（操作手册）**：按脚本返回状态告诉主会话下一步怎么做。
- **节点 / 边 / 入口 / $end**：蓝图图结构。边分 success（成功/打回后继续）与 failure（打回/终止）两类。

## 引擎层（框架，与业务无关）

- **翻译员（编译器）**：把蓝图翻译成可执行脚本的模块。**唯一实现 = `compileBlueprint`
  （住在 `scripts/generate.mjs`）**，DSH 与 vwf 双入口共用（候选一 T-IMP-12 统一；
  原 host 侧 `compileDsl` 已删除）。宿主经管道取译文：内置模板读 `.generated/<id>/script.mjs`、
  用户模板读 `~/.dsh/skills/<id>/script.mjs`（磁盘优先，含蓝图全部增强：折叠/闸门/归因/异源日志），
  临时图与编辑器实时查看走 CLI `generate.mjs compile` 兜底（DSL 逆投影回蓝图后编译，
  行为由蓝图内容决定）。磁盘产物有「改蓝图未重生成 → 跑旧产物」的 staleness 特性（与 DSH 入口一致，
  validate 步骤②兜底）。
- **校验器（校验内核）**：唯一规则集 = `scripts/validate-core.cjs`（候选二 T-IMP-13，CJS 单文件）。
  双层：**结构层** `validateStructure`（走通性 / 节点边定义 / 入口唯一 / 环 / 条件与 schema 路径 /
  保留 id / maxRounds ∈ [1,9] 系统上限——框架保证，与业务无关）与**业务规则层** `validateBlueprint`
  （蓝图声明的规则：异源硬规则、verifyBranch 联动、onMaxRounds 枚举、output.files、单标识、
  requireModels 产品收紧选项）。引擎 ESM import；宿主经 fs 读源码、vm 内求值缓存（热路径内存执行）。
  原 `validate-blueprint.mjs` 与宿主 `validateDsl`/`heteroCheck`/拓扑推导/COND_RE 已删除。
  错误统一带坐标键 fieldKey（node:<id>:<field> / edge:<i>:<field> / control:<field> / heteroCheck /
  onMaxRounds）；**前端文案翻译 = 优化任务**（MAP Not yet specified）。
- **布局拓扑（client）**：client 的 `successTopologyOrder`/`deriveEntryCandidates` 服务于画布分层、
  入口徽标与保存前归一——UI 关注点，插件无法 import 共享文件（vm 沙箱），保留为独立实现；
  入口唯一性的**权威判定**在校验内核（保存时宿主 sanitize 依内核拓扑重新归一）。
- **走通性（walkability）**：框架级保证——任何蓝图运行要么走通（DONE），要么以明确终态终止
  （`FAILED_AT_*` / `FAILED_MAX_ROUNDS` / `FAILED_ITEM_CAP` / `FAILED_AGENT_CAP` /
  `TECHNICAL_FAILURE` / `ENDED_NO_*` / `ERROR`），绝不卡死。
  创作期规则：有 successCondition 的节点必须有 failure 边（否则判定失败无出口，运行时只能报
  `ENDED_NO_FAILURE_EDGE` 兜底）。
- **运行时排练厅（runtime harness）**：测试基建——`scripts/test/helpers/runtime-harness.mjs`。
  以预置「演员表」（剧本）驱动生成脚本真实执行，断言**返回体（接口）**而非脚本字符串。
  剧本 = 按出场标签提供台词（可静态可函数）；交作业按 `opts.schema` 八关键字子集验收，
  不合格返回 null（仿真真实引擎的 agent 契约）。
- **对拍**：同一批场景跑双翻译员产物——公共语义断言一致（C1）、已知差异断言存在（C2）；
  C2 差异断言翻转为一致的那天 = 候选一（统一编译器）完工日。
  **已翻转（T-IMP-12 收口）**：对拍套件演化为统一编译器验收套件（runtime-host.test.mjs H1-H6），
  核心断言 = 宿主管道交付译文与引擎产物逐字节一致 + 行为统一（折叠/闸门/归因在双入口同语义）。

## 模板层（业务规则，非框架契约）

- **三要素**：调度节点校验 issue 的 目标/范围/验收标准（内置图纸业务规则）。
- **打回与轮次（round / maxRounds）**：failure 边驱动的重做循环与上限。
- **分流折叠**：恰两路 success 出边、同一路径、`== true` / `== false` 的节点折叠为脚本内 if（零 LLM）——**双入口统一生效**；字符串枚举 `when`（如 confirm/auto）不折叠。
  （T-IMP-12 后 vwf 运行层同样折叠；编辑器图仍保留 route 节点展示）。折叠转发源 = when 路径的
  schema 声明节点（候选三修复：原取入边来源导致跳测试环节）。
- **可信度闸门（verifyBranch）**：验证节点开工分支自检 + `verified_branch`/`verified_head` 硬校验。
- **异源（heteroCheck）**：dev↔review 模型绑定必须不同（save/validate 层强制；运行时日志）。
- **人工门禁（manualCheck）**：节点产出后挂起（`AWAITING_HUMAN_<节点id>` + resume 载荷），人工裁决后续跑。
- **扇出（fanout）**：受限并行子任务节点。`items` 仅从 `$.args` 或 success 路径上的前序
  `$.results.<节点id>` 读取数组；`goal` 用 `{{item}}` 注入当前项，`output.schema` 是 per-item
  schema。编译器以 `pipeline` 执行，按原序聚合为 `{ total, okCount, failedCount, items }`，
  失败项为 `null`，再按 `failOn` 决定出边。看板通过 `<节点label> #<序号>` label 归组，
  不依赖结果回灌。4096 items / 1000 累计 agent 上限在本批 agent 出场前分别返回
  `FAILED_ITEM_CAP` / `FAILED_AGENT_CAP`。
- **业务规则前端可配置（候选二 Q7）**：编辑器工作流控制面板可配置——打回上限（1-9 系统上限钳制）、
  异源开关（heteroCheck）、超限行为（onMaxRounds return/auto-reschedule）；字段经 DSL 双向投影落盘蓝图，
  校验与编译按蓝图内容生效。verifyBranch（节点级闸门）编辑器无 UI，列后续候选。
- **受阻语义（Q12 修正）**：run 级无 BLOCKED；节点结果枚举（test `BLOCKED` / dev `blocked`）仍有效——
  dev 受阻 = `FAILED_AT_dev`（failure 边兜底），test 受阻 = 沿 failure 边打回开发。
- **文件契约（候选五 C5）**：`output.files` 为权威声明；goal 与角色文件中**反引号引用**的交付物文件名
  必须 ⊆ 全局声明 ∪ {STATE.md}（校验内核规则 A + repo 级测试 T8 机器核对，替代人工核对；
  裸提及如 `package.json` 不检查避免误报）。

## 插件界面层（编辑器与运行看板）

- **工作流面板**：DSH 设置页注入的 `settings.section`（`client.js` 末尾 `slots.inject`），内含两个页签。
- **模板库（templates 页签）**：工作流清单（一行一个模板，内置标 builtin 且只读），操作 = 新建 / 编辑 / 删除。
- **运行看板（dashboard 页签）**：每 3 秒轮询 `vwf.runs.list` + `vwf.state`，呈现**运行列表**（可点选切换）、
  当前 run 的状态/阶段、只读画布（节点按状态染色，按 workflowId 匹配模板 DSL）、**子代理表格**与
  最近 20 条日志。**与模板库无关**（两者常被混指）。
- **三约束（多 run 并行，#19）**：① 并行隔离——数据按 runId 天然分账，看板列表互不串扰；
  ② **同 taskId 互斥**——wf_run 启动边界拒绝（runTag 登记 taskId，`active` 镜像不依赖事件到达时机，
  `workflow/end` 清除；`WAITING_HUMAN` 与 `AWAITING_HUMAN_*` 均视为占用；`WAITING_HUMAN` 仅匹配的 `decision_id` 续跑放行，残留 `AWAITING_HUMAN_*` 仍靠 entry 续跑放行，并 supersede 旧等待记录）；
  ③ closeout 串行提示——≥2 活跃 run 时看板警示条（提示非强制）。配套 UI = 门禁卡片队列
  （一次裁决一张，首张「裁决中」其余「排队 #n」）。
- **runTag**：wf_run 启动时自登记的 `{taskId, workflowId, startedAt, active, supersededBy}`。
  `workflow/start` 事件载荷只有 `{id, meta}` 不含 taskId，事件流拿不到的信息只能启动边界自己记；
  平台 workflow 工具直起的 run 无 tag（列表照常展示，不参与互斥）。
- **子代理表格**：看板那张四列表（序号 / 名称 / 阶段 / 结果）——**一行 = 一次真实的子代理调用**
  （非一行一节点），数据来自 `workflow/agent-start|agent-end` 事件，只有 label（显示名）与
  outcome（此处 = 子代理调用是否完成/失败/进行中，**不是**节点业务结果），
  **不含子代理返回的内容**。
- **编辑器抽屉 / 画布 / 节点卡片 / Inspector**：点「编辑」滑出的大面板 = 抽屉；抽屉内左侧可拖拽连线的
  流程图 = 画布，图上的方块 = 节点卡片（副标题印节点类型）；右侧字段表单 = Inspector（配置面板）。
- **往返无损（round-trip）**：蓝图 → DSL 投影 → 编辑器修改 → 保存回蓝图，字段不得丢失。
  新增蓝图字段必须同步 `projectToVwf` 与逆投影，否则「保存一次即消失」。
- **runId**：一次运行的标识，看板据此定位记录。
- **per-item**：逐项的、每项各一份（见下「扇出」）。

## 引擎运行时层（平台 workflow 工具）

- **workflow 工具 / 引擎**：DSH 平台自带工具与其背后的执行器（并发、计数、取消、事件广播）。
- **vm**：脚本执行的隔离容器——无文件系统 / 网络 / Node API，**只有冻结的钩子全局**。
- **钩子五件套**：`agent`（起一个子代理）/ `parallel`（并发一批）/ `pipeline`（每项独立过流水线）/
  `phase`（报告阶段）/ `log`（日志），外加只读入参 `args`。
- **子代理（subagent）**：被派去干一件具体活的 AI 实例。一个节点跑一次 = 一次 `agent()` 调用；
  **失败时 `agent()` resolve `null`**（不抛错）——`null` 是「该项失败」的唯一信号。
- **label**：起子代理时给的显示名，看板表格第二列即它；也是看板归组的唯一线索。
- **ITEM_CAP / AGENT_CAP**：引擎上限 `maxItemsPerCall`（默认 4096，单次 parallel/pipeline 项数）与
  `maxTotalAgents`（默认 1000，单 run 子代理总数）。
- **cap 前置断言**：在真正起子代理**之前**自检数量并给出可读错误，而非跑到一半被引擎掐断。
- **返回状态机（engine status，引擎返回状态）**：脚本终态字符串——`DONE`（完成）/ `WAITING_HUMAN`（Human Decision 等待，node/reason/Package 为独立字段）/ `STOPPED`（控制类 STOP）/ `AWAITING_HUMAN_<节点id>`（残留人工门禁）/ `FAILED_AT_<节点id>`（停在该节点）/
  `FAILED_MAX_ROUNDS`（超过打回上限）/ `TECHNICAL_FAILURE`（技术执行失败）/ `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE` /
  `ERROR`；生成的 `SKILL.md` **runbook（操作手册）** 必须逐个覆盖。这是底层引擎一次执行的返回值，不是 Target 的 Run Lifecycle（运行生命周期）。
- **rejected_choice**：业务 Decision Result 无匹配 `$human-decision` 出边时，引擎返回体上的被拒选项；`status` 仍为 `WAITING_HUMAN`，`decision_id` 不变，请求事件 `user_choice` 保持 null。
- **执行路径（D5 正式化）**：编辑器「获取脚本」→ 粘贴主会话 → 平台 `workflow` 工具执行；
  `wf_run` 仅在引擎可达时条件注册。**推论：脚本返回值只回到主会话，插件进程拿不到**——
  看板只能看到事件流（阶段 / 子代理 / 日志）。
- **`runs`**：`host.js` 里订阅 `workflow/*` 事件积累的运行记录。内存 Map + 落盘
  `~/.dsh/visual-workflow/runs/<runId>.json`（#40 起持久化）：事件驱动合并写（每 run 至多一个
  飞行中写入、尾写补最新态）、启动回载最近 20 条、磁盘容量上限 50 淘汰最旧（子进程 rm）、
  `vwf.state` 内存 miss 回落磁盘并水合；落盘内容以事件流为界（状态/阶段/日志/子代理
  label+outcome + runTag 元数据 taskId/workflowId/supersededBy），落盘失败仅终端留痕。
- **回灌（未实现）**：让主会话把脚本最终返回值送回插件的假想通道；无此通道即无法在看板展示结果正文。

## 扇出（fanout · 规划中 #18，语义已拍板未实现）

- **扇出（fan-out）**：一个节点按运行时数组展开为 N 个并行子任务，聚合结果后交给下游；
  与「AI 自由拆解」相对（D1 选方案 B 受限并行，方案 C 保留扩展位）。
- **item / per-item**：待处理数组里的一项 / 逐项各一份。
- **items 表达式**：声明「去哪里取那个数组」的字符串，限两种前缀——
  `$.results.<节点id>[.路径]`（取拓扑在前节点的结果字段）与 `$.args[.路径]`（取 run 入参）。
- **item 目标模板**：复用节点 `goal`，内含 `{{item}}` 占位；每个子任务把占位替换为自己那一项。
- **结果包装**：fanout 节点结果 = `{ total, okCount, failedCount, items: [...] }`
  （`items[i] === null` 表该项失败）。**不是裸数组**——裸数组会让下游 `when` /
  `successCondition` 的对象路径求值无从表达。
- **失败阈值（failOn）**：`any`（一项失败即打回）/ `all`（全部失败才打回，默认）/
  非负整数 N（失败数 > N 即打回）。

## 流程与协作层

- **三要素（需求侧）**：任务目标 / 涉及范围 / 验收标准——issue 可执行的最低门槛
  （与「三要素（模板层）」同源：调度节点校验的正是这三项）。
- **size S / M / L**：体量判定。S 单会话可完成；M 路径清楚但需拆多个有依赖顺序的任务；
  L 路径不清楚，必须先拆决策工单再动工。
- **垂直切片工单**：每张工单切一条窄而完整的纵向路径（契约→实现→测试，单张可验证），
  而非「先改完所有校验、再改完所有编译」的水平切片。
- **决策地图（wayfinder）**：把「必须先决断的问题」逐张立票、逐张关闭的机制，索引 = `wayfinder/MAP.md`。
- **OpenSpec 提案**：决策全部落定后综合成的实施提案（如 `specs/vwf-p2/proposal.md`）。
- **issue 标签**：状态 `needs-triage` / `needs-info`（有待决断项）/ `ready-for-agent`（规格完整可施工）；
  体量 `sized-s|m|l`；开发模式 `generic-agent`（仓库内纯代码，Node 测试可验证）与
  `dsh-cordis`（必须在 DSH 会话对着插件运行时开发）。
- **storageDomain（历史方案）**：DSH 宿主持久化域；P2-D3 原定用它存模板与运行记录，
  T2（#17）改双轨方案（宿主目录文件 + save 即生成 skill）后不再依赖。

## v0.1 目标词汇（尚未进入 main）

> 原则：机器字段/枚举保持英文；本表只给中文注释。此处**不是**当前运行时行为。
> 决策记录见 #87 与 `.scratch/business-outcome-routing/`。`$human-decision`、`ROUTE_HALTED` 已由 #87 采纳为 Target 词汇。

### 易混对照

| 英文 | 中文 | 不要当成 |
|---|---|---|
| Business Outcome / Node Business Outcome | 节点业务结果（专业判断，如 `PASS`） | 子代理事件里的 outcome（完成/失败/进行中） |
| Decision Result | 决策结果（用户结构化选择，如 `USER_ACCEPTED`） | 节点业务结果；也不是旧的 `approved`（批准布尔） |
| Completion Type | 完成类型（`COMPLETED` 的业务原因） | Run Lifecycle（运行生命周期）或节点业务结果 |
| Human Decision | 人工决策（框架能力：系统不能代选时请人拍板） | Human Acceptance（人工验收，业务阶段）；也不是 manualCheck（人工门禁，旧二态审批） |
| engine status | 引擎返回状态（一次脚本 `start()` 的字符串，如 `DONE`） | Run Lifecycle（用户级一次任务的状态） |
| `APPROVE` | 审核业务结果「批准」 | `approved`（旧续跑载荷里的真/假） |
| `maxRounds`（Current） | 打回上限（failure 边 `round++`） | `maxRounds`（Target）= 自动回退额度 |

### 三层结果

- **Run Lifecycle（运行生命周期）**：整个 Logical Run（逻辑运行，用户意义上的一次任务）的状态。框架固定：`READY`（就绪）/ `RUNNING`（运行中）/ `WAITING_HUMAN`（等待人工）/ `PAUSED`（已暂停）/ `BLOCKED`（受阻，可恢复的外部条件）/ `COMPLETED`（已完成）/ `STOPPED`（已停止）/ `FAILED`（失败，不可安全恢复）。仅后三者为终态。由 #79 承接。
- **Logical Run（逻辑运行）**：用户从开始到结束的一次完整任务。不等于底层引擎一次 `start()`。
- **Execution Segment（执行片段）**：底层引擎的一次执行；一次逻辑运行可含多段。
- **Node Business Outcome（节点业务结果，常简称 Outcome）**：节点自己的专业判断，也是路由依据。字段名不得写死为 `outcome`；路径可配置（如 `$.outcome` / `$.decision`）。
- **Completion Type（完成类型）**：说明一次 `COMPLETED` 以什么业务原因结束。权威源是终态节点结构化结果；Run 层只镜像摘要。
- **Run Summary（运行摘要）**：逻辑运行上供搜索/筛选/看板用的 Completion 镜像，不是权威源。
- **results[node]（节点结果槽）**：脚本返回体里该节点的结构化输出；Target 下这是业务结果的权威事实。

### 路由与蓝图

- **Business Outcome Routing（业务结果路由）**：Blueprint（蓝图）把节点业务结果映射到下一跳。节点不输出 `next_node`（下一节点）。由 #77 承接。
- **Completion Mapping（完成类型映射）**：把走进 `$end` 的那个节点上的 `output.completionPath` 映射为完成类型（#92）。
- **producer（生产者）**：哪个节点/能力产出该业务结果。
- **field path（字段路径）**：从结构化输出里读业务结果的路径。新模式写在节点 `output.outcomePath`（#88），如 `"$.verdict"`。
- **outcomePath（业务结果字段路径）**：新模式节点级字段（#88）。有则走业务边 `outcome` + 可选技术边 `on: "technical"`；无则走旧 `success/failure`。
- **completionPath（完成类型字段路径）**：节点级可选字段（#92）。语法与 `outcomePath` 相同，允许二者相等。声明则必须有 schema、路径在内、叶子为 `string`；该节点必须有结构边到 `$end`。仅 `DONE` 时读 `results[node]`，写入 `completion: { type, node, path } | null`。
- **outcome（边上的业务结果取值）**：新模式业务边字段，与 `outcomePath` 指向的值等值匹配。与 `on` 互斥。
- **on: technical（技术边）**：新模式技术失败通道（#88），每节点最多一条；没有则 `TECHNICAL_FAILURE`。
- **ENDED_NO_OUTCOME_EDGE（无匹配业务结果边）**：新模式运行时未命中任何业务边且非技术失败；不改写 `results[node]`（#88）。
- **结构边（structural edge）**：参与入口判定与可达性的边 = 旧 `on: success` ∪ 新业务 `outcome` 边（#90）。`failure` / `technical` 不是结构边。
- **SCC（Strongly Connected Component，强连通分量）**：有向图里「互相到得了」的一坨节点。A 能走到 B 且 B 能走回 A，则同属一个 SCC。无自环的单节点自己也是一个（平凡）SCC。自环（self-loop）是大小为 1 但有环的 SCC。
- **出口（SCC exit）**：离开某个 SCC 的结构边，目标是 SCC 外的节点、`$end` 或 `$human-decision`。#90：新模式允许 `outcome` 环，当且仅当每个非平凡业务 SCC 至少有一条出口。
- **入边（incoming edge）**：指向某节点的结构边。有入边则该节点不是入口。`failure` / `technical` 入边不计入。
- **悬空（dangling）**：规格或 schema 里出现了某 Outcome，但没有生产者、字段路径或路由（#77 / #91）。
- **route（路由）**：某枚举值对应的下一跳（前向节点 / 回退节点 / 人工决策 / 结束）。
- **Schema / Blueprint Schema（蓝图结构契约）**：蓝图 JSON 允许哪些字段、如何校验。
- **Schema hook（契约挂钩）**：只落字段与校验，运行时行为由邻 issue 实现。
- **reserved id（保留标识）**：拓扑里留给框架的 id：`$end`（结束）、`$entry`（入口）、`$new-round`（新一轮）、`$human-decision`（人工决策保留目标，#87）。
- **`$end`（结束）**：边的合法终点，表示工作流结束。
- **`$human-decision`（人工决策保留目标）**：与 `$end` 同类的框架点，不是 Role、无 LLM。入边 = 触发停机的业务结果；出边 = 决策结果路由（#77 校验接受，运行时不走）。#87。
- **kind（节点种类）**：如 `worker`（工人节点）/ `fanout`（扇出）。人工决策不是一种 kind（#87 否决 Q4-B）。
- **profile（角色档案）**：节点绑定的能力角色。人工决策按原则不是通用角色。
- **Outcome Preset（业务结果预设）**：可选的推荐枚举+路径，机器可读 JSON（#91：`docs/design/outcome-presets.json`）。校验不强制选用；#75 做选择器。不扫描 goal / 角色文案。
- **可穷举（enumerable）**：新模式 `outcomePath` 指向的 schema 必须是 `enum` / `const` / `oneOf` 常量，或 `boolean`（视为 `{true, false}`）。自由字符串无法证明不悬空（#91）。
- **expand–contract（扩缩兼容）**：新旧形态并存，旧蓝图零迁移仍可跑。

### 人工决策

- **Human Decision（人工决策）**：框架能力。系统不能代替用户做的取舍、风险接受、最终签字、额度耗尽。由 #72 承接。
- **Human Acceptance（人工验收）**：业务阶段（人最终签字），不是每个模板都有的框架默认节点。
- **Decision Result（决策结果）**：用户结构化选择，例如 `USER_ACCEPTED`（用户接受当前结果）/ `ADD_BUDGET`（追加额度）/ `STOP`（停止）。经业务结果路由决定后续流向。
- **Decision Package（决策材料包）**：展示给用户的上下文、选项、成本/收益/风险、推荐。
- **Decision Record（决策记录）**：用户选择的不可覆盖正式记录。
- **manualCheck（人工门禁）**：Current 的二态审批：产出后挂起，续跑靠 `approved`（批准布尔）。
- **approved（批准）**：旧续跑载荷里的真/假。不是审核业务结果 `APPROVE`，也不是决策结果。
- **resume（续跑载荷）**：挂起后再启动同一段执行时带上的参数。
- **最小停机**：命中人工决策路由时停止自动流转并保留节点业务结果，但不实现决策材料包/多选项/决策记录。

### 额度与停机

- **countRound（本边是否计数）**：该业务回退边是否消耗自动回退额度。#73 已落地：`true` 消耗，`false`/缺省不消耗但仍记 `history`。
- **maxRounds（自动回退额度）**：允许自动跨节点回上游再产出的次数；初次执行不计。旧蓝图仍把该字段当 failure 边打回上限。
- **MAX_ROUNDS_REACHED（额度耗尽）**：Lifecycle（运行生命周期）上 `WAITING_HUMAN` 的 reason（原因码）。不是 `FAILED_MAX_ROUNDS`。
- **FAILED_MAX_ROUNDS（超过打回上限）**：Current 引擎返回状态；旧蓝图过渡期仍用。
- **WAITING_HUMAN（等待人工）**：Run Lifecycle 值。进入条件包括人工决策与额度耗尽。由 #79/#72 承接，#77 不宣称自己实现了该生命周期。
- **ROUTE_HALTED（路由停机）**：#77 引擎段返回状态（#87）。表示蓝图要求不要自动走下一步。payload 含 `reason`、`node`、原样 `results`。不是运行生命周期。命中 `$human-decision` 时 `reason=HUMAN_DECISION`。#77 不因额度耗尽发此状态。
- **reason（原因码）**：停机/等待的结构化原因，如 `HUMAN_DECISION`（人工决策）或 `MAX_ROUNDS_REACHED`（额度耗尽）。
- **payload（返回体载荷）**：引擎返回状态附带的数据对象。
- **过渡预算闸门**：#77 只做 `countRound` 校验与往返无损；#73 落地真闸门：`countRound=true` 消耗额度，耗尽 `WAITING_HUMAN` + `MAX_ROUNDS_REACHED`，`ADD_BUDGET` 必须显式入账。

### 常用业务结果 / 完成类型枚举（机器英文）

- **PASS（通过）**
- **OPTIMIZE（需优化，回执行）**
- **CONFIRM（需确认，升人工决策）**
- **NEEDS_RESEARCH（需补充研究）**
- **INSUFFICIENT（证据不足；可为合法完成类型）**
- **RECONFIRM_REQUIRED（需重新确认基线；由执行节点产生，不是评估节点裁决）**
- **REQUEST_CHANGES（请求修改）**
- **APPROVE（审核通过，业务结果）**
- **USER_ACCEPTED（用户接受当前结果，决策结果/完成类型来源）**
- **EVALUATION_PASSED（评估通过，完成类型）**

### #87 已锁定（交付边界）

- #77 交付：蓝图契约 + 保留目标 `$human-decision` + 命中入边时 `ROUTE_HALTED`（`reason=HUMAN_DECISION`）+ 不改写节点业务结果 + 脚本返回体解析完成类型摘要 + `countRound` 落盘但不计数。
- #72 交付：决策材料包、多选项、决策记录、恢复后走 `$human-decision` 出边、把 `ROUTE_HALTED` 映射为 `WAITING_HUMAN`。
- #73 交付：额度会计与耗尽产品语义；#77 不做过渡预算闸门。
- #79 交付：逻辑运行、运行生命周期、把完成类型摘要持久化到运行摘要；不把新语义写入当前 `runs` 事件流。
- 旧 `manualCheck` / `FAILED_MAX_ROUNDS` / `AWAITING_HUMAN_<id>` 对未迁移蓝图保持兼容。
- #77 不发 `WAITING_HUMAN`，也不把 `MAX_ROUNDS_REACHED` 写成引擎状态。

### #88 已锁定（蓝图编码）

- 双模式：无 `outcomePath` 的节点保持现行 `successCondition` / `on` / `when`。
- 新模式：`output.outcomePath` + 业务边 `{ outcome, countRound? }` + 可选 `{ on: "technical" }`。
- 新模式禁止 `when`、`successCondition`、`on: success|failure`。
- `$human-decision` 可作 `from`/`to`；其出边只能是业务边。
- 缺匹配业务边 → `ENDED_NO_OUTCOME_EDGE`，不改写节点结果。
- fanout 禁止 `outcomePath`（#89）。

### #90 已锁定（走通性）

- 结构边 = success ∪ `outcome`；`$human-decision` 出边计入可达，运行时仍停机。
- 旧模式继续禁止 success 环。新模式允许有出口的业务 SCC；无出口环拒绝。
- `technical` 自环合法，不并入业务 SCC。走通性不看 `countRound`。有环 E2E 联合 #73/#82。

### #91 已锁定（完整性与 Preset）

- 新模式：枚举值与 `outcome` 出边一一对应；无 enum 的自由字符串拒绝。
- `$human-decision`：有入边才要求 ≥1 条出边；决策结果封闭枚举归 #72。
- Preset 为可选 JSON 目录；不扫文案。

### #92 已锁定（Completion Mapping）

- 节点级可选 `output.completionPath`（含旧模式）；必须有结构边到 `$end`。fanout 禁止（#89）。
- 仅 `DONE` 上 `completion: { type, node, path } | null`；缺值不改写节点结果。停机/失败不加该字段。
- 摘要只派生，节点赢。#79 原样抄到 Run Summary。`$human-decision` → `$end` 归 #72。

### #89 已锁定（Fanout）

- fanout 不参与 Business Outcome Routing / Completion Mapping。
- 禁止 `outcomePath`、`completionPath`、`outcome` 边、`on: technical`。
- `failOn` 仍走旧 failure（技术聚合失败）。探索业务结果写在 Evaluator。

