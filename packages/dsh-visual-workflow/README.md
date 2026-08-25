# dsh-visual-workflow — 可视化工作流插件（编辑模块 Gold-Band 对齐版）

DSH 动态双半插件：在 Web 设置页提供「工作流」section——模板库 + 大抽屉可视化编辑器 + 运行看板。编辑器参考 **Gold-Band 桌面端《工作流编辑器》模块**（`web/src/components/WorkflowEditor.tsx` + `workflowGraph.ts`）实现，功能、UI 结构、交互体验与其保持一致；基于本仓库历史会话中的 **pkg-19 双半包**（`.scratch/vwf-pkg19/`）改造而来。

## 文件

```
packages/dsh-visual-workflow/
├── src/
│   ├── host.js            # 宿主半：DSL 校验（Gold-Band 同构规则）+ 编译 + RPC + wf_run 工具 + 运行状态跟踪
│   └── client.js          # 客户端半：模板库 + 大抽屉编辑器（画布/配置面板/校验弹窗/JSON tab）+ 运行看板
├── scripts/
│   ├── build-bundle.mjs   # src → dist + .src-stamp.json
│   └── check-dist-fresh.mjs
├── tests/
│   ├── host.test.mjs      # host 单测（双根加载/校验/编译/撞名/RPC/回退/异源）
│   ├── client.smoke.mjs   # jsdom 冒烟
│   ├── static-bundle.test.mjs  # 无 harness 静态 Host / dist apply
│   └── dist-fresh.test.mjs     # dist 新鲜度 + dsh-tools 版本对齐
├── verify.sh              # 本地质量闸门（build + 新鲜度 + 版本 + 包测试）
├── docs/EDITOR-MIGRATION.md
└── package.json           # @deepseek-ai/dsh-tools 对齐宿主 DSH v0.1.1-rc.2
```

## 开发模式：动态插件快速迭代

开发模式只用于版本内反馈。它使用独立的 `~/.dsh-workflow-dev`，不安装正式
`dsh-visual-workflow` 组合包，也不修改产品 `$DSH_HOME`、凭据或 Profile：

```bash
# 查看隔离状态、联合版本标识和同步指引
npm run dev:plugin

# 首次启动时由 DSH 默认模板初始化 web Profile；之后保持该进程长期运行
npm run dev:plugin -- start
```

如果当前 shell 显式设置的 `DSH_HOME` 不是开发 Home，入口会拒绝执行。需要自定义隔离路径时
使用 `VWF_DEV_DSH_HOME`；不得把它设为产品 Home。

每次修改后的同步单位固定为一个联合版本：

```text
vwf-dev-<host+client 联合源码哈希>
├── host   packages/dsh-visual-workflow/src/host.js
└── client packages/dsh-visual-workflow/src/client.js
```

重新运行 `npm run dev:plugin` 可获得当前联合版本标识。在开发 DSH 会话中：

1. 用 `cordis_define` 定义该版本，并在同一次 `code` 中同时提交 host 与 client；
2. 用 `cordis_run` 把完整 Package 作为一次更新激活；
3. 用 `cordis_inspect_self` 核对当前 Package / Run 的版本标识；
4. 查看界面与宿主行为；下一次修改后用新的联合版本重复以上步骤。

禁止单独更新 client 或 host。Cordis update 会先停止旧 Run；只提交一半会让另一半能力消失。
结束开发时在同一会话中先用 `cordis_stop` 停止，再用 `cordis_undefine` 清理动态 Package。
开发 DSH 重启后动态插件自动消失是正常行为。v0.1.0 不实现文件监听或本地命令自动操控动态插件，
也不依赖 DSH 未公开接口。

## 产品模式：正式安装与发布验收

