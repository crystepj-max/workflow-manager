# OpenSpec 提案：vwf-p2 · 可视化工作流插件产品化

> 对应 issue #6（父 #3）；决策来源：D1-D5（#9-#13，2026-08-16 全部关闭）

## 1. 背景

P0/P1 已完成动态原型：DSL 校验器 + 编译器 + 编辑器 + 运行看板 + E2E 全链路。P2 把它从「会话内动态插件」升级为「可安装产品」。

## 2. 目标（验收标准）

1. 插件经 `dsh plugin --profile web add link:<path>` 安装，重启会话后仍在且功能完整。
2. 用户工作流经 storageDomain 持久化，跨会话保留可复用。
3. fan-out 节点可执行：按 items 来源并行展开子任务并聚合结构化结果（ITEM_CAP/caps 内）。
4. 多工作流并行运行互不串扰（三约束落实）。
5. 执行路径正式化：vwf.script + 平台 workflow 工具（wf_run 条件注册保留）。

## 3. 已决决策（D1-D5）

| 决策 | 结论 | 影响 |
|---|---|---|
| D1 AiDynamic | B 受限并行子任务节点（fan-out） | DSL 新节点类型 fanOut；编译为 pipeline；C 保留扩展位 |
| D2 打包分发 | 阶段式 A→B→C | 开发期 link 安装迭代；profile=web |
| D3 持久化 | A storageDomain 宿主域 | workflow 域 backend:json；tables={workflows,runs} |
| D4 并行 | A+B 组合 + 三约束 | 门禁串行裁决 / taskId 互斥 / closeout 串行或 worktree |
| D5 执行链路 | C vwf.script + 平台工具 | 不实例化引擎；wf_run 条件注册保留 |

## 4. 设计

### 4.1 组合包结构（D2-A）

```
packages/dsh-visual-workflow/
├── package.json        # name: dsh-visual-workflow；dsh.bundle.patch + dsh.client + exports["./cordis.patch.yml","./client"]
├── cordis.patch.yml    # host 插件行（id: visual-workflow）
├── src/host.js         # 自 pkg-14 host 半抽取为模块（plain JS，无 import 依赖宿主 builtins）
└── src/client.js       # 自 pkg-14 client 半抽取（自包含经典脚本，__ModuleLoader__.load 注册形态以目标环境为准）
```

安装验证：`dsh plugin --profile web add link:/Users/chris/workspace/workflow-manager/packages/dsh-visual-workflow` → `dsh --profile web --dump-config` 核对 patch 层 → 重启会话 → 设置→工作流 可用。

### 4.2 storageDomain 域（D3）

```js
defineDomain({
  name: 'workflow',            // UNIT_NAME_RE 合规
  version: 1,
  global: { schema: 顺序/元数据, initial: { order: [] } },
  tables: {
    workflows: { valueSchema: DSL 文档（zod/等价校验） },
    runs:      { valueSchema: 运行摘要（runId, taskId, workflowId, status, startedAt, updatedAt }）,
  }
})
```

生命周期：apply/init 阶段 `await ctx.storageDomain.open(spec)`，`ctx.effect(() => () => domain.close())`；禁止在工具调用内反复 open（already-open 风险）。userWorkflows 从内存 Map 迁到 `domain.table('workflows')`；list/save/remove 改为域读写。

### 4.3 fanOut 节点（D1）

DSL 新增节点字段：

```json
{ "id": "fan", "kind": "fanout", "profile": "dev", "model": {...},
  "goal": "每个子任务的目标（可用 {{item}} 占位）",
  "items": "$.results.dispatch.split 或 args.issues 等运行时表达式",
  "output": { "schema": {...} } }
```

编译语义：`pipeline(<itemsExpr>, async (item) => agent(itemPrompt(item), opts))` → 结果数组传给下一节点；聚合语义（per-item null = 子任务失败，需脚本显式处理）。cap 约束：单调用 ≤4096 items、run 总 agents ≤1000，编译器在节点上生成上限断言。编辑器加节点类型 fanout（items 表达式 + item 模板 + schema）。

### 4.4 并行三约束（D4）

1. **人工门禁串行**：看板将 AWAITING_HUMAN 按 taskId park 为待裁决卡片，逐张裁决后续跑。
2. **同 taskId 互斥**：启动前查 runs 表/内存，同 taskId 有进行中 run 则拒绝。
3. **closeout 串行或 worktree**：收口动作经队列串行执行（MVP：看板排队提示；后续可选 per-run worktree）。

### 4.5 执行路径（D5）

正式路径：编辑器「获取脚本」→ 粘贴到会话 → 平台 workflow 工具执行。wf_run 保留条件注册（引擎可达时可用）。README 与插件 UI 运行指引按此正式化。

## 5. 风险与缓释

- fan-out 规模失控 → 编译器生成 ITEM_CAP/AGENT_CAP 断言与提示。
- 无 journaling：run 状态连续性靠看板持久化返回体（runs 表）。
- closeout 并发互踩 → 三约束中的串行收口。
- 双实例引擎风险 → 不实例化（D5 已决）。

## 6. 施工任务（to-tickets）

| # | 任务 | 依赖 |
|---|---|---|
| T1 | 组合包骨架 + link 安装验证 | 无 |
| T2 | storageDomain 迁移（模板/运行记录持久化） | T1 |
| T3 | fanOut 节点（DSL/编译器/编辑器/看板结果列表） | T1 |
| T4 | 并行看板与三约束 | T2 |
| T5 | 执行路径文档化（README + UI 运行指引） | T1 |
| T6 | 独立仓库 + github 分发（后置） | T1-T5 验收后 |
