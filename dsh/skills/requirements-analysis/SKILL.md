---
name: requirements-analysis
description: "需求分析统一入口：把 GitHub issue、Multica Task、本地需求文档或会话输入加工成经人工确认的任务定义，包含基线、规格、依赖、Definition Check 和无人值守许可。workflow-manager 维护源码并直接分发用户级入口。当用户提出拆需求、拆任务、出规格、评估体量或任务定义时使用。"
---

# Requirements Analysis（需求分析）→ 任务定义

> **工程真源仓库**：`workflow-manager/dsh/skills/requirements-analysis/`（本目录）。workflow-manager 维护并直接安装用户级入口 `~/.agents/skills/requirements-analysis/`。Multica 是任务与状态平台，不是本技能的代码源。`execution-plan` 的项目级入口由 `dev-flow/.agents/skills/execution-plan/` 独立维护。

把一份原始输入（GitHub issue、Multica Task、本地文档，或会话中录入的自然语言）加工成**可审阅的需求基线**，经用户确认后把定义和依赖写入 Multica Task。Multica 是任务身份与状态的唯一来源；本 skill 不创建本地登记册、看板或临时状态副本。

本 skill 是**自洽的编排能力**：分诊、澄清、定体量、拆解、探路、Definition Check、基线确认与落档所需知识内联于此，**不通过 `skill` 工具调用任何子 skill**。

> **公共契约**：`references/public-task-contract.md`（Multica Task 状态与 `dev-flow.definition.v1` / `dev-flow.dependencies.v1` 元数据）。
> **为什么内联而不调用子 skill**：`triage` / `grill-with-docs` / `wayfinder` / `to-tickets` 是「仅限用户调用」的命令型 skill；本 skill 将等价知识内联。

## 成功标准

> 一个完全不了解前序讨论的执行者，只读取 Multica Task 的已确认定义与对应版本的本地规格，就能理解任务并开始施工，**无需再向用户询问任何会影响产品结果的问题**。

结束状态必须是：已确认基线和 Definition Check，并把定义元数据写入 Multica Task。未达门禁时 Task 留在 `backlog`，不得假装已定义。

---

## 流程

### 0. 输入识别（四类来源，命中即停）

先识别输入来源；需要新建 Task 时，确认 Multica CLI 已登录并取得目标项目 ID。若目标项目不明确，先向用户询问，因为它决定任务进入哪个工作区。

| 顺序 | 判定条件 | 识别为 | 接入方式 | 登记去向 |
|---|---|---|---|---|
| 1 | Multica Task UUID 或链接 | **现有 Multica Task** | `multica issue get <id> --output json`；按需读取相关评论 | 更新该 Multica Task |
| 2 | `#编号` / `owner/repo#编号` / `github.com/.../issues/...` | **GitHub issue** | `gh issue view` 读取正文和讨论；未经明确请求不回写来源 issue | 目标项目中的 Multica Task |
| 3 | 真实存在的 `.md` 文件路径 | **本地文档** | 读取全文并核对仓库归属 | 目标项目中的 Multica Task |
| 4 | 其余（口述、粘贴、自然语言） | **会话录入** | 输入本身作为需求源，按 §2 渐进分析 | 目标项目中的 Multica Task |

- 一次输入含「文件路径 + 补充说明」→ 以文件为主，说明作为补充约束。
- 一次输入含多个需求 → 先按 §3.1 切片，每片一个 Multica Task。
- 一次输入含「实质变更 / 升版」请求 → 先定位现有 Multica Task，再走 §8 V1→V2 闭环，不要创建重复 Task。

**所有新任务都登记在 Multica Task。** GitHub、CNB 等外部 issue 仅作为需求来源；项目内规格文件是 Task 的 `spec_ref` 指针目标，不是第二套状态账本。

#### 外部 tracker 来源规则

需求源可以来自 GitHub、CNB 或其他系统。此时**需求来源与登记去向分开处理**：

