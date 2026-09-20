# Repository Guidelines（仓库指南）

## 项目结构与模块组织

- `templates/` 存放当前 main 已实现的具体 Workflow Blueprint，是“当前已实现 Workflow 定义”的唯一事实来源；它不代表尚未完成的版本目标规格。
- `scripts/` 存放生成、校验、运行排练、测试，以及建设工作流证据记录与校验相关内容。
- `packages/dsh-visual-workflow/` 存放可视化工作流插件：`src/` 为运行内容，`tests/` 为测试，`docs/` 为迁移说明。
- `dsh/` 存放角色说明、Skill、安装脚本，以及建设工作流 Bootstrap / Dogfood 相关资产。
- `docs/design/` 与 `docs/research/` 存放设计契约、长期设计原则、当前版本目标规格和研究资料；`specs/` 存放正式规格 / OpenSpec；`wayfinder/` 存放决策与任务记录。
- `.generated/` 是自动生成的结果目录，已被 Git 忽略。禁止直接修改；应先修改蓝图，再重新生成。

### 权威资料与 Current / Target 边界

- `docs/design/workflow-design-principles.md` 是跨版本长期工作流设计原则的方法论权威。
- `docs/design/workflow-manager-v0.1-final-product-spec.md` 是当前 v0.1 的 Target（目标规格）权威；目标规格不等于 main 已经实现。
- Current（当前实现）以实际 `main` 为准；`CONTEXT.md` 描述当前实现术语与兼容语义，`templates/` 只定义当前已实现的具体 Workflow。
- `roadmap.md` 负责版本顺序、实施依赖和阶段主线，不替代产品规格，也不证明某项能力已经进入 main。
- GitHub Issue / PR 负责具体施工范围、迁移、验收和状态记录，不得反向覆盖长期原则、版本目标规格或已进入 main 的事实。
- 实施、Review 和验收必须明确自己是在维护 Current 兼容基线，还是实现 Target 目标规格；两者存在差异属于正常迁移状态，不得静默混用，也不得用当前旧定义否定目标规格，或把尚未完成的目标规格当成已上线能力。

## 构建、测试与开发命令

以下命令均在仓库根目录执行。

干净环境首次验证前使用 Node.js 24，并先在仓库根目录完成依赖安装；已有完整依赖环境时无需重复安装：

```bash
npm install
```

然后运行所需命令：

```bash
npm run generate   # 根据 templates/*.json 重新生成结果
npm test           # 运行核心与运行流程测试
npm run validate   # 校验蓝图、生成结果一致性和插件包测试
npm run dev:plugin # 检查隔离的 VWF 动态开发环境并给出同步指引
npm run release:verify # 运行发布前机器闸门
```

如需单独测试可视化工作流插件，先安装测试依赖，再运行专项测试：

```bash
cd packages/dsh-visual-workflow
npm install --cache <本地缓存目录>
npm test
```

## VWF 开发 / 产品双轨

- 版本内修改 `packages/dsh-visual-workflow/src/` 时，默认使用独立开发 DSH Home
  `~/.dsh-workflow-dev`。开发 DSH 可长期运行；不要为了每次界面或宿主调整重装正式组合包、
  重启产品 DSH，也不要把产品 `$DSH_HOME` 指给开发入口。
- 开发 DSH 是**唯一实例、端口固定 9527**（约定 §决策六）：建设 Run 的开发 DSH 操作走
  `npm run dev:plugin -- start --task <run_id>`（登记本任务为当前激活任务），收口先登记
  注销、再用 `scripts/cwf-env-recycle.mjs` 清本任务命名空间项；同一时刻只允许一个任务
  激活插件，插件注册名必须带 Run 命名空间前缀（详见 construction-bootstrap runbook §0/§7）。
- `npm run dev:plugin` 是开发环境状态检查与同步指引，不是保存即热同步器。动态更新必须在
  DSH 开发会话中使用公开的 Cordis 能力完成；一次开发版本必须同时包含当前 `src/host.js`
  与 `src/client.js`，禁止只更新其中一半。两种模式始终共用这一份 `src/`。
- 开发环境不得安装正式 `dsh-visual-workflow` 组合包，不自动复制凭据或产品配置。开发结束时
  应停止并清理动态插件；开发 DSH 重启后动态插件消失是正常行为。开发期间不得修改产品
  Profile 的插件安装状态。
- 动态开发态只用于快速反馈，**不是发布证据**。准备 PR / Release 前必须执行
  `npm run release:verify`，关闭开发 DSH，完整重启产品 DSH，并确认正式插件从真实安装路径
  加载后完成真实工作流 E2E 与本版本功能验收；机器闸门通过本身不等于 Release Ready。