```bash
# 构建 bundle 产物（dist/host-entry.mjs + dist/client.js + dist/.src-stamp.json）
# npm install / prepare 会自动重建；改 src 后必须再跑一次，否则 link 安装仍加载旧 dist
cd packages/dsh-visual-workflow && npm run build && npm run check:dist

# link 安装到 profile（路径用绝对路径；目标 profile 以实际为准）
dsh plugin --profile web add link:/Users/chris/workspace/workflow-manager/packages/dsh-visual-workflow

# 验证
dsh --profile web --dump-config | grep visual-workflow   # 可见 patch 层
# 重启 GUI 后：设置 → 工作流
```

- 包契约：`dsh.bundle.patch` → cordis.patch.yml（host 插件行）；`dsh.client` + `exports["./client"]` → dist/client.js（自包含经典脚本）
- `scripts/build-bundle.mjs` 把 src/ 的闭包体包装为上述两种形态——单一事实源仍是 src/
- 正式包只安装到产品 DSH；开发 Home 中检测到该包时，`dev:plugin` 会报冲突并中止。
- 动态开发态不是发布证据。准备发布时从仓库根执行 `npm run release:verify`，然后关闭开发 DSH、
  完整重启产品 DSH，确认正式 VWF 从真实安装路径加载，并完成真实工作流 E2E 和版本功能验收。
- 产品验收失败后必须退回开发模式修改 `src/`，重新执行完整发布流程；禁止修改 `dist/` 后继续验收。

正式或动态插件激活后，打开 DSH Web 设置页 → 「工作流」：

- **模板库**：内置「开发工作流 2.0」（`.generated/<id>/`）+ 用户模板（`~/.dsh/visual-workflow/templates/<id>.json`）双根列表；新建 / 编辑（打开右侧 ≈1120px 大抽屉）/ 删除（confirm 确认）/ 刷新。
- **编辑器**（抽屉内）：
  - 画布：自动分层布局（success 主链 LR，回退边走上方车道）、点选节点/边、从节点右把手拖出连线到目标节点建边、右键画布「添加结束节点」、滚轮缩放（指针锚定）+ 拖拽平移 + 缩放控件（画布内带纵向滚动条）、入口徽标、$end 虚线终点、流动虚线边 + 成功/失败标签（when 条件悬停可见，工具栏为文档流内一行、不遮挡入口节点）。
  - 配置面板：工作流控制（打回上限）、节点表单（ID/显示名/角色/Agent/模型/目标/结果判定三态/JSON 输出约束/成功表达式）、边表单（类型/目标/when/删除）；模型/名称带必填红星。
  - 保存：校验失败弹窗列问题 → 关闭后逐字段标红 + 画布红圈 + 定位首个问题；通过则落盘——撞名拒绝（`currentId` 一致=更新当前模板；ID 变更时「保存」禁用、仅「另存为」），落盘后同步编译 `~/.dsh/skills/<id>/` 三件套（save 即闭环）。
  - 画布 / JSON 双 tab 实时互同步；变更后防抖实时校验状态行。
- **运行看板**：输入 runId 自动轮询 `vwf.state`，画布染色 + Agent 表 + 日志（保留 pkg-19 能力）。

## 运行方式

正式执行路径适用于所有部署：

1. 在编辑器中打开或保存工作流，点「获取脚本」，由 `vwf.script` 把 DSL 图编译成脚本。
2. 把脚本交给平台内置 `workflow` 工具执行；运行回执中的 runId 可用于运行看板轮询状态。

`wf_run` 是条件注册的增强路径：仅在宿主 `agents` 可用时注册，可直接完成 DSL 编译与执行。
`workflowEngine` 推迟到 execute 阶段解析；若解析失败，工具会明确报错，此时改用上述
「获取脚本 → 平台 `workflow` 工具」路径即可。

## RPC 面（host 半）

