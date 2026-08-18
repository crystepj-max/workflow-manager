# 迁移分析报告：Gold-Band 工作流编辑器 → DSH 可视化工作流插件编辑模块

> 目标：参考 Gold-Band 项目工作流编辑器模块的实现方案，改造 DSH 工作流插件（pkg-19）的编辑模块，确保功能、UI 设计、交互体验与原始模块保持一致。
> 基线：`~/.dsh/sessions/…session-fba8b185…` 中 pkg-19 双半包（已提取至 `.scratch/vwf-pkg19/`）。
> 产物：`packages/dsh-visual-workflow/src/{host.js,client.js}`。

## 1. 原始模块（Gold-Band）架构解析

| 层 | 文件 | 职责 |
|---|---|---|
| 画布 | `components/WorkflowEditor.tsx` | @xyflow/react 画布：节点/边渲染、`onConnect` 拖拽连线、右键菜单（$end/$new-round）、点选、工具栏（新增/删除节点）、校验弹窗、画布/JSON 双 tab |
| 布局 | `components/workflowGraph.ts` | dagre LR 分层（仅 success/前向边参与）、`computeBackwardLanes` 回退边车道、`workflowSuccessTopologyOrder`、入口候选推导、哨兵 id（$end/$entry/$new-round） |
| 配置面板 | `WorkflowEditor.tsx` 内 `WorkerNodeInspector` / `EdgeInspector` / `WorkflowControlInspector` | 节点 ID（IME 保护+清洗去重）、Agent/模型/思考强度、角色选择器、权限模式、目标、结果判定三态（不启用 / AI 输出验证 / 人工 check）、输出产物 Key + JSON 输出约束（2s 防抖 + 美化）+ 成功表达式；边：类型/目标/session/新 Round 起点；控制：max_attempts/max_rounds |
| 校验 | `validateWorkflowForSave` | 入口唯一性（拓扑推导）、$end 必须、悬空/重复/保留 id、表达式路径 ∈ schema、重复出边、成功→new-round 禁则等；返回 `{issues, fieldErrors, sanitizedWorkflow}` |
| 交互闭环 | 校验弹窗关闭 → `fieldErrors` 逐字段标红 + `invalidNodeIds` 画布红圈 + 定位首个问题节点；保存失败展示 `displayAppError` |
| 宿主 | `pages/WorkflowPage.tsx` / `RunModeManagementPage.tsx` | 1120px 可拉宽 Sheet 抽屉承载编辑器；模板库（默认模板只读、另存为） |

## 2. 基线（pkg-19）现状与差距

- 编辑器为「表单 + SVG 点击连线」：无把手拖拽连线、无右键菜单、无边配置面板、无结果判定三态、无校验弹窗（只有实时错误箱）、无 JSON tab、无入口拓扑推导（手动选 entry）。
- 校验仅覆盖 pkg-19 自研子集（无入口唯一性、无表达式路径 ∈ schema 检查、无 fieldErrors 定位）。

## 3. 迁移映射（Gold-Band → 新 client.js）

| Gold-Band 能力 | 迁移落点 | 说明 |
|---|---|---|
| React Flow 画布 + 点选/框选 | `Canvas`（SVG 手写，动态包无 bundler/import） | 点选节点/边；空白点击只关菜单不清选择（与原版一致） |
| 把手拖拽连线 `onConnect` | 节点右把手 `onSourceDown` + 窗口 pointermove/up + 命中检测 | 落到目标节点（含 $end）建 `on:'success'` 边；临时虚线预览 |
| 右键画布菜单 | `onPaneContextMenu` → `vwf-menu` | 仅「添加结束节点」（插件 DSL 无 $new-round） |
| 自动布局 + 回退车道 | `layoutGraph` / `computeBackwardLanes` / `successTopologyOrder`（手写移植 workflowGraph.ts） | 最长路分层 LR、层内纵向堆叠居中；回退边按 Gold-Band 公式走上方车道（laneY = min(y) − 82 − lane·38） |
| 节点/终止节点视觉 | 220×66 圆角卡片（label + kind 小字）、入口徽标、$end 140×44 虚线圆 | 配色用 DSH shell CSS 变量（--dsw-alias-*） |
| 边视觉 | 流动虚线动画、箭头、成功/失败标签、选中高亮光晕、车道走线 | stroke-dasharray 3 17 + dashoffset 动画（同 Gold-Band workflow-edge-flow） |
| 节点配置面板 | `NodeInspector` | ID（blur/Enter 提交、IME 合成保护、清洗去重）、显示名、角色（vwf.roles）、Agent/模型（vwf.models，换 Agent 重置模型）、目标、结果判定三态互斥切换、schema 2s 防抖 + 失焦提交 + ✨美化 + 非法不写入、成功表达式 |
| 边配置面板 | `EdgeInspector` | 类型（切 failure 自动清除 when）、目标（节点+$end）、when（仅 success）、删除边 |
| 工作流控制 | 控制卡片 | 打回上限 maxRounds（插件 DSL 无 max_attempts；留空默认 9） |
| 校验弹窗 + 字段标红 + 定位 | `handleSave` / `closeValidationDialog` | 弹窗列问题 → 关闭后 fieldErrors 标红 + invalidNodeIds 画布红圈 + 选中/聚焦首个问题 |
| 画布/JSON 双 tab | `Editor` 的 canvas/json tab | JSON 实时解析同步回画布；保存时 JSON 非法报错（同原版） |
| 实时校验状态 | 防抖 `vwf.validate` 状态行 | 「✓ 校验通过 / N 条问题」（pkg-19 实时预览能力的保留，Gold-Band 仅保存时校验） |
| 入口拓扑推导 | `deriveEntryCandidates` / `normalizeEntry`（双半同构） | 唯一无入边节点自动设为入口，画布显示入口徽标 |
| Sheet 抽屉宿主 | 设置 section「模板库」+ 右侧 ≈1120px 大抽屉 | 对应 WorkflowPage 的 Sheet 抽屉形态 |

