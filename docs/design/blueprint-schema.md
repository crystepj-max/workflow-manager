# 蓝图 JSON Schema（v1 定稿）

> 工作流统一引擎「单一事实源」契约。本文档是 FR-7（v2 对话式创作）的 AI 编写契约（规格风险 2）。
> 决策来源：T-01（wayfinder 地图），D1–D6 于 2026-08-19 评审定稿；原型评审台与冒烟断言见 `.scratch/schema-prototype/`（一次性）。
> 配套事实：`docs/research/mjs-semantics.md`、`docs/research/vwf-host-internals.md`、`docs/research/workflow-tool-contract.md`。

## 1. 目标

- 每份工作流 = 一份蓝图 JSON，存放于仓库 `templates/`（FR-1）。
- 生成器从蓝图产出双入口：vwf 注册（目录加载，废除 `host.js:29-74` 硬编码）与 DSH skill 包装（FR-2）。
- 人工只编辑蓝图（NFR-1）；生成物 gitignore、改动即重建。

## 2. 字段全集

### 2.1 顶层

| 字段 | 必填 | 类型/取值 | 说明 |
|---|---|---|---|
| `id` | ✅ | 字符串，kebab-case（小写英文+连字符） | **唯一标识 = 模板 id = name**（D1 单标识）；生成 skill 名与 vwf 模板 id 均由此派生 |
| `displayName` | ✅ | 非空字符串 | 中文展示名，如「开发工作流 2.0」；生成 skill 的触发词之一（FR-6） |
| `description` | 可选 | 字符串 | 一句话概述，进 vwf 模板 description |
| `entry` | ✅ | 节点 id | 首次运行入口；**必须等于拓扑推导的唯一入口**（与 validateDsl 严格一致） |
| `control.maxRounds` | 可选 | 正整数，默认 9 | 打回上限；**系统约定上限 9（候选二 Q7：编辑器与校验器强制 1-9，超限拒绝）** |
| `onMaxRounds` | 可选 | `'return'`（默认）\| `'auto-reschedule'` | DSH 增强：超限自动回调度做失败归因（D4）；**v1.1（候选二 Q7）起进 vwf DSL、编辑器可配置** |
| `heteroCheck` | 可选 | 布尔，默认 false | DSH 增强：注入 dev↔review 异源运行日志（T-06 定稿后：v2 起异源由 save/validate 全局强制，本字段退化为运行时日志开关）；置 true 时须存在 dev 与 review 节点；**v1.1（候选二 Q7）起进 vwf DSL、编辑器可配置** |
| `bindings.models` | 可选 | 对象：`{ <nodeId>: {provider?, model?} }` | 模型绑定（D2 节点粒度）；键必须都是节点 id；缺省 = 宿主默认 |
| `nodes` | ✅ | 数组，≥1 | 见 2.2 |
| `edges` | ✅ | 数组 | 见 2.3 |

