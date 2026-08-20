# dsh-visual-workflow — 可视化工作流插件（编辑模块 Gold-Band 对齐版）

DSH 动态双半插件：在 Web 设置页提供「工作流」section——模板库 + 大抽屉可视化编辑器 + 运行看板。编辑器参考 **Gold-Band 桌面端《工作流编辑器》模块**（`web/src/components/WorkflowEditor.tsx` + `workflowGraph.ts`）实现，功能、UI 结构、交互体验与其保持一致；基于本仓库历史会话中的 **pkg-19 双半包**（`.scratch/vwf-pkg19/`）改造而来。

## 文件

```
packages/dsh-visual-workflow/
├── src/
│   ├── host.js            # 宿主半：DSL 校验（Gold-Band 同构规则）+ 编译 + RPC + wf_run 工具 + 运行状态跟踪
│   └── client.js          # 客户端半：模板库 + 大抽屉编辑器（画布/配置面板/校验弹窗/JSON tab）+ 运行看板
├── tests/
│   ├── host.test.mjs      # 34 个 node 单测（双根加载/校验/编译/撞名/RPC/回退/异源）
│   └── client.smoke.mjs   # 8 个 jsdom 冒烟用例（渲染/增删节点/拖拽连线/边面板/JSON tab/校验弹窗/保存）
├── docs/EDITOR-MIGRATION.md  # 迁移分析报告（架构对照 + 适配决策）
└── package.json           # 仅测试用 devDependencies（react/jsdom），插件本体零依赖
```

## 使用方式

两个半都是**动态插件包格式**（plain JS、无 import/JSX，`return { name, inject, apply }` 闭包体），直接在支持 cordis 动态插件的会话中定义：

```
cordis_define:
  plugin: vwf-2            # 插件 id（沿用 pkg-19 的 vwf-2 或新建）
  code:
    client: <src/client.js 内容>
    host:   <src/host.js 内容>
```

激活后打开 DSH Web 设置页 → 「工作流」：

- **模板库**：内置「开发工作流 2.0」（`.generated/<id>/`）+ 用户模板（`~/.dsh/visual-workflow/templates/<id>.json`）双根列表；新建 / 编辑（打开右侧 ≈1120px 大抽屉）/ 删除（confirm 确认）/ 刷新。
- **编辑器**（抽屉内）：
  - 画布：自动分层布局（success 主链 LR，回退边走上方车道）、点选节点/边、从节点右把手拖出连线到目标节点建边、右键画布「添加结束节点」、滚轮缩放（指针锚定）+ 拖拽平移 + 缩放控件（画布内带纵向滚动条）、入口徽标、$end 虚线终点、流动虚线边 + 成功/失败标签（when 条件悬停可见，工具栏为文档流内一行、不遮挡入口节点）。
  - 配置面板：工作流控制（打回上限）、节点表单（ID/显示名/角色/Agent/模型/目标/结果判定三态/JSON 输出约束/成功表达式）、边表单（类型/目标/when/删除）；模型/名称带必填红星。
  - 保存：校验失败弹窗列问题 → 关闭后逐字段标红 + 画布红圈 + 定位首个问题；通过则落盘——撞名拒绝（`currentId` 一致=更新当前模板；ID 变更时「保存」禁用、仅「另存为」），落盘后同步编译 `~/.dsh/skills/<id>/` 三件套（save 即闭环）。
  - 画布 / JSON 双 tab 实时互同步；变更后防抖实时校验状态行。
- **运行看板**：输入 runId 自动轮询 `vwf.state`，画布染色 + Agent 表 + 日志（保留 pkg-19 能力）。

## RPC 面（host 半）

| RPC | 说明 |
|---|---|
| `vwf.workflows.list / save / remove` | 模板库 CRUD：双根加载（内置 `.generated/` 只读 + 用户 `~/.dsh/visual-workflow/templates/` 可写）；save 撞名拒绝 + 同步编译 skill（save 即闭环）；remove 仅用户 + 同步删 skill |
| `vwf.validate` | DSL 校验，返回 `{ok, errors, fieldErrors, sanitized}`（fieldErrors 键形如 `node:<id>:<field>` / `edge:<i>:<field>` / `control:<field>`） |
| `vwf.compile` / `vwf.script` | DSL → workflow 脚本编译（`vwf.script` 返回脚本全文与 engineAvailable） |
| `vwf.state` | 运行状态（runId → status/phase/agents/logs） |
| `vwf.models` | 对接 DSH 宿主 `llm` 服务的 provider/model 列表（编辑器的 Agent/模型下拉数据源） |
| `vwf.roles` | 读取工作区 `dsh/roles/*.md`（`fs` 服务，多形态兜底；不可用回退内置六角色） |

## 测试

```bash
cd packages/dsh-visual-workflow
npm install --cache <本地缓存目录>   # 仅安装测试 devDependencies
npm test                              # 42 个用例（host 34 + client 8）
```

## 与 pkg-19 的主要差异

- 校验规则全面升级为 Gold-Band《工作流编辑器》保存校验的同构集（入口拓扑唯一性 / $end 必须 / 悬空与不可达 / 保留 id / 成功表达式路径必须落在 output.schema 内 / failure 唯一 / 多 success 全带 when / success 环检测），并新增 `fieldErrors` 供面板逐字段标红。
- 编辑器从「表单式 + 点击连线」重构为 Gold-Band 的「画布 + 右侧配置面板」形态：把手拖拽连线、右键菜单、边/节点双配置面板、结果判定三态、schema 2s 防抖 + 美化、保存校验弹窗 + 定位、画布/JSON 双 tab。
- 宿主形态：模板库列表 + 右侧大抽屉（对应 Gold-Band 的 Sheet 抽屉）。
- 保留：`wf_run` 工具、编译产物、运行看板、`vwf.models`（DSH llm 服务对接）。

## 已知限制与后续（P2 依赖项）

- 持久化已落地（用户模板 `~/.dsh/visual-workflow/templates/` + skill 同步 `~/.dsh/skills/`），不再依赖 P2 的 storageDomain 方案（specs/vwf-p2 D3）。
- 插件 DSL 无 `$new-round` / `session` / `max_attempts` 概念，右击菜单仅「添加结束节点」（详见迁移报告）。
- 动态包无法 `import` 宿主 ui-primitives（运行时会话约束），编辑器使用 DSH shell 的 CSS 变量体系（`--dsw-alias-*`）实现原生观感。
- `wf_run` 工具注册条件为宿主 `agents` 可用；`workflowEngine` 解析推迟到执行期（本部署中该服务在 agent preset 平面，动态插件经 `agentPresets.serviceFor` 只读桥接仍可能解析不到），解析不到时错误在 execute 阶段明确返回，用户可改用「获取脚本」产物 + 内置 workflow 工具执行。