1. 读取来源只使用用户已连接且有权限的工具；没有访问权限时请用户提供正文，不编造来源内容。
2. 结论、状态、基线与依赖写入 Multica Task；不得在来源 tracker、本地登记册或看板维护第二份状态。
3. 若 Multica CLI 不可用，仍可完成需求分析、规格和 Definition Check 草稿，但 Task 登记停在未完成；不得降级为本地登记或声称「已定义」。

> 向用户复述来源类型和目标 Multica 项目。不要把 GitHub/CNB 来源 issue 描述成任务状态的权威记录。

Multica 工作状态与需求定义状态分开：定义和基线待确认期间 Task 保持 `backlog`；用户确认后写入 `dev-flow.definition.v1.definition_status=defined`，并把 Task 移到 `todo`。不把 Multica 的工作状态改造成自定义「定义中」状态。

### 1. 分诊（内联 triage 规则）

对需求做分类和状态判断。将分类写入需求摘要；只有目标 Multica 项目已配置对应自定义属性时才写该属性，不为贴标签而改写外部来源。

**分类标签**（恰好一个）：
- `bug` — 有东西坏了
- `enhancement` — 新功能或改进

**需求定义状态**与 Multica 工作状态分开。未确认前保持 `backlog`；确认并写入完整定义元数据后才转到 `todo`。不要创建或依赖 `ready-for-agent` 等 GitHub 标签。

**分诊检查**：
1. **冗余性**：按领域概念搜索仓库是否已有实现；已有 → `wontfix` 并指出位置。
2. **历史拒绝**：读 `.out-of-scope/`（若存在），有相似需求先提示。

**标签应用**：本 skill 不在 GitHub/CNB 来源上写标签。Multica 项目自定义属性只在用户已明确配置且现有写入能力可用时使用；未配置时把分类写在 Multica Task 描述中。

**来源 tracker**（GitHub、CNB 等）：默认只读取正文和讨论，不回写标签、状态或评论。用户单独要求回写时，先完成待审草稿并确认写入目标；Multica Task 仍是定义与交付状态的权威记录。

**发布规则**：创建 Multica Task 时，描述应区分用户提供的原始事实与 AI 整理的分析；不得把推测写成已确认事实。对外来源 tracker 的写入需有单独请求。

**优先级落档**：Multica 使用 `urgent`、`high`、`medium`、`low`、`none`。若输入使用项目 P0–P2 口径，分别映射为 `high`、`medium`、`low`；只有用户明确要求紧急级别时才使用 `urgent`，未指定时省略 `--priority`。

### 2. 渐进式需求分析与人工决策

复杂需求采用「分析 ↔ 人工决策」循环，**不要**一次抛出大量问题。

```text
调查和分析
  ↓
识别当前最上游的关键决策
  ↓
说明为什么必须决定
  ↓
给出 2~3 个有实质差异的选项（成本 / 收益 / 风险）
  ↓
给出推荐意见
  ↓
人工决策
  ↓
写回当前需求理解
  ↓
基于决定继续深入
```

#### 2.1 何时必须人工决策

不同选择会改变以下任一项时，必须人工决定：

- 用户体验；功能范围；业务规则；验收标准；风险承担
- 是否允许无人值守施工
- 是否改变已有行为；是否牺牲体验换取进度；优先级

#### 2.2 无需人工决定

只影响内部施工方式，且不改变用户行为 / 范围 / 验收 / 风险边界 → 施工者可自行决定，不打断用户。

#### 2.3 决策卡格式（每项）

```text
需要决策：
<一句话描述>

为什么必须现在决定：
<会影响什么产品结果>

方案 A
成本：
收益：
风险：

方案 B
成本：
收益：
风险：

（如有必要方案 C）

推荐：
<推荐方案>

推荐原因：
<业务层理由>

请用户选择，或提出新的处理方式。
```

Agent 必须带着分析与推荐提问，不能把分析责任转嫁给用户。