### 2.2 节点

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一；不得使用保留 id `$end`/`$entry`/`$new-round`；必须有出边 |
| `label` | 可选 | 展示名（缺省 = id） |
| `profile` | ✅ | 角色名，对应 `dsh/roles/<profile>.md` |
| `goal` | ✅ | 节点目标提示词 |
| `output.schema` | 可选 | JSON Schema，仅受支持子集：`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解 `description/title/default/examples`（R-03） |
| `output.successCondition` | 可选 | `$.path ==|!= value`（value ∈ true/false/null/字符串/数字）；路径必须已在 `output.schema` 中声明 |
| `output.files` | 可选 | 对象：`{ "<相对路径>": "json"\|"markdown"\|"text" }`——本节点**应产出**的声明式文件契约（D7，Q1 增补）；路径相对 `runDir/`；见 §6.4 |
| `manualCheck` | 可选 | 布尔，默认 false；true = 人工门禁节点（vwf 编译为 `AWAITING_HUMAN_<id>` + resume 续跑；DSH 侧对应脚本返回 + 主会话裁决） |
| `verifyBranch` | 可选 | 布尔，默认 false；DSH 增强（D4）：置 true 时 `output.schema.required` **必须**含 `verified_branch` 与 `verified_head`（可信度闸门，编译注入开工分支自检 + 结论硬校验）；vwf 侧 v1 忽略，**v1.1（候选一统一编译器）起按蓝图内容生效**——内置模板含本字段，vwf 入口同样硬校验 |

### 2.3 边

| 字段 | 必填 | 说明 |
|---|---|---|
| `from` / `to` | ✅ | 节点 id；`to` 可为 `$end`（结束）；`from` 不得为保留 id |
| `on` | ✅ | `'success'` \| `'failure'` |
| `when` | 可选 | 仅 success 边；`$.path ==|!= value`；多 success 出边必须**全部**带 when；failure 边最多一条 |

## 3. 校验规则（两层，D5）

### 3.1 蓝图级规则（校验内核，候选二 T-IMP-13）

> **统一校验内核**：`scripts/validate-core.cjs` 为唯一规则集（CJS 单文件、零依赖）——
> 结构层 `validateStructure`（走通性/节点边定义/入口/环/条件/schema 路径/保留 id/
> **maxRounds ∈ [1,9] 系统上限**）与业务规则层 `validateBlueprint`（本节约束 +
> `requireModels` 选项——宿主编辑器产品收紧）。引擎 ESM import；宿主经 fs 读源码、
> vm 内求值缓存（热路径内存执行）。错误统一携带坐标键 `fieldKey`
> （`node:<id>:<field>` / `edge:<i>:<field>` / `control:<field>` / `heteroCheck` /
> `onMaxRounds`）；前端文案翻译列为优化任务（MAP Not yet specified）。

1. `id` 匹配 kebab-case；`displayName` 非空；无 `name` 字段（单标识，D1）。
2. `onMaxRounds ∈ {return, auto-reschedule}`。
3. `bindings.models` 的每个键都必须是已声明节点 id。
4. `heteroCheck=true` 时存在 `dev` 与 `review` 节点。
5. `verifyBranch=true` 节点：`output.schema.required` 含 `verified_branch`/`verified_head`。
6. `output.files`（若给）：键为合法相对路径（非空、不以 `/` 开头或结尾、不含 `..`、不覆盖保留文件 `STATE.md`）；值为 `json|markdown|text` 枚举。
7. **异源硬规则（v2 生效，T-06）**：凡含 `dev` 与 `review` 节点的蓝图（按节点 `id` 或 `profile` 识别——编辑器新建节点默认 id 为 node-N，以角色表达 dev/review 时同样纳入），save/update/validate 一律校验其 `bindings.models`——任一缺失 → 拒（「无法证明异源，请显式配置」）；完全同模型（provider+model 相同）→ 拒；同 provider 不同 model（弱异源）→ 通过 + warning；不同 provider → 通过。无 dev/review 节点的蓝图跳过。错误消息沿用 `errors[]` 结构（at=`bindings.models`，含实际 provider/model 与修复指引）。
8. `control.maxRounds`（若给）：**1-9 的整数（系统约定上限 9，候选二 Q7）**——0/负数/小数/非数/超 9 一律拒绝（坐标键 `control:maxRounds`）。

### 3.2 DSL 结构规则（与校验内核结构层对齐；原 host `validateDsl` 已删除）

- 唯一入口（无入边节点恰一个，回退边不计入边）；**多候选一律拒绝，显式 entry 不豁免**。
- 必须存在指向 `$end` 的边；节点必须有出边；profile 必填。
- 边：from/to 存在、on 合法、when 仅 success 且格式合法、failure 边 ≤1、多 success 出边全带 when。
- 拓扑：全节点从入口沿 success 边可达；success 边无环（打回走 failure 边）。
- `successCondition` 路径必须在 `output.schema` 内。
- **走通性**：有 successCondition 的节点必须有 failure 边（判定失败无出口 → 创作期拒绝，运行时 `ENDED_NO_FAILURE_EDGE` 兜底）。
- 宿主侧 `heteroCheck`/拓扑推导/COND_RE 已删除——唯一实现收敛进内核。

## 4. 编译语义（生成器，FR-2 依据）

### 4.1 vwf 侧投影

`projectToVwf(bp)`：字段映射为 vwf DSL 子集——`id`、`name = displayName`、`description`、`entry`、`control.maxRounds`；节点注入 `model = bindings.models[nodeId]`（无则省略）；保留 `output`/`manualCheck`；**业务规则字段（候选二 Q7 修订）：`onMaxRounds` / `heteroCheck` 进入 DSL（编辑器可配置）；`verifyBranch` 为节点级字段、编辑器无 UI，暂不进入**。产物可喂校验内核结构层（R-02/R-03）。

> **编译语义（v1.1 候选一统一编译器，T-IMP-12）**：DSH 与 vwf 双入口共用单一编译器
> `scripts/generate.mjs compileBlueprint`。宿主（`host.js`）经管道取译文：内置模板读
> `.generated/<id>/script.mjs`、用户模板读 `~/.dsh/skills/<id>/script.mjs`（均为
> `compileBlueprint` 产物，含蓝图全部增强）；临时图/编辑器实时查看走 CLI
> `generate.mjs compile` 兜底（DSL 逆投影回蓝图后编译，行为由蓝图内容决定）。
> 原宿主侧 `compileDsl`（无增强的第二份实现）已删除。

### 4.2 DSH 侧折叠与增强注入（D3、D4）

- **分流折叠**：识别「单节点、恰两路 success 出边、全带 when、条件为同一路径的 `== true` / `== false`」→ 编译为脚本内 `if`（无 LLM 调用，严格转发上游判定）；vwf 侧保持 route 节点（一次 LLM 转发，行为差异显式化）。
- **超限归因**：`onMaxRounds = 'auto-reschedule'` → 超限时注入归因 agent（产出 reschedule：归因/拆分/人工介入建议）。
- **可信度闸门**：`verifyBranch=true` 节点 → 注入开工分支自检 + `verified_branch`/`verified_head` 硬校验（失败即 TECHNICAL_FAILURE 打回）。
- **异源警告**：`heteroCheck=true` → 注入 dev↔review 模型比对 warning（v1 不拦截，v2 由 T-06 升级为 enforcement）。

### 4.3 角色与运行上下文

生成脚本须注入与手写 mjs 等价的 `roleRef`（agent 开工自读 `dsh/roles/<profile>.md`）与运行上下文块（taskId/runDir/baseBranch/workBranch/STATE.md 契约）——见 `docs/research/mjs-semantics.md` §4。

## 5. 示例蓝图

完整示例（dev-workflow-2.0 抽取，含全部增强）内嵌于原型评审台 `.scratch/schema-prototype/blueprint-schema-demo.html` 的「场景：2.0 全量抽取」；定稿版本在 v1 实现时落 `templates/dev-workflow-2-0.json`（AC-1）。

## 6. 运行时语义（固定约定，蓝图不可配置）

> 以下语义由引擎/编译器固定实现，蓝图**无需也不能**配置；文档化以避免 AI 编写蓝图时误以为可定制。

### 6.1 节点执行模型（会话延续方式）

- **每个节点 = 全新 subagent**（`agent()` 调用），不延续上一节点会话；节点间上下文经 `runDir/` 文件 + `args`（dispatch/feedback/history/startRound 等）传递（R-01：README:167「session: new/continue → 每个节点都是新 subagent」）。
- **人工门禁节点例外**：manualCheck 节点运行至产出即返回主会话（`AWAITING_HUMAN_<id>`），人工裁决后以 `entry` 续跑——这是唯一跨「会话边界」的延续点。
- 蓝图不提供会话延续配置项；若未来需要（如同会话内顺序执行），属引擎能力扩展。

### 6.2 节点结果判定语义（四种判定，可组合）

| 判定 | 蓝图表达 | 行为 |
|---|---|---|
| 结构验证 | `output.schema` | agent 返回须通过 schema 校验；失败 → `TECHNICAL_FAILURE`（终止或走 failure 边） |
| 值验证 | `output.successCondition` | 满足 → success 出边；不满足 → failure 出边（打回） |
| 人工确认 | `manualCheck: true` | AI 核验产出后挂起，主会话裁决：通过 → `approved` 续跑走 success 出边；不通过 → `feedback` + `startRound+1` 续跑走 failure 出边 |
| 无验证 | 无 `output` 且非 manualCheck | ok=true 自动走 success 出边 |

- 组合示例：accept 节点 = 结构验证 + 人工确认（AI 核验产双报告，**人工不代签**）；review 节点 = 结构验证 + 值验证（`$.verdict != "REQUEST_CHANGES"`）；route 节点 = 仅结构验证 + 边 `when` 分流。
- 判定失败路径统一走 failure 边（打回/终止），success 边不得成环。

### 6.3 模型档位与权限管控

- **思考强度**：引擎 `agent()` opts 白名单 = `label/phase/schema/provider/model`（R-03），**无 thinking/effort 选项**——蓝图指定也会被引擎 loud reject；设计上以**模型档位替代思考强度**（deepseek-v4-pro 高 / deepseek-v4-flash 高速 / kimi-k3 中高，dsh/README.md:165、169-209）。
- **权限模式**：宿主统一管控——workflow 脚本运行于 vm（无文件/网络/Node API，R-03），节点子代理受**会话沙箱策略**（workspace-write）约束；无 per-node 权限字段（gold-band `permission_mode` 在 DSH 迁移时明确不需要，README:166-167）。per-node 权限（如审核节点只读）列为 **v2 候选**（引擎能力扩展，蓝图不预置字段，见地图 Not yet specified）。

### 6.4 节点产出文件（runDir 契约）

- 运行目录：`runDir/`（如 `.agent-runs/<taskId>/`，已 gitignore），由 `args.runDir` 注入；编译产物固定注入「本节点只允许在该目录内写文件」。
- `STATE.md`（stage/round/status/updated）为**运行时固定维护**文件，蓝图不可声明、不可覆盖。
- `output.files` 为节点**应产出**文件的声明式契约（D7）：编译器注入文件清单到运行上下文（「本节点产出：`dispatch-result.json`(json)、`dev-report.md`(markdown)…」），供 AI 与下游校验引用。
- 兼容性：现有 2.0 抽取时把 goal 中已提及的文件名同步填入 `output.files`；`output.files` 是权威声明，goal 提及的文件名应与之一致。
  **机器核对（候选五 C5 起替代人工核对）**：校验内核规则 A——goal 中**反引号引用**的文件名（`` `dev-report.md` ``）必须在某节点 `output.files` 声明或为保留文件 `STATE.md`，否则拒绝（坐标 `node:<id>:goal`）；裸提及（如 `package.json` 工程文件）不检查，避免误报。repo 级测试 T8 同步核对 `dsh/roles/*.md` 的反引号文件名 ⊆ 模板声明（约定：交付物文件名在 goal/角色文件中一律反引号引用）。
- v1 仅注入与留痕，不做「文件缺失即失败」的运行时强制（agent 自报为主）；若 v2 需要硬门禁（文件未产出视为节点失败），校验器与运行时再升级。

## 7. 决策记录（T-01，2026-08-19）

| 决策 | 结论 |
|---|---|
| D1 标识 | 单标识：`id = name`（kebab-case），`displayName` 承载中文名 |
| D2 模型绑定 | 节点粒度 `bindings.models[nodeId]` |
| D3 分流表达 | 蓝图保留 route 节点 + 双 when 边；DSH 编译器折叠为 if |
| D4 DSH 三增强 | 进蓝图（`onMaxRounds` / `heteroCheck` / `verifyBranch`） |
| D5 校验分层 | 蓝图级 + DSL 结构级（对齐 validateDsl） |
| D6 落盘 | 本文档（`docs/design/blueprint-schema.md`） |
| D7 产出文件（Q1 增补） | 节点 `output.files` 声明式契约（相对 runDir，kind 枚举）；STATE.md 保留文件不可声明；v1 注入+留痕、不强制缺失即失败 |
| Q4 权限管控（增补） | per-node 权限列为 v2 候选 fog（引擎扩展，蓝图不预置字段）；思考强度明确不需要（引擎白名单不支持，模型档位替代） |
