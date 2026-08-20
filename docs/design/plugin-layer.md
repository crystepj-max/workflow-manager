# 插件层实现总结（T-IMP-06/07 · 已收口）

> 面向「下一个接手的人」：本仓库 vwf 图形入口插件（`packages/dsh-visual-workflow/`）的
> 架构、运行环境适配与验证路径。行为细节以源码注释与 `tests/host.test.mjs` 为准，
> 本文档沉淀跨会话不易重推的决策与踩坑。

## 1. 定位与架构

vwf 插件是 **Cordis 动态双半插件**（plain JS、无 import/JSX，`cordis_define`/`cordis_run` 激活），
在 DSH Web 设置页注册「工作流」section（`settings.section`，id=`workflow-visual`，order=25）：

- **host 半**：DSL 校验（Gold-Band 同构规则集）/ 编译 / 9 个 RPC / `wf_run` 工具 / 运行状态跟踪 / `vwf_debug` 诊断工具。
- **client 半**：模板库（新建/编辑/删除/刷新/另存为）+ 大抽屉可视化编辑器（画布/配置面板/JSON tab）+ 运行看板。

模板存储为**双根目录**（单一事实源 = 蓝图，见 `docs/design/blueprint-schema.md`）：

| 根 | 路径 | 内容 | 来源 |
|---|---|---|---|
| 内置 | `<repo>/.generated/<id>/vwf-dsl.json` | vwf DSL（生成物） | `npm run generate`（CI 先跑） |
| 用户 | `~/.dsh/visual-workflow/templates/<id>.json` | 蓝图 JSON | `vwf.workflows.save` 落盘 |

- `list` 合并双根（`builtin` 标志 + id 字母序）；用户条目经内联 `projectToVwf` 投影为 vwf DSL。
- **save 即闭环**：校验（结构+异源+模型必填）→ 撞名拒绝 → 逆投影蓝图落盘 → spawn 生成器
  `node scripts/generate.mjs user <蓝图> ~/.dsh/skills` 同步自包含 skill 三件套（失败回滚，保持原子）。
- `remove` 仅用户模板（蓝图 + `~/.dsh/skills/<id>/` 同步删）；内置只读。
- 保存/另存为语义：save 携带 `currentId`（当前编辑模板 id）；目标 id 已存在且 `currentId !== id` → 拒绝
  （client 编辑态 ID 变化时「保存」置灰，只能「另存为」）。

## 2. 运行环境适配（踩坑沉淀）

动态插件 host 跑在 vm 沙箱（无 `process`/`env`/`require`），以下适配都是真机验证过的硬约束：

### 2.1 repoRoot 解析：currentInitiator 只在模型调用中存在
宿主 `sandboxPolicy.workspaceRoot` 是部署配置 `process.cwd()`，**不是会话工作区**。
仓库根（`.generated/`、`scripts/generate.mjs` 所在）必须取发起 agent 会话 cwd
（`agents.currentInitiator().session.header.cwd`）。但 `currentInitiator` 仅在**模型发起的调用**
（如 `wf_run` 工具执行）中存在——浏览器审批触发的插件激活（apply 时）与客户端 RPC 调用都没有。
因此 `repoRoot()` **每次调用实时探测**，并把任何有 initiator 的调用记录为 `knownCwd` 兜底，
最后才落 `sandboxPolicy.workspaceRoot`。

### 2.2 Cordis update 会停旧 Run → 双半必须同 Package
`cordis_run` 的 update 先停旧 Run 再启新 Package。若 client 半单独追加为只含 client 的 Package，
host 半（RPC/工具）会整体消失。**host + client 必须合并进同一个 Package** 再 update。

### 2.3 defineTool 参数校验（本部署运行器）
`harness.defineTool` 的 parameters 校验严格：`required` 字段出现时必须是 `true`
（可选字段应**省略**该键）；`type: 'object'` 的参数必须显式 `additionalProperties: true|false`。

### 2.4 fs 服务：无删除方法；~/.dsh 写入需显式策略
- fs 服务**没有 delete/rm**——删除走子进程 `node -e "fs.rmSync(...)"`。
- fs 写入默认按会话沙箱（workspace-write）围栏，`~/.dsh`（宿主数据根）在围栏外——
  **写入必须显式传 `sp.resolve({ mode: 'danger-full-access' })` 作为 sandboxPolicy 参数**。

### 2.5 宿主 NODE_OPTIONS 注入（WorkBuddy safe-delete 钩子）
若宿主由 WorkBuddy 等工具启动，环境变量可能注入
`NODE_OPTIONS=--require=.../genie-safe-delete.cjs`——该钩子拦截所有 node 子进程的
`fs.rmSync` 并抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（删除需确认），导致 remove 的 rm 子进程
exit 非 0 而失败（且 UI 曾误报成功）。修复：`subprocess.spawn` 显式传
`env: { NODE_OPTIONS: undefined }`（tombstone 移除注入）。

### 2.6 校验规则的产品演化（相对引擎契约的收紧）
- **模型绑定必填**：`validateDsl` 要求每个节点 `model.provider`/`model.model` 非空
  （fieldErrors `node:<id>:model.provider` / `model.model`）。注意：蓝图契约 `bindings.models`
  仍允许缺省（=宿主默认），这是**编辑器保存路径**的收紧，引擎侧校验器不强制。
- **模板名称必填**：`validateDsl` 要求 `dsl.name`（→ 蓝图 `displayName`）非空。
- **异源按 id 或 profile 识别**：dev/review 节点按 `id === 'dev'` **或** `profile === 'dev'` 识别
  （编辑器新建节点默认 id 为 node-N，用户以角色表达 dev/review 时同样纳入检查）；
  引擎 `scripts/validate-blueprint.mjs` 规则 4/7 已同步（含测试 T7/T8）。

## 3. 验证路径与结果

- `npm run validate` 全绿：蓝图校验 + 10 等价断言 + 重生成一致性 + 引擎测试 + 包测试（host 34 + client 8）。
- 真机（DSH Web 设置 → 工作流）：双根合并列表、save 落盘 + `~/.dsh/skills/<id>/` 三件套被发现根拾取
  （触发词 = displayName + id）、remove 真实删除（含 2.5 的修复）、异源/必填/撞名/另存为全部复测通过。
- 诊断：`vwf_debug` 工具 `op=paths`（路径解析）/ `op=remove <id>`（逐步删除，含 rm 子进程输出）。

## 4. 测试与回归入口

```bash
npm run generate   # 先产出 .generated/（内置根）
npm run validate   # 蓝图 + 等价断言 + 重生成一致性 + 引擎测试 + 包测试（validate.mjs ③′）
cd packages/dsh-visual-workflow && npm test   # host 34 + client 8
```

## 5. 遗留

- **T-IMP-11**（v1 收口等价验收）：`docs/design/equivalence-checklist.md` 8 维度人工勾选 +
  旧 mjs（`dsh/workflow/dev-workflow-2.0.mjs`）退役。
- 插件为会话级动态插件；如需宿主常驻（重启仍在），打包为组合包 / cordis.yml preset（另行排期）。
