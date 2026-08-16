---
name: workflow-manager
description: "管理 gold-band 的开发工作流：新建、修改、注册、校验工作流模板，以及配套的角色文件管理。当用户要新建工作流、修改工作流节点配置（换 Agent/模型/权限模式/思考强度）、注册模板到用户级模板库、排查工作流启动报错（如权限模式不属于当前 Agent、ACP session does not expose config option、工作流列表为空）、或维护角色文件与工作流的引用一致性时使用。即使只是说『改一下工作流』『加个节点』『换个模型』『配一下思考强度』也要主动使用本 skill。"
---

# Workflow Manager — gold-band 工作流与角色管理

管理 gold-band 桌面端的工作流模板（新建/修改/注册/校验）和配套角色文件，保证模板可被桌面端正常加载、启动不报错。

## 核心文件位置

| 内容 | 路径 | 说明 |
|------|------|------|
| 用户级模板库 | `~/.gold-band/context/workflows.json` | 桌面端实际读取的模板列表，**改这里才生效** |
| 项目文档副本 | `<repo>/docs/gold-band/开发计划/工作流模板/*.json` | 便于版本管理与团队共享，需与用户级库保持同步 |
| 用户级角色库 | `~/.gold-band/context/profiles/*.md` | 工作流节点引用的角色定义 |
| Agent 诊断 | `~/.gold-band/desktop/agent-diagnostics.json` | 各 Agent 可用状态、模型列表、权限模式列表 |
| 设计文档 | `<repo>/docs/gold-band/开发计划/开发工作流优化设计.md` | 工作流设计说明，修改工作流后需同步维护 |

## 工作流模板结构（WorkflowDsl）

模板 JSON 包含：`version`、`id`、`entry`（入口节点）、`control`（`max_attempts` 打回上限 / `max_rounds` 轮次上限）、`nodes`、`edges`。

节点（worker）字段：`id`、`provider`（Agent）、`model`、`profile`（角色 id）、`goal`（任务说明）、`output`（AI 输出验证）、`success_condition`（成功条件）、`permission_mode`（权限模式）、`manual_check`（人工确认）、`config_options`（思考强度等微调项，**参数名因引擎而异**：kimi 用 `thinking`、claude 用 `effort`、cursor 用 `reasoning_effort`，详见下文「思考强度参数」）。

边字段：`from`、`to`（节点 / `$end` / `$new-round`）、`on`（success / failure）、`session`（new / continue）。

## 新建工作流模板

### 1. 设计拓扑

按业务需求设计节点与边，遵循 gold-band DSL 约束（见下文校验清单）。参考本仓库既有模板：`docs/gold-band/开发计划/工作流模板/dev-workflow-2.0.json`。

### 2. 创建配套角色文件

每个 worker 节点需要绑定一个角色（profile）。角色文件放 `~/.gold-band/context/profiles/`，格式：

```markdown
---
id: <唯一角色id，如 pf2-dev>
name: <显示名>
summary: <一句话摘要>
summarySource: workflow-generated
createdAt: 2026-08-15 00:00:00
updatedAt: 2026-08-15 00:00:00
dynamicTemplate: false
---
<角色正文：定位 / 工作流程 / 产出 / 判定标准 / 硬规则>
```

- 角色正文参考内置角色风格（`<repo>/src/prompts/zh-CN/profile/` 下的 dev/review/test 等，五段式：定位→流程→产出→判定标准→硬规则）。
- 产出命名统一 `*-report.md`（dev-report / test-report / review-report / accept-report / cleanup-report），验收节点额外产出通俗版 `acceptance-summary.md`。
- 职责相近的节点可共用角色（如调度与分流）。

### 3. 校验 DSL 合法性

用 gold-band 项目的真实校验逻辑验证（最可靠，不要只靠肉眼）：

```rust
// 在 tests/ 下写临时测试，或用项目内已有校验函数
let wf: WorkflowDsl = serde_json::from_str(&content)?;
gold_band::dsl::validate_workflow(wf)?;  // 全量业务校验
```

必须满足的约束清单：
- `entry` 存在且可达；所有节点从 entry 可达；至少一条边指向 `$end`。
- 边目标必须是真实节点 / `$end` / `$new-round`；`on` 只接受 success/failure。
- 同一来源节点的同一结果类型只能有一条出边。
- `success_condition` 必须搭配 JSON `output`；`manual_check=true` 与 `output`/`success_condition` 互斥。
- `session=continue` 只能指向真实 worker 节点。
- `control.max_attempts` / `max_rounds` 省略或正整数。
- `to="$new-round"` 必须声明 `new_round_entry`。

### 4. 注册到用户级模板库

**关键坑**：模板条目必须包含五个字段——`id`、`name`、`workflow`、`createdAt`、`updatedAt`。缺 `createdAt`/`updatedAt` 会导致**整个模板库反序列化失败，桌面端工作流列表为空**。

