# Repository Guidelines（仓库指南）

## 项目结构与模块组织

- `templates/` 存放工作流蓝图，是项目唯一的事实来源。
- `scripts/` 存放生成、校验、运行排练和测试相关内容。
- `packages/dsh-visual-workflow/` 存放可视化工作流插件：`src/` 为运行内容，`tests/` 为测试，`docs/` 为迁移说明。
- `dsh/` 存放角色说明、技能和安装脚本。
- `docs/design/` 与 `docs/research/` 存放设计契约和研究资料；`wayfinder/` 存放决策与任务记录。
- `.generated/` 是自动生成的结果目录，已被 Git 忽略。禁止直接修改；应先修改蓝图，再重新生成。

## 构建、测试与开发命令

以下命令均在仓库根目录执行：

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

## Codex PR Review 收敛规则

本节约束所有能够在 GitHub PR 上触发 Codex Review 的 Agent；它独立于本地工作流、Run 和回退额度。目标是让 PR 审查围绕当前 Issue 的完成条件收敛，并把 **Codex PR Review Controller 作为 Agent 的唯一 Review 入口**，禁止通过直接 `@codex review` 或无限追加轮次把一个 PR 扩张成无边界的持续改进任务。

- Agent **不得直接发表评论 `@codex review`**。所有由 Agent 发起的 Codex PR Review 必须通过 PR 评论命令 `/codex-review next` 进入 Controller；Controller 负责轮次、HEAD 去重、提示词和额度状态。
- **Round 1 是正式 PR 的强制 Gate。** 对所有由 Agent 负责、准备合并到 `main` 的非 Draft PR，PR 创建后或 Draft 转为 Ready 后，Agent 必须先检查 PR 时间线是否已有 Codex PR Review Controller 状态；若尚无成功的 Controller Review 记录，必须立即执行 `/codex-review next` 发起第 1 轮完整审查。内部工作流的 Review/Test、CI、人工检查均不能替代这一 PR Gate；未完成至少 1 轮 Controller Codex Review 的 PR，Agent 不得宣布可合并、进入收口或主动结束该 PR 任务。
- 一个 PR 默认最多允许 **3 轮自动 Codex Review**。服务报错、超时或明确的工具故障只能使用 `/codex-review retry` 重试；retry 仅限同一 HEAD 的服务/工具故障，不得借 retry 绕过业务轮次。
- 第 1 轮是完整审查：Controller 应围绕当前 PR 的需求符合性、正确性、回归风险、证据与必要边界条件发起审查。
- 每条 Review 意见都必须先分类再处理：
  - **A · 当前阻塞**：当前 Issue 验收条件未满足、当前 PR 引入的回归、会导致当前交付明显不正确或不安全的问题。本 PR 必须修复。
  - **B · 后续事项**：问题成立，但属于历史问题、额外增强、需要扩大范围才能解决，或不影响当前 Issue 完成。登记独立 Issue / backlog，本 PR 不继续扩张。
  - **C · 不采纳**：偏好型建议、收益不足、与当前目标无关或判断不成立。说明理由后结束该意见。
- 第 2、3 轮属于**收敛审查**。Agent 修复本轮 A 类问题并产生新的 PR HEAD 后，只能再次执行 `/codex-review next`；不得自行拼接或直接发送新的 `@codex review` 指令。Controller 分别负责第 2 轮“验证上一轮 A 类修复 + 本轮新阻塞”和第 3 轮“只看当前验收失败/明显回归/合并前阻塞”的收敛提示词。
- 同一 HEAD 上重复执行 `/codex-review next` 应被拒绝。若上一轮只是 Codex 服务/工具故障，使用 `/codex-review retry`；若是业务 Review 已完成，则必须先处理 A 类问题并形成新 HEAD，才能进入下一轮。
- **任何 Agent 都不得自行追加 Review 额度。** 当默认 3 轮耗尽后，Agent 必须停止自动 Review 与自动扩大修改，向人工呈递：剩余 A 类阻塞、已完成验证、继续 Review 的收益/风险，以及可选命令 `/codex-review extend 1 <明确原因>`；Agent 本身不得执行该 extend 命令。
- `/codex-review extend 1 <明确原因>` 是人工决策命令。人工追加后只增加 **1 轮有限额度**，且追加动作本身不得自动触发 Review；Agent 只能围绕人工允许继续解决的具体阻塞项修改并形成新 HEAD，随后再使用 `/codex-review next`。
- 第 3 轮后若已无 A 类阻塞项，且当前 Issue 验收条件、测试和仓库质量门均满足，应进入收口/合并，不得以“Codex 可能还能找到更多建议”为理由继续审查。
- 如果 PR 时间线出现**未由 Controller 触发的 Codex Review**（例如人工直接 `@codex review`、仓库原生自动 Review 或其他旁路），Agent 不得据此自动开启新一轮修复→Review 循环，也不得用它自行增加 Controller 额度；应先按 A/B/C 分类当前意见，并把旁路事件报告为治理异常。是否追加正式 Controller 轮次由现有额度和人工决策决定。
- PR 的完成标准是：**当前 Issue 定义的问题已解决、验收条件满足、必要验证通过、没有已知的当前范围阻塞项。** “Codex 再也提不出新建议”不是完成标准。

## 配置与安全

不要提交凭据、本地 DSH 状态、`.agent-runs/`、`.scratch/`、`node_modules/` 或自动生成的结果。出现不一致时，以 `templates/` 和已记录的项目契约为准。