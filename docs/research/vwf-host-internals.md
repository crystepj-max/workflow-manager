# R-02 · vwf 宿主与 DSL 盘点

> 调研票 R-02 产物。一手资料：`packages/dsh-visual-workflow/src/host.js`（598 行）、`tests/host.test.mjs`、`tests/client.smoke.mjs`、`dsh/README.md`（vwf 章节）。行号均为 host.js 位置。

## 1. 内置模板结构（TEMPLATES，L29-74）

`dev-workflow-2-0` 字段全集：
- 顶层：`id` / `name`（中文展示名「开发工作流 2.0」）/ `description` / `entry`（'dispatch'）/ `control.maxRounds`（9）。
- 节点（7 个）：`id` / `profile`（角色名，对应 dsh/roles/*.md）/ `label`（中文）/ `model:{provider,model}`（**硬编码**，全部 deepseek-official）/ `goal` / `output:{schema, successCondition}` / `manualCheck:true`（仅 accept 节点）。
- 边（12 条）：`{from,to,on,when}`；`on ∈ success|failure`；`when` 仅 success 边（route→test `$.need_integration_test == true`、route→review `== false`）。
- 哨兵：`$end`（必须存在到 $end 的边）；`$entry`/`$new-round` 保留但插件 DSL 不用（L76-80）。

**与规格 FR-1 字段清单的差异（规格漏了）**：`model`（规格要求改为 per-entry 绑定配置）、`manualCheck`（**漏掉即丢「人工验收门禁」能力**）、`description`。蓝图 schema 必须收纳三者。

## 2. validateDsl（L184-306）

校验规则全集（Gold-Band validateWorkflowForSave 同构）：
- 结构：dsl 是对象、id 非空、nodes 非空数组、edges 必填数组（L201-205）。
- 入口拓扑：唯一无入边节点（回退边不算入边，L127-137, L210-212）；或显式 dsl.entry。
- 必须存在指向 `$end` 的边（L214）；maxRounds>0（L215-217）。
- 节点：id 非空/唯一/非保留、必须**有出边**、profile 必填、output.schema 若给须为对象、successCondition 须匹配 `COND_RE`（`$.path ==|!= true|false|null|"str"|数字`，L82）且路径须在 schema 内声明（L237-253）。
- 边：from/to 存在（to 可为 $end）、from 非保留、on 合法、when 仅 success 边且匹配 COND_RE（L256-271）。
- 拓扑：多 success 出边必须全部带 when；failure 边最多一条（L273-281）；全节点可达（L283-291）；**success 边无环（打回走 failure 边）**（L293-303）。
- 返回 `{ok, errors, fieldErrors, sanitized}`；`sanitizeDsl`（L162-178）归一 entry、failure 边剔 when、修 maxRounds。
- 测试覆盖：host.test.mjs 覆盖校验矩阵 + save/list/remove 全链路；client.smoke.mjs 覆盖 UI 编辑/保存。

## 3. compileDsl（L308-419）——DSL → 可执行脚本

生成一个 **plain JS 字符串**（`(async () => {...})` 形态，与手写 mjs 同为 workflow 工具 script 风格）：
- 头部常量：TASK/RUNDIR/ROLE_DIR/BASE/WORK/MAX_ROUNDS（L317-323）；`NODES`/`EDGES` 以 JSON **内嵌**（L324-325）。
- `cond()`：when/successCondition 运行时求值（正则解析 `$.path ==|!= value`，L328-341）。
- `issueBlock()` / `roleRef()` / `runtimeCtx()`：与 mjs 的 ctx 注入同构（含 goal、STATE.md 契约；L342-353）。
- `callNode(id, round, feedback)`：`agent(prompt, {label, schema?, ...model})`，label 带轮次（L354-362）。
- `route(id, res, ok)`：success 边先匹配 when 再取无 when 边；failure 边走 failure 边（L363-373）。
- 主循环（L374-416）：
  - `current = A.entry || dsl.entry`；`round = A.startRound || 0`。
  - **manualCheck 节点**：首次运行该节点 → 返回 `AWAITING_HUMAN_<id>` + `resume:{entry, approved:true, startRound, history, feedback}`；续跑带 `approved:true` → 走 success 出边（L382-392）。
  - agent 返回 null → 记 history、走 failure 边；无 failure 边或到 $end → `TECHNICAL_FAILURE`；否则 round++ 续跑（L394-399）。
  - successCondition 不通过（ok=false）→ 走 failure 边；无对应边 → `ENDED_NO_SUCCESS_EDGE` / `ENDED_NO_FAILURE_EDGE`（L401-404）。
  - failure 边：到 $end → `FAILED_AT_<node>`；`round >= MAX_ROUNDS` → `FAILED_MAX_ROUNDS`；否则记 history、组装 feedback、round++（L405-410）。
  - `$end` → `DONE`（L416）。
- meta：`{name: 'vwf-<id>', description, phases}`（L315）。
- **可执行性**：产物是标准 workflow 脚本形态（只用 agent/phase/log + args，无 Node API）；host.js:581 回退路径明示「编译产物经 vwf.script RPC 提供给 workflow 工具执行」——即**普通 `workflow` 工具可直接跑 compileDsl 产物**（R-03 已核实该契约）。

## 4. 持久化现状（L421-431）与 RPC

- `userWorkflows` 为**内存 Map**：save（L442-448）仅 `validateDsl` + `set`，**不落盘，重启即丢**（规格「核实新增」属实）；remove（L450-451）仅 delete；list（L427-431）合并内置 TEMPLATES + userWorkflows，`builtin` 标志区分。
- 其他 RPC：`vwf.validate`（L453）、`vwf.compile`（L456-460，返回 scriptLen/meta）、`vwf.script`（L462-463+，返回编译脚本文本）、`vwf.roles`（列 dsh/roles/*.md，L13-14）、`vwf.state`/`vwf.models`。
- findWorkflow（L422-426）：内置优先，用户覆盖。

## 5. 引擎接线（L526-595）

- `workflowEngine` 由 **agent preset 平面挂载**（`workflow-worker-thread`，L527-538；preset 声明见 DSH 包 `config/agent-presets/code/agent.cordis.yml:222-228`）。
- 有 engine + agents 时注册 `wf_run` 工具（L576-592）：`templateId|dsl` 二选一 + taskId/runDir/entry/approved/feedback/startRound/history/issue 载荷；`engine.start({script: c.script, meta: c.meta, args: scriptArgs, parent})`，结果 JSON 化（L588-590）。
- 无 engine 时回退：编译产物经 `vwf.script` RPC 交普通 `workflow` 工具执行（L581, L595）。

## 6. 对生成器决策最相关的事实（摘要）

1. **compileDsl 产物 = 标准 workflow 脚本**，可被普通 workflow 工具执行 → T-02 的「复用 vwf 编译器」路线有直接事实支撑，DSH 侧只需 skill 包装 + args 装配。
2. vwf DSL 已表达：条件边（when）、打回（failure 边 + maxRounds）、人工门禁（manualCheck + AWAITING_HUMAN_* + resume）、节点 schema 闸门。
3. **vwf 编译产物缺 DSH 侧 3 个增强**（R-01 对照表）：① 超限自动归因 agent（reschedule）；② verifyBranchStep/claimError 可信度闸门（verified_branch/head）；③ 异源 warning。蓝图抽取若追求行为对齐，这三项要么进蓝图（新字段），要么进生成器特例——T-01/T-02 决策点。
4. `model` 硬编码在模板节点内 → 蓝图须把它移到 per-entry 绑定配置（FR-1 已定方向）；save/validate 均不校验异源（FR-8 现状属实，host.js:442-453）。