```python
import json
store = json.load(open("~/.gold-band/context/workflows.json"))
# 检查 id 是否已存在，避免重复
if not any(t["id"] == new_id for t in store["templates"]):
    store["templates"].append({
        "id": new_id, "name": display_name,
        "workflow": wf,
        "createdAt": f"{int(time.time())}Z",  # 时间戳格式：Unix秒+Z
        "updatedAt": f"{int(time.time())}Z",
    })
json.dump(store, open("~/.gold-band/context/workflows.json", "w"), ensure_ascii=False, indent=2)
```

写完后必须验证：JSON 可解析 + 每个模板条目五个字段齐全（可用 Python 脚本检查，或用项目真实反序列化逻辑跑一次）。

### 5. 同步项目文档副本 + 设计文档

- 复制模板 JSON 到 `<repo>/docs/gold-band/开发计划/工作流模板/`。
- 更新 `开发工作流优化设计.md`：节点职责表、角色清单、使用步骤、附录结构说明。

## 修改工作流（换 Agent / 模型 / 权限）

### 换 Agent 必须四件套联动

改节点 Agent 时，**provider、model、permission_mode、config_options 要一起改**，只改一个会启动报错。

Agent 权限模式对照（各 Agent 支持列表可从 `agent-diagnostics.json` 的 capabilities.modes 读取）：

| Agent | 权限模式 | 备注 |
|-------|----------|------|
| claude | bypassPermissions | 全权限 |
| cursor | agent | 自动执行（另有 plan / ask） |
| kimi | yolo | 全权限 |
| codex | agent-full-access | 全权限 |

**常见坑**：只把 provider/model 换成新 Agent，permission_mode 沿用旧值 → 启动报「权限模式不属于当前 Agent」。例如 kimi 节点配 `bypassPermissions`（claude 系）或 `agent-full-access`（codex 系）都会报错，必须改为 `yolo`；cursor 节点必须用 `agent`。

### 模型确认

改 model 前先确认该 Agent 有该模型：读 `agent-diagnostics.json` 的 `capabilities.models.availableModels`，取 `modelId`。模型名带参数后缀（如 `glm-5.2[reasoning=high]`、`kimi-code/k3`）。

### 思考强度参数（config_options 的坑中之坑）

**这是 2026-08 实战踩出的高概率启动报错**：节点 `config_options` 里的「思考强度」参数，**名字因引擎不同而不同**，不能统一用 `reasoning_effort`。把错误的参数名填给某个引擎，会话启动时直接报 `ACP session does not expose config option <参数名>`，第一个用到该引擎的节点即硬失败。

实测映射（取自真实任务运行快照，非设计文档推测）：

| 引擎 | 思考强度参数名 | 合法档位（示例） |
|------|----------------|------------------|
| kimi | `thinking` | low / high / max |
| claude | `effort` | default / low / medium / high / xhigh / max |
| cursor | `reasoning_effort` | low / medium / high 等 |

实战翻车案例：dev-workflow-2.0 把所有节点（含 kimi、claude）的 `config_options` 都填了 `reasoning_effort` —— 而 kimi 不认它（要 `thinking`）、claude 也不认它（要 `effort`），于是调度（kimi）节点启动即报「does not expose config option reasoning_effort」。之前两次跑成功，恰是因为那时根本没填思考强度，各引擎走默认档。

**可靠做法（不要猜，从真实快照核对）**：
- 想确认某引擎到底暴露哪个思考强度参数、合法档位是啥，直接读该引擎节点的真实快照：`~/.gold-band/projects/<project>/tasks/<task>/runs/<run>/rounds/round-001/nodes/<节点名>/attempt-001/acp.snapshot.json`，看 `configOptions[].id`（参数名）和 `.options[]`（合法档位）。
- 不要只凭设计文档或直觉填参数名——不同引擎、不同引擎版本暴露的参数名可能变化，以运行时快照为准。
- 未暴露该参数的引擎节点，留空（不写思考强度）即可正常跑，引擎走默认档。

**修正脚本要点（蛇形命名！）**：`workflows.json` 节点字段是 `config_options`（蛇形），不是 `configOptions`（驼峰）。解析时键名写错会导致读不到、反而把配置清空——改完必须回读校验每个节点的 `config_options` 是否如预期。

### 结构化产物契约（messageId）—— kimi 的第二个不兼容点

**这是 2026-08 实战踩出的运行期硬失败，比思考强度更严重**：当某个节点定义了 `output`（结构化产物，如 `kind=json, artifact=dispatch-result`），Gold Band 会强制走「产物内联（InlineControl）」收尾回合，要求引擎把文本**带「消息身份证」`messageId` 回传**，才能锁定这份结构化产物。

实测引擎差异（取自真实运行时间线快照）：

| 引擎 | 是否回传 `messageId` | 能否跑「结构化产物节点」 |
|------|----------------------|--------------------------|
| claude | ✅ 回传 `agent_message_chunk` + `messageId` | 能 |
| cursor | ✅ 回传 | 能 |
| kimi | ❌ 只按事件 id 回传（`assistant-message-<eventId>`），**无 `messageId`、无 `providerHistoryItemId`** | **不能** |