## 4. 校验规则迁移（host.js validateDsl，Gold-Band 同构）

保留 pkg-19 编译/运行语义（when 条件边、success 环禁则），补齐 Gold-Band 规则并输出 `fieldErrors`：

| 规则 | Gold-Band | 插件版 |
|---|---|---|
| 工作流 id / nodes / $end 必须 | ✓ | ✓ |
| 入口唯一（拓扑推导，0 或 >1 报错） | ✓ | ✓（替代 pkg-19 手动 entry 校验） |
| 节点 id 必填/重复/保留 id/悬空/不可达 | ✓ | ✓ |
| 角色（profile）必填 | ✓ | ✓（对应原版「未关联角色」） |
| 成功表达式格式 + 路径 ∈ 输出约束 | ✓ | ✓（插件 schema 为 JSON Schema，走 properties/items 下钻） |
| 同类型出边唯一 | ✓（success/failure 各一条） | 适配：failure ≤1；多条 success 必须全部带 when（保留 pkg-19 语义） |
| 人工 check 与输出验证互斥 | ✓ | 编辑器交互层互斥；校验器不强制（内置「人工验收」节点合法地同时带 schema+manualCheck） |
| when 仅 success + 格式 | —（原版无 when） | ✓（pkg-19 保留） |
| success 边成环禁则 | — | ✓（pkg-19 保留） |
| sanitizedWorkflow 清洗 | ✓ | ✓（入口归一、failure 边剔除 when、maxRounds 取整） |

## 5. 适配决策记录（与「1:1」的刻意偏差及原因）

1. **UI 栈**：用户选择 DSH 原生观感。动态客户端闭包**禁止 `require`**（运行时教学性拦截），宿主 ui-primitives 无法 import → 采用 DSH shell CSS 变量体系（`--dsw-alias-*`：bg-layer/border/label/state/brand）自绘组件，布局结构（1fr+340px 双栏、卡片分区、弹窗、抽屉）与原版一致。
2. **布局引擎**：dagre 不可 import → 手写等价分层布局（最长路分层 + 层内居中 + 回退车道），视觉语义与 workflowGraph.ts 一致；节点不可手拖（与 Gold-Band `nodesDraggable=false` 一致），放弃 pkg-19 的拖拽/调宽高。
3. **DSL 差异**：插件 DSL（nodes{id,label,profile,model,goal,output{schema(JSON Schema),successCondition},manualCheck}，edges{from,to,on,when}，control{maxRounds}）不引入 Gold-Band 的 `$new-round`/`session`/`max_attempts`/思考强度/权限模式——右击菜单仅 $end、边面板仅 on/to/when、控制仅 maxRounds；编译器与 wf_run 语义零改动。
4. **数据源**：用户选择对接 DSH 服务——`vwf.models` 直读宿主 `llm` 服务（pkg-16 已有），新增 `vwf.roles` 读工作区 `dsh/roles/*.md`（fs 服务，多形态兜底 + 内置六角色回退）。
5. **计时器**：动态客户端无 setTimeout → schema 防抖/校验防抖/缩放滚动全部走 `ctx.timeout`（inject: ['timer']）。
6. **模板库持久化**：保留 pkg-19 进程内 Map（storageDomain 持久化属 P2 D3，独立任务）。

## 6. 验证

- `npm test`：24 用例全绿——host 16（内置模板校验/编译、入口拓扑、多入口 nodeIds、$end/悬空/重复/保留 id、表达式路径 ∈ schema、failure 唯一、多 success 带 when、when 禁则、maxRounds、save/list/remove 链路、roles/models 回退、wf_run 注册、state）；client jsdom 8（模板列表、抽屉、增删节点、**把手拖拽连线建边**、边面板、JSON tab 同步、**校验弹窗→字段标红**、保存 RPC）。
- 真机验收：需在 cordis 会话以 `cordis_define` 定义并批准运行后，于 DSH 设置→工作流页复核（本会话无 cordis 工具，仅做了离线验证）。