- 产品模式验收失败时，候选版本立即失效：退回开发模式修改权威源码并验证，然后重新生成、
  重新执行机器闸门、重新启动产品 DSH、重新完成全部产品验收。禁止手改正式产物或沿用旧验收。

## 编码风格与命名约定

使用两个空格缩进，JavaScript 采用当前文件已有的模块写法，并保持周边代码风格。JSON 使用两个空格缩进。标识符使用清晰的小写命名，例如 `dev-workflow-2-0`；测试文件按被测试行为命名，例如 `runtime-host.test.mjs`。仓库没有统一的格式化或规范检查工具，因此应运行校验命令，并将改动严格限制在任务范围内。

## 测试指南

测试使用仓库现有的 Node 测试工具：单元测试和集成测试使用 `*.test.mjs`，客户端冒烟测试使用 `*.smoke.mjs`。可复用的输入案例放在 `scripts/test/fixtures/`。每次修改蓝图或生成规则后，都应运行 `npm run generate` 和 `npm run validate`；如果尚未检查生成结果一致性，不应仅凭单元测试通过就宣布完成。

## 提交与合并请求指南

提交信息使用项目历史中已有的简洁前缀：`feat:`、`fix:`、`docs:`；必要时添加范围，例如 `feat(workflow): ...`。每次提交只处理一个清晰主题。合并请求应说明对用户或工作流程的影响，列出已运行的校验命令，说明蓝图或生成结果是否受到影响，并关联对应任务或问题。修改可视化编辑器时，应附上截图或录屏。

## PR Review 收敛规则（Cursor Bugbot）

本节约束所有能够在 GitHub PR 上发起 PR 评审的 Agent；它独立于本地工作流、Run 和回退额度。评审引擎已从停用的 Codex 切换为 **Cursor Bugbot**，触发词为 `@cursor review`（等价别名 `bugbot run`；以 Cursor 设置页 Manual-Only 文案为准，由 Controller 用单一常量 `TRIGGER_COMMAND` 发出，公开文档另有不带 `@` 的 `cursor review` 写法，真实生效形式以冒烟为准）。目标是让 PR 审查围绕当前 Issue 的完成条件收敛，并把 **PR Review Controller 作为 Agent 的唯一 Review 入口**，禁止通过直接 `@cursor review` 评论或无限追加轮次把一个 PR 扩张成无边界的持续改进任务。

> 命令命名空间已于 2026-09-20 由历史的 `/codex-review` 改名为 `/pr-review`（DT-01 裁定 B）；旧命令 `/codex-review` 即刻失效、无兼容期，在途 PR 需改用 `/pr-review`。注意：脚本内部审计标记 `codex-review-controller-*` 与文件名 `scripts/codex-review-controller.mjs`、workflow 文件名仍保留旧名（非用户可见、改之会丢在途 PR 状态或增无谓 churn）。