kimi 在回传助手文本时根本不带 `messageId`，于是它的产物被判定为「匿名文本」→ 节点报 `ACP artifact prompt produced only agent output without messageId`（错误码 `acp.unidentified-agent-output`，恢复模式 `Manual`，不会自动重试）→ 整个工作流卡死。

**触发条件**：节点同时满足 ① `provider=kimi`（或任何不回传 messageId 的引擎）② 定义了 `output` 结构化产物。dev-workflow-2.0 的 调度/分流/测试/审核 四个 kimi 节点全部带 JSON 产物 → 全部会在该节点失败（最先卡在调度）。

**为什么之前 kimi 能跑成功**：之前跑过的 kimi 节点没有定义 `output` 产物，走的是「对话式（PostTurnProjection）」模式，不强制 messageId，所以正常。给 kimi 节点加上结构化产物，才暴露这个不兼容。

**修复选项**（按推荐度）：
- 🟢 **A（不动代码，立即跑通）**：把这 4 个 kimi 产物节点换成 claude-acp / cursor（它们回传 messageId）。代价是失去 kimi 的速度/成本优势；若只想保住 kimi 写代码，至少把「门禁类」节点（调度/分流/审核）换掉。
- 🟡 **B（不动代码，保留 kimi）**：删掉这 4 个 kimi 节点的 `output` 产物定义，退回对话式模式。代价是丢失机器可读的结构化闸门（如 `success_condition: $.complete == true` 的自动放行逻辑失效）。
- 🔴 **C（根治，需改 Gold Band 代码）**：让产物识别逻辑接纳 kimi 的事件 id 身份（`assistant-message-<eventId>` 已是会话内稳定身份），或按适配器能力放宽 messageId 强约束。一次性修好所有 kimi 产物节点，与思考强度自动跳过的哲学一致。

**诊断铁证位置**：`~/.gold-band/projects/<project>/tasks/<task>/runs/<run>/rounds/round-001/nodes/<失败节点>/attempt-001/acp.diagnostics.jsonl`（含 `code: acp.unidentified-agent-output`）；`acp.timeline.jsonl` 可直接看到 kimi 的 `textDelta` 条目无 `messageId` 字段。

### 角色引用一致性

改 Agent 不影响角色文件（角色是提示词，Agent 是执行者），但要检查角色正文中的硬规则是否仍成立（如「审核与开发异源异模型」——若审核与开发换成同一 Agent，该硬规则就失效了，需在回复中提醒用户）。

### 修改后验证

同新建流程第 3/4 步：校验 DSL + 确认模板库可解析 + 权限模式与 Agent 匹配（写临时测试用项目逻辑验证）。

## 排查启动报错

按以下顺序定位：

1. **看任务 run 记录**：`~/.gold-band/projects/<project>/tasks/<task>/runs/<run>/run.json` 的 `status` / `pause_reason` / `error` 字段；节点目录下 `acp.diagnostics.jsonl` 尾部有底层调用错误。
2. **看桌面端日志**：`~/.gold-band/logs/runtime.log`，搜 `error` / `panic` / `failed`。
3. **Agent 不可用**：`agent-diagnostics.json` 的 `available` 字段（检查时间戳是否新鲜，>5 分钟需以实际调用为准）。
4. **模板加载失败（列表为空）**：检查模板条目五字段是否齐全（最可能缺 createdAt/updatedAt）。
5. **权限模式不匹配**：报「权限模式不属于当前 Agent」→ 按上文对照表修正。

常见报错速查：

| 报错 | 根因 | 处理 |
|------|------|------|
| 权限模式不属于当前 Agent | 换 Agent 没同步权限模式 | 按对照表改 permission_mode |
| ACP session does not expose config option <参数名> | 节点 `config_options` 填了某引擎不认识的参数（最典型：思考强度用了错误名字，如给 kimi/claude 填 `reasoning_effort`） | 按「思考强度参数」映射表改成该引擎正确的参数名；不留空也能跑（走默认档） |
| 工作流列表为空 | 模板条目缺 createdAt/updatedAt | 补全五字段 |
| usage limit exceeded | Agent 额度耗尽 | 换 Agent（四件套联动） |
| paused / runtime-abnormal | 运行异常，看诊断日志定位 | 查 acp.diagnostics.jsonl |

## 通用原则

- **先确认再改动**：改用户级模板库前先备份（`cp workflows.json workflows.json.bak-<date>`）。
- **运行中任务不受影响**：任务启动时冻结工作流快照，改模板不影响已运行的 run；但旧快照仍用旧 Agent 配置，若旧 Agent 不可用任务会卡住，需提示用户。
- **改完必须验证**：模板 JSON 可解析 + 字段齐全 + 权限匹配 + DSL 合法，四步缺一不可。
- **文档同步**：每次修改工作流/角色，同步维护 `<repo>/docs/gold-band/开发计划/` 下对应文档。
