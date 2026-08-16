# 需求分析：P0 · 动态插件原型（issue #4）

> 生成方式：requirements-analysis 流程（分诊 inline + size 判定 + 三要素 + 任务拆解）
> 需求源：https://github.com/crystepj-max/workflow-manager/issues/4
> 父任务：issue #3

## 分诊结论

- 类型：enhancement（新功能）
- 状态：ready-for-agent（架构与边界已定，无阻塞歧义，可直接施工）
- 澄清：跳过（需求内容清晰，歧义不足以阻塞，不浪费轮次）
- 体量：**M**（路径清晰 + 需拆多个依赖任务 + 单会话可推进；无需先期决策探索，不走 L 型 wayfinder）

## 三要素

### 任务目标（Goal）

用动态 Cordis 插件做出「可视化工作流」可运行原型：用户在 Web UI 里选中内置模板、看到只读流程图、点「运行」，插件即把 DSL 图编译成 workflow 脚本并交给 harness 引擎执行——对真实 issue 走完 调度→开发→测试→审核→人工验收→收口 全流程（含打回循环与人工门禁），全程零代码。

### 涉及范围（Scope）

- 新动态插件（host + client 两半，plain JS，无打包器/JSX/import）
- Host 半：DSL 校验器、DSL→workflow script 编译器、harness.handle RPC（validate/compile/run/state）、运行状态管理（内存）
- Client 半：settings.section「工作流」页——内置模板列表 + 只读 SVG 流程图（手写分层 DAG 布局）+ 运行按钮
- 复用（不改）：workflowEngine、agent() 的 provider/model 覆盖（kimi k3 / DeepSeek v4-pro / v4-flash）、本仓库 dsh/ 六角色与「开发工作流 2.0」模板语义、会话 workflow-run 节点展示

**非目标（P0 明确不做）**：画布编辑交互（增删节点/连边）、运行看板状态染色、组合包打包（dsh plugin add）、storageDomain 持久化、AiDynamic 节点、多工作流并行。（分别归 P1 / P2 / P2）

### 验收标准（Acceptance）

可操作、可复现的判定条件：

1. **校验器**：对非法 DSL（未知节点引用 / entry 缺失 / 同一来源节点同一结果重复出边）调用 validate 接口 → 返回错误列表且每条定位到节点 id；对合法 DSL 返回 0 错误
2. **编译器**：把「开发工作流 2.0」DSL 编译为可执行 workflow script——节点顺序、success/failure 边、9 轮上限、manual_check 暂停语义与图一致（对照：原 dev-workflow-2.0.mjs 行为）
3. **Client 渲染**：settings.section 出现「工作流」页；模板列表展示内置模板；选中后 SVG 图正确分层（无重叠节点），成功边/失败边样式可区分
4. **端到端**：点「运行」后，用一个真实 issue 全流程跑通；`.agent-runs/<task>/` 产出六份报告 + STATE.md；人工验收节点暂停、由用户在会话里裁决后才进入收口
5. **异源**：默认分配 dev=deepseek-official/v4-pro、review=kimi-coding/k3（kimi 不可用时整链路 DeepSeek 兜底，脚本警告弱异源）

## 任务清单（垂直切片，按依赖顺序）

| # | 任务 | 依赖 | 独立验收 |
|---|------|------|---------|
| 01 | DSL 类型定义与校验器 | 无 | 非法 DSL 报错定位（验收 1） |
| 02 | DSL→script 编译器 | 01 | 编译产物可执行、语义与图一致（验收 2） |
| 03 | Host RPC + 运行状态 | 02 | validate/compile/run 三接口可用（验收 2 前置） |
| 04 | Client 只读图 + 模板列表 | 03 | 验收 3 |
| 05 | 真实 issue 端到端试跑 | 04 | 验收 4 + 5 |

## 缺口

无。三要素齐全，可直接排期施工。
