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
  激活插件，插件注册名必须带 Run 命名空间前缀（口径权威：约定文档 §决策六；命令序列见
  `docs/runbooks/construction-dsh/runbook.md` §0/§6）。
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

## 任务归属记录（agent 身份）

仓库要求「**谁提交的就记谁**」：任务登记册的 `origin_agent` 与施工认领身份必须反映**真实执行会话的 agent**，而不是人工手填的名字。身份解析统一走 `agentName()`（`scripts/local-task-registry.mjs`），取值顺序为：① `AI_AGENT_NAME` 显式覆盖 → ② `CLIENT_INFO_IDE_TYPE` 宿主自报 → ③ 任何 `*_AGENT_NAME` 变量 → ④ 仓库根 `.agent-identity`（本机标记，已被 Git 忽略）→ ⑤ 取不到则返回 null。

- **不允许静默留空**：`allocate` 在取不到身份时必须在 stderr 显式告警。若你在输出里看到该告警，应让当前会话自报身份（设置任一 `*_AGENT_NAME` 环境变量）或写入 `.agent-identity` 后重跑，不要直接接受一条无归属的记录。
- **不允许手写身份**：不得用 `set` / `update` 把 `origin_agent` 改成无法由环境事实佐证的名字——那等于伪造留痕。
- 同一台机器上所有 agent 的 `machineCode()` 相同，**机器码无法区分 agent**，因此 `origin_agent` 是单机多会话并行时唯一的区分依据，必须被正确填充。

## 仓库级 PR 审查规则（Multica「PR 审查」Agent）

本节适用于由 Agent 负责、准备合入 `main` 的 PR。唯一仓库级审查入口是 Multica 中现有的「PR 审查」Agent（ID：`c895067b-44bf-4fb9-bc64-af7a7cccb4a8`）。审查 Agent 必须与实施 Agent 不同；若身份相同，暂停派发并交项目负责人处理，严禁自审。Draft PR 也可审查；审查 Agent 只读审查，不改码、不合并，也不提交 GitHub 的正式 `APPROVE` / `REQUEST_CHANGES` Review 状态。它在 Multica 审核 Task 和 GitHub PR 普通评论中发布同一份报告。该报告是审查证据，不代替用户验收、GitHub 正式 approval 或其他仓库保护规则。

### 创建并派发审核 Task

每个审查轮次使用一个明确关联交付 Task 的 Multica 子 Task。Task 描述必须包含：交付 Task、仓库、PR URL、base 分支及 SHA、待审的完整 head SHA、当前交付的验收条件、审查范围和只读约束。先运行 `multica issue children <delivery-task-id> --output json`，查找同一 PR/head 是否已有审核 Task；对匹配 Task 读取 `multica issue get <review-task-id> --output json` 及其评论，确认负责人和报告，避免重复派发或重复审查。

若当前 PR/head 尚无已完成报告：先在交付 Task 所属项目中创建一个**未指派、`backlog`** 状态的子 Task（在当前工作目录写 `./pr-review-task.md` 作为完整描述文件）：

```bash
multica issue create --title "PR review: <delivery-key> PR #<number> round <N> (<short-head>)" --description-file ./pr-review-task.md --parent <delivery-task-id> --project <project-id> --status backlog --output json
```

然后读取新 Task，并扫描其评论，确认关联信息完整、尚未有人接手；之后按顺序指派并显式派发，不能把指派描述成 GitHub 强制 Gate：

```bash
multica issue get <review-task-id> --output json
multica issue comment list <review-task-id> --roots-only --summary --compact --output json
multica issue assign <review-task-id> --to-id c895067b-44bf-4fb9-bc64-af7a7cccb4a8
multica issue status <review-task-id> todo
```

使用 `multica issue pull-requests <delivery-task-id> --output json` 回读链接状态。PR 标题应含交付 Task 的可路由 key（例如 `WFM-120: ...`）；不要仅在 PR 正文裸写 key 来期待自动关联，也不要用 `Closes` 让审查 PR 意外关闭交付 Task。

### 审查、去重与有限复审

- 审查开始和发布报告前都核对 PR 实际 head SHA。报告必须写完整 SHA；head 在审查中或发布前变化时，报告记为 `BLOCKED`，不得用它放行。
- 对同一 PR 和同一完整 head SHA，只审查、发布一份报告。已有报告时不重跑；若双通道有一处缺失，只将已有报告原文补到缺少的通道，不创建重复轮次。head 改变后，旧报告不能作为当前版本的放行凭据；为新 head 建新的子 Task，保留轮次记录。
- 结论只能是 `APPROVE`、`REQUEST_CHANGES` 或 `BLOCKED`。每条意见按以下分类：**A · 当前阻塞**：未满足当前验收、引入回归或明显不正确/不安全，必须修复；**B · 后续事项**：问题成立但属历史问题、额外增强或需扩大范围，移到独立 Task/backlog；**C · 不采纳**：偏好、收益不足、不相关或判断不成立，说明理由。
- 每份报告在 Multica Task 和 PR 普通评论中原文一致，至少包含结论、PR URL、base SHA、reviewed head SHA、A/B/C 项及理由、审查范围/局限和必要验证。不得把普通评论称作 GitHub 正式 approval。
- 每个 PR 最多 3 轮常规报告。第三轮后若无 A 类阻塞且交付验收、必要测试和 CI 均满足，进入收口；若仍有 A 类阻塞，停止派发并呈递人工：阻塞项、已完成验证、继续审查的收益/风险及建议范围。仅人工明确授权时可追加**最后 1 轮**，总上限为 4 轮；授权必须说明理由及允许处理的阻塞/范围。Agent 不得自行追加额度，不能再申请第五轮。

### 合并前人工核对

合并前由交付负责人核对当前 Issue 验收、相称的测试与当前 head 的 CI、用户授权和 GitHub PR 的真实状态，并确认：报告双通道均可读且内容一致、结论为 `APPROVE`、报告中的完整 head SHA 等于 PR 当前 head、没有未解决的 A 类阻塞。任何一项缺失、阻塞或发生 head 漂移都必须停止合并并按上述规则复审。此流程依赖 Task/人员核对，**不是 Multica 服务端原子门禁，也不是 GitHub Ruleset 自动强制**。

## 配置与安全

不要提交凭据、本地 DSH 状态、`.agent-runs/`、`.scratch/`、`node_modules/` 或自动生成的结果。出现不一致时，应按“权威资料与 Current / Target 边界”判断对应事实来源；不得笼统以 `templates/` 覆盖长期原则、目标规格或实际 main 状态。