**无人工受访者时**（后台自动化）：影响产品结果的未决项列入缺口；Multica Task 保持 `backlog`，**不得**写入有效的已定义元数据，也不得编造决策。

落定的决策写入本地规格「已确认的关键决策及原因」，并同步分析文档。

### 3. size 判定与路由

澄清/决策推进到信息足够后判定体量，打 `sized-s` / `sized-m` / `sized-l`。

#### size 启发式

1. **路径清晰度**：方案是否明确？有必须先决断的设计/未知 → 至少 M，倾向 L
2. **工作量**：单执行会话能否完成 → 明显超出 → L
3. **影响面**：单一 → S；多个 → M 或 L

- **S**：路径清晰 + 影响面单一 + 单会话可完成 → 单一任务规格
- **M**：路径清晰但需多个**可独立 UAT 的完整功能切片** → 每切片一份任务规格（或清单 + 分规格），切片间前置依赖按 §3.1
- **L**：路径不清晰 → **禁止整块开工**；先拆决策地图（§3.2），决策清后再按可 UAT 切片出规格

#### 3.1 复杂需求拆分（优先用户可验证切片）

默认拆分单位：**最小可独立 UAT 的完整功能切片**。

合格切片同时满足：明确用户目标；可观察功能变化；相对完整主路径；用户能实际操作；可独立写 UAT；完成后能判断「该能力已存在」；规模可控。

**不推荐**按用户无法独立验证的内部层次拆（纯底层 / 纯接口 / 纯页面）。

前置依赖定义：仅当「前一任务未完成，当前任务就无法正确开始」。无依赖必须写：

```text
前置依赖：无
```

拆分时人与 Agent **共同判定**任务关联，并写入施工环境字段（见 `references/public-task-contract.md`）：

| 情形 | 施工环境组 | 施工环境角色 | 前置依赖 |
|---|---|---|---|
| 无关联、可并行 | 本 Task UUID | `independent` | 无 |
| 父 Task 下的能力包 | 父 Task UUID | 父=`independent`；子=`member` | 子写清依赖的父/兄 Task UUID |

示例：父 Task 建分支与独立工作区后，子 Task 同组串行——后一个 Task 的前置依赖写入前一个 Multica UUID。

批量调度**不管**分支与工作区；有依赖时的串行门禁由**单任务启动**执行。

#### 3.2 L 型：决策地图 + OpenSpec（内联 wayfinder）

1. 拆决策工单（一张 = 一个必须先决断的问题）
2. 逐张关闭直至路径清晰
3. 综合为 OpenSpec（`references/openspec-template.md`）
4. 🔴 **L 型禁止直接开工**——不实施、不写实现代码
5. 决策清后，再按 §3.1 拆可 UAT 切片并进入 Definition Check

决策地图结构、工单类型、雾区原则和 OpenSpec 落地形式沿用既有 wayfinder 约定。外部写入到 Multica 需有用户明确请求；没有写入条件时只交付草稿，不创建本地状态账本。

### 4. 产出三要素（任何中途文档必须包含）

#### 任务目标（Goal）
交付什么结果、用户得到什么（动词 + 可观察结果）。

#### 涉及范围（Scope）
影响哪些部分；以及**明确哪些不做**。

#### 验收标准（Acceptance）
可操作、可验证、可复现（最好能对应真实操作步骤）。

三要素是最低门槛；**「已定义」还要求**完整任务规格 + Definition Check + 人工确认（§6–§7）。

### 5. 缺口处理

三要素或关键产品决策无法从已有信息得出时：

- ✅ 如实标注缺失 + 补齐建议（缺什么 / 由谁补 / 补在哪）
- ❌ 不得编造补全
- ❌ 不得在无人可问时假装已定义
- 有人可问 → 用 §2 决策卡推进；无人可问 → 保持 Task 为 `backlog`，列出缺口并等待输入

### 6. Definition Check

在请求人工确认基线**之前**，按 `references/definition-check.md` 逐项检查并落盘：

`docs/tasks/specs/<slug>/definition-check.md`（入库：它是「能否开工」的判定依据，下游必须能读到）

