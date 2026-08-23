# CONTEXT.md — 领域术语表（workflow-manager）

> 本仓库的共享领域语言：架构评审 / 设计 / 实现会话的权威词汇来源。新增术语在此登记。
> 由 improve-codebase-architecture 会话（候选三收口）懒创建。决策记录见 `wayfinder/MAP.md` 与
> `docs/design/`；本文件只收词汇，不收决策。

## 核心对象

- **蓝图（blueprint）**：`templates/*.json`，工作流唯一事实源——人只改它，生成物禁手改。
- **生成物（artifact）**：`.generated/<id>/` 四件套（script.mjs / vwf-dsl.json / SKILL.md / meta.json），gitignore + 重生成比对保护。
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
  （`FAILED_AT_*` / `FAILED_MAX_ROUNDS` / `TECHNICAL_FAILURE` / `ENDED_NO_*` / `ERROR`），绝不卡死。
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
- **分流折叠**：两路同路径条件分流的节点折叠为脚本内 if（零 LLM）——**双入口统一生效**
  （T-IMP-12 后 vwf 运行层同样折叠；编辑器图仍保留 route 节点展示）。折叠转发源 = when 路径的
  schema 声明节点（候选三修复：原取入边来源导致跳测试环节）。
- **可信度闸门（verifyBranch）**：验证节点开工分支自检 + `verified_branch`/`verified_head` 硬校验。
- **异源（heteroCheck）**：dev↔review 模型绑定必须不同（save/validate 层强制；运行时日志）。
- **人工门禁（manualCheck）**：节点产出后挂起（`AWAITING_HUMAN_<节点id>` + resume 载荷），人工裁决后续跑。
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
  `workflow/end` 清除；AWAITING_HUMAN_* 视为占用；entry 续跑放行并 supersede 旧门禁记录）；
  ③ closeout 串行提示——≥2 活跃 run 时看板警示条（提示非强制）。配套 UI = 门禁卡片队列
  （一次裁决一张，首张「裁决中」其余「排队 #n」）。
- **runTag**：wf_run 启动时自登记的 `{taskId, workflowId, startedAt, active, supersededBy}`。
  `workflow/start` 事件载荷只有 `{id, meta}` 不含 taskId，事件流拿不到的信息只能启动边界自己记；
  平台 workflow 工具直起的 run 无 tag（列表照常展示，不参与互斥）。
- **子代理表格**：看板那张四列表（序号 / 名称 / 阶段 / 结果）——**一行 = 一次真实的子代理调用**
  （非一行一节点），数据来自 `workflow/agent-start|agent-end` 事件，只有 label 与 outcome，
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
- **返回状态机**：脚本终态字符串——`DONE` / `AWAITING_HUMAN_<节点id>` / `FAILED_AT_<节点id>` /
  `FAILED_MAX_ROUNDS` / `TECHNICAL_FAILURE` / `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE` /
  `ERROR`；生成的 SKILL.md runbook 必须逐个覆盖。
- **执行路径（D5 正式化）**：编辑器「获取脚本」→ 粘贴主会话 → 平台 `workflow` 工具执行；
  `wf_run` 仅在引擎可达时条件注册。**推论：脚本返回值只回到主会话，插件进程拿不到**——
  看板只能看到事件流（阶段 / 子代理 / 日志）。
- **`runs`（进程内存 Map）**：`host.js` 里订阅 `workflow/*` 事件积累的运行记录，进程重启即失。
  **运行记录持久化未实现**（#17 关闭说明：改双轨方案后另立）。
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