- Agent **不得直接发表评论 `@cursor review`（或 `bugbot run`）**。所有由 Agent 发起的 PR 评审必须通过 PR 评论命令 `/pr-review next` 进入 Controller；Controller 负责轮次计数、HEAD 去重、额度状态，并以其触发身份发出触发评论。
- **仓库侧 Bugbot 配置基线（缺一即可能静默无响应或越权，须先核对再判定 Review 是否发生）**：Trigger Mode 保持 **Manual Only**（否则每次 push 自动评审会把无限循环带回）；**Autofix 保持 Off**（评审引擎只读——一旦自动改码并推送，会越过本仓库人工验收与推送授权边界）；**PR Summaries 建议关闭**（PR 描述是本仓库收口证据，不得由外部工具生成/改写）；已连接仓库、启用 Bugbot 并配好被接受的触发身份 Secret `PR_REVIEW_TRIGGER_TOKEN`（`github-actions[bot]` 身份能否被接受尚未官方确认，必要时用 fine-grained PAT）。若 `/pr-review next` 后 Bugbot 未真正开始评审，Agent 应把「评审未发生」报告为治理/配置阻塞并交人工，而不是自行重试或旁路触发。
- **Round 1 是正式 PR 的强制 Gate。** 对所有由 Agent 负责、准备合并到 `main` 的非 Draft PR，PR 创建后或 Draft 转为 Ready 后，Agent 必须先检查 PR 时间线是否已有 PR Review Controller 状态；若尚无成功的 Controller Review 记录，必须立即执行 `/pr-review next` 发起第 1 轮。仓库侧 Review Draft PRs 关闭，且 Manual 触发在 Draft 上能否生效尚待冒烟确认——Agent 须**先把 PR 转为 Ready 再申请 Review**，不得把 Draft 上「发了没反应」当成静默失败反复重试。内部工作流的 Review/Test、CI、人工检查均不能替代这一 PR Gate。若标准流程需要在 closeout 阶段创建 PR，可进入 closeout 完成 PR 创建与 Ready；但未完成至少 1 轮 Controller Review 前，Agent **不得合并 PR、不得宣布 closeout 完成，也不得结束该 PR 任务**。
- 一个 PR 默认最多允许 **3 轮自动 Review**。服务报错、超时或明确的工具故障只能使用 `/pr-review retry` 重试；retry 仅限同一 HEAD 的服务/工具故障，不得借 retry 绕过业务轮次。
- 轮次语义（轮次计数、去重、额度、可审计记录）仍由 Controller 承担；但 **评审聚焦口径改为常驻规则文件 `.cursor/BUGBOT.md`**——Bugbot 不接受单条触发评论里的临时提示词，因此原「第 1/2/3 轮差异化提示词」不再是给评审引擎的指令，Controller 只在 PR 中留轮次状态评论作审计。
- 每条 Review 意见都必须先分类再处理（该口径同时写进 `.cursor/BUGBOT.md` 供 Bugbot 执行，事实源以本节为准）：
  - **A · 当前阻塞**：当前 Issue 验收条件未满足、当前 PR 引入的回归、会导致当前交付明显不正确或不安全的问题。本 PR 必须修复。
  - **B · 后续事项**：问题成立，但属于历史问题、额外增强、需要扩大范围才能解决，或不影响当前 Issue 完成。登记独立 Issue / backlog，本 PR 不继续扩张。
  - **C · 不采纳**：偏好型建议、收益不足、与当前目标无关或判断不成立。说明理由后结束该意见。
- 第 2、3 轮属于**收敛审查**——「只看上次评审之后的新改动」由仓库级 **Incremental Review（On）** 天然承担，不在提示词或规则里重复要求，避免两套口径；分类聚焦纪律见 `.cursor/BUGBOT.md`。Agent 修复本轮 A 类问题并产生新的 PR HEAD 后，只能再次执行 `/pr-review next`；不得自行拼接或直接发送新的触发评论。
- 同一 HEAD 上重复执行 `/pr-review next` 应被拒绝。若上一轮只是 Bugbot 服务/工具故障，使用 `/pr-review retry`；若是业务 Review 已完成，则必须先处理 A 类问题并形成新 HEAD，才能进入下一轮。
- **任何 Agent 都不得自行追加 Review 额度。** 当默认 3 轮耗尽后，Agent 必须停止自动 Review 与自动扩大修改，向人工呈递：剩余 A 类阻塞、已完成验证、继续 Review 的收益/风险，以及可选命令 `/pr-review extend 1 <明确原因>`；Agent 本身不得执行该 extend 命令。
- `/pr-review extend 1 <明确原因>` 是人工决策命令。人工追加后只增加 **1 轮有限额度**，且追加动作本身不得自动触发 Review；Agent 只能围绕人工允许继续解决的具体阻塞项修改并形成新 HEAD，随后再使用 `/pr-review next`。
- 第 3 轮后若已无 A 类阻塞项，且当前 Issue 验收条件、测试和仓库质量门均满足，应进入收口/合并，不得以“Bugbot 可能还能找到更多建议”为理由继续审查。
- 如果 PR 时间线出现**未由 Controller 触发的 Bugbot 动作**（例如人工直接 `@cursor review`、仓库侧自动评审未关闭、Bugbot 改写了 PR 描述、或其他旁路），Agent 不得据此自动开启新一轮修复→Review 循环，也不得用它自行增加 Controller 额度；应先按 A/B/C 分类当前意见，并把旁路事件（含「自动评审未关闭」「PR 描述被外部改写」等配置异常）报告为治理异常。是否追加正式 Controller 轮次由现有额度和人工决策决定。
- PR 的完成标准是：**当前 Issue 定义的问题已解决、验收条件满足、必要验证通过、没有已知的当前范围阻塞项。** “Bugbot 再也提不出新建议”不是完成标准。

## 配置与安全

不要提交凭据、本地 DSH 状态、`.agent-runs/`、`.scratch/`、`node_modules/` 或自动生成的结果。出现不一致时，应按“权威资料与 Current / Target 边界”判断对应事实来源；不得笼统以 `templates/` 覆盖长期原则、目标规格或实际 main 状态。