硬规则：

- 未决产品事项数必须为 **0**
- 任一项未通过 → Multica Task 保持 `backlog`
- 全部通过 → 向用户呈递基线确认请求；确认前不写有效定义元数据

确认话术：

> 请确认：确认需求基线 V\<n\>，可按该版本进入交付。

**未经过人工确认，不得自动进入「已定义」。**

### 7. 登记 Multica Task

只有在需求规格和 Definition Check 完成、未决产品事项为 0、用户明确确认基线后，才能把 Task 标记为已定义。Multica Task 是状态与任务身份的唯一记录。

1. **保存规格**：把完整规格写到目标代码仓库内的 `docs/tasks/specs/<slug>/task-spec-V<n>.md`，并用 `realpath` 确认目标仍在该仓库内。Multica 保存 `spec_ref` 相对路径；规格正文不靠本机忽略目录或临时工作区传递。
2. **准备 Multica Task**：有现存 Task 时复用 UUID；否则，在确认目标项目后创建一个未分派的 `backlog` Task。描述包含 Goal、Scope、Acceptance、基线、需求来源链接、规格路径和 Definition Check 摘要。不要把 GitHub/CNB 来源 issue 的编号当作 Multica Task ID。
3. **等待基线确认**：向用户呈递需求基线和 Definition Check。未获确认时不设置已定义元数据，不把状态移到 `todo`。
4. **写入定义元数据**：基线确认后，使用 JSON 字符串写入 `dev-flow.definition.v1` 和 `dev-flow.dependencies.v1`。依赖键必须存在；没有依赖时写显式空数组 `[]`。依赖元素使用 Multica Task UUID。
5. **核对后就绪**：重新读取 Task，确认返回 UUID、目标项目、状态及两个元数据值都与请求相符；确认无误后再将工作状态设为 `todo`。状态命令带 `--no-start`，避免定义动作启动 Agent。
6. **唯一身份**：Multica 返回的 Task UUID 是正式标识。不在本机分配临时号，不写 `registry.json`、`BOARD.md` 或其它任务状态副本。

CLI 形态：

```bash
multica issue create --title "<任务标题>" --project "<项目 ID>" --status backlog   [--priority <urgent|high|medium|low>] --description-file "<任务描述文件>" --output json

multica issue metadata set "<task-uuid>" --key dev-flow.definition.v1   --type string --value '{"definition_status":"defined","baseline_version":"V1","unattended":true,"env_group":"<group-id>","env_role":"independent","pending_product_decisions":0,"defined_at":"<RFC3339 timestamp>","spec_ref":"docs/tasks/specs/<slug>/task-spec-V1.md"}' --output json

multica issue metadata set "<task-uuid>" --key dev-flow.dependencies.v1   --type string --value '[]' --output json

multica issue get "<task-uuid>" --output json
multica issue status "<task-uuid>" todo --no-start --output json
```

命令中的 `--type string` 很重要：Multica metadata 的 value 是字符串，字符串内容再编码为 JSON。存在前置依赖时，把 `[]` 换为依赖 UUID 数组；多任务拆分按 §3.1 写清 parent、施工环境组和依赖方向。

若创建、元数据写入、读取核对或状态更新任一步失败，保留实际 Task 状态和错误，不宣布「已定义」。若 Multica 不可用，只交付待审规格和 Definition Check；不创建本地登记册，也不伪造 Multica ID。

成功回报格式：

```text
需求已定义
Multica Task UUID：
项目：
需求来源：
需求基线：
优先级：
前置依赖：
施工环境组 / 角色：
无人值守许可：
本地任务规格：
定义时间：
Multica 工作状态：
Definition Check：通过
```

#### 7.1 产物位置