| RPC | 说明 |
|---|---|
| `vwf.workflows.list / save / remove` | 模板库 CRUD：双根加载（内置 `.generated/` 只读 + 用户 `~/.dsh/visual-workflow/templates/` 可写）；save 撞名拒绝 + 同步编译 skill（save 即闭环）；remove 仅用户 + 同步删 skill |
| `vwf.validate` | 统一校验管道（T-IMP-13）：sanitize → 逆投影蓝图 → 校验内核 validateBlueprint（含业务规则层与 requireModels），返回 `{ok, errors, fieldErrors, sanitized, warnings}`（fieldErrors 键形如 `node:<id>:<field>` / `edge:<i>:<field>` / `control:<field>`） |
| `vwf.script` | 统一编译器管道（T-IMP-12）：DSL → `scripts/generate.mjs compileBlueprint` 译文（CLI 兜底），返回脚本全文、meta 与 engineAvailable。`vwf.compile` 已随统一编译器删除 |
| `vwf.state` | 运行状态（runId → status/phase/agents/logs） |
| `vwf.models` | 对接 DSH 宿主 `llm` 服务的 provider/model 列表（编辑器的 Agent/模型下拉数据源） |
| `vwf.roles` | 读取工作区 `dsh/roles/*.md`（`fs` 服务，多形态兜底；不可用回退内置六角色） |

## 测试

```bash
cd packages/dsh-visual-workflow
npm install --cache <本地缓存目录>   # prepare 会重建 dist
npm test                              # host + client 冒烟 + 静态 bundle + dist 新鲜度
bash verify.sh                        # Gate1–4：版本对齐 + 构建 + 新鲜度 + 包测试
```

## 版本策略（dsh-tools ↔ 宿主）

- 插件 `@deepseek-ai/dsh-tools` **固定 `0.1.1-rc.2`**，与本地/官方最新宿主 **DSH v0.1.1-rc.2** 对齐（npm dist-tag `next`）。
- 用途仅限静态 bundle 的 `defineTool` 兜底（动态模式走 `harness.defineTool`）。`defineTool` 工厂签名自 rc.7 / rc.8 / 0.1.1-rc.2 保持兼容。
- Minke 0.2.0 宿主本体仍内嵌 `dsh-tools@0.1.0-rc.8`。插件不再把 rc.7 混入 rc.8/0.1.1 宿主闭包；静态模式用本包自己的 0.1.1-rc.2 副本整形工具对象，再经 `ctx.tools.register` 交给宿主。
- 改 `src/` 后若未 `npm run build`，`npm run check:dist` / `verify.sh` / 包测试会失败，避免再出现 issue-33 的过期 `dist/host-entry.mjs`。

## 与 pkg-19 的主要差异

- 校验规则全面升级为 Gold-Band《工作流编辑器》保存校验的同构集（入口拓扑唯一性 / $end 必须 / 悬空与不可达 / 保留 id / 成功表达式路径必须落在 output.schema 内 / failure 唯一 / 多 success 全带 when / success 环检测），并新增 `fieldErrors` 供面板逐字段标红。
- 编辑器从「表单式 + 点击连线」重构为 Gold-Band 的「画布 + 右侧配置面板」形态：把手拖拽连线、右键菜单、边/节点双配置面板、结果判定三态、schema 2s 防抖 + 美化、保存校验弹窗 + 定位、画布/JSON 双 tab。
- 宿主形态：模板库列表 + 右侧大抽屉（对应 Gold-Band 的 Sheet 抽屉）。
- 保留：`wf_run` 工具、编译产物、运行看板、`vwf.models`（DSH llm 服务对接）。

## 已知限制与后续（P2 依赖项）

- 持久化已落地（用户模板 `~/.dsh/visual-workflow/templates/` + skill 同步 `~/.dsh/skills/`），不再依赖 P2 的 storageDomain 方案（specs/vwf-p2 D3）。
- 插件 DSL 无 `$new-round` / `session` / `max_attempts` 概念，右击菜单仅「添加结束节点」（详见迁移报告）。
- 动态包无法 `import` 宿主 ui-primitives（运行时会话约束），编辑器使用 DSH shell 的 CSS 变量体系（`--dsw-alias-*`）实现原生观感。