| 产物 | 位置 |
|---|---|
| Definition Check | `docs/tasks/specs/<slug>/definition-check.md` |
| 本地任务规格 | `docs/tasks/specs/<slug>/task-spec-V<n>.md` |
| 需求分析摘要 | `docs/tasks/specs/<slug>/requirements-analysis.md` |
| 决策票 | `docs/tasks/specs/<slug>/decision-tickets/` |
| 多切片清单 | `docs/tasks/specs/<slug>/issues/` |
| 状态、定义、依赖和来源 | Multica Task description + `dev-flow.definition.v1` + `dev-flow.dependencies.v1` |
| 决策地图 / OpenSpec | wayfinder 约定位置 / `specs/<slug>/proposal.md` |

### 8. 实质变更 V1→V2

按 `references/baseline-change-v1-v2.md` 执行：回定义 → 决策 → 更新规格版本 → Definition Check → 人工确认 → 更新 Multica Task 描述与 `dev-flow.definition.v1` 基线版本。确认 Task 上没有运行中的 Run 后再改动已引用规格；不要静默改写旧基线。

已启动的交付 Run 不得静默升版。

### 9. 与交付的边界（本 skill 不做）

本 skill 的阶段职责是完成需求分析、人工确认基线、通过 Definition Check，并把状态和定义写入 Multica Task。工作状态由 Multica 管理；本地规格文件只承载需求正文，不承载第二份任务状态。

之后发生的事——按任务施工、审查、测试、人工验收、收口——属于**工作流侧后续能力**，不在本 skill 范围内，也不由本 skill 启动或替代。

---

## 硬规则清单

1. 🔴 **未决产品事项为 0 才能写入已定义元数据**；有未决时 Task 保持 `backlog`
2. 🔴 **Definition Check 全部通过 + 人工确认基线** 缺一不可
3. 🔴 **Multica 定义元数据中的基线版本必须与本地规格版本一致**
4. 🔴 **L 型禁止直接开工**：只产出地图 + OpenSpec + 规格，不实施
5. 🔴 **关键状态必须落在 Multica Task**：不得只存在会话中或本地副本
6. 🔴 **三要素/决策缺失不编造**；未经明确请求不回写需求来源 tracker
7. 🔴 **不新建第二套定义入口**；本 skill 即唯一定义入口
8. 🟡 有歧义才澄清；先决策/澄清后定 size；拆分优先可独立 UAT 切片
9. 🟡 **不通过 `skill` 工具调用子 skill**
10. 🔴 **Multica 写入或回读失败时不宣布已定义**；不得用本地登记册、看板或临时号回退
11. 🔴 **来源 issue 与 Multica Task 分工明确**：来源可读不可写时照常分析，但定义与状态只能记在 Multica Task

## 参考文件

- `references/task-spec-template.md` — 本地任务规格模板
- `references/multica-task-template.md` — Multica Task 描述与元数据模板
- `references/definition-check.md` — Definition Check 清单
- `references/baseline-change-v1-v2.md` — 实质变更升版流程
- `references/openspec-template.md` — L 型 OpenSpec 模板
- `references/public-task-contract.md` — 公共任务契约（本 skill 包内）

## 安装态资料定位

本技能不依赖 workflow-manager 的脚本或本地登记册。Multica Task 通过用户已配置的 `multica` CLI 管理；规格文件保存在目标代码仓库中。

## 依赖

- `multica` CLI：写入正式 Task 定义所必需；不可用时仅交付草稿材料，待平台恢复后再登记
- GitHub/CNB 能力：只在读取相应来源时需要；来源 tracker 不作为状态权威
- 无子 skill 依赖

## 与整项交付接续

同一范围、同一版本的人工需求确认可引用既有对话或批准记录，不因重新加载本技能要求再次确认；记录批准对象、版本、依据。改变范围或验收的部分仍需重新决定。
当用户只要求需求分析时，本阶段材料即交付；当用户要求完成整个功能时，主助手须在已获授权与开工条件满足后接续建设流程。不得把本技能结束解释为整项任务完成，也不要求用户手工传递已经可用的材料。
普通办公、生活任务不触发本编程需求流程；仅有辅助程序不改变任务类别。
