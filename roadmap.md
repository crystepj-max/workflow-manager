# Workflow Manager Roadmap

> 状态基线：2026-08-21
>
> 本文档描述项目从当前 DSH 优先实现，逐步演进为可验证、可扩展、可跨 Coding Agent 复用的工作流系统的计划。它是产品/架构级路线图，不替代 `docs/design/` 中的详细契约、`wayfinder/MAP.md` 中的决策记录或 GitHub Issue 中的施工任务。

## 1. 项目定位

Workflow Manager 的长期目标不是维护一份固定的 DSH 编排脚本，而是形成一套：

- **工作流定义与具体 Agent 解耦**；
- **可机器校验、可行为回归、可人工门禁**；
- **支持可视化创作与版本化复用**；
- **可逐步接入 DSH、Codex、Claude Code、ACP Agent 等执行器**；
- **适合真实软件开发任务长期迭代**

的软件开发工作流系统。

当前实现仍以 DSH 为首个运行时，但项目的核心资产已经逐步从单一脚本演进为：

1. Blueprint Contract（蓝图契约）；
2. `validate-core.cjs`（统一校验内核）；
3. `compileBlueprint()`（统一编译器）；
4. runtime harness（运行时行为测试）；
5. DSH execution runtime（当前默认执行运行时）。

长期架构方向：

```text
Workflow Definition / Template
          │
          ▼
   Workflow Contract
          │
   ┌──────┴──────┐
   │ Validate    │
   │ Compile     │
   │ Test        │
   └──────┬──────┘
          │
   Execution Adapter
          │
   ┌──────┼───────────────┐
   ▼      ▼               ▼
  DSH   Native Agent      ACP
         │                │
      Codex / Claude    Any ACP Agent
```

## 2. 版本与命名规范

项目正式版本从 **`0.1.0`** 开始，遵循 Semantic Versioning（SemVer）：

```text
MAJOR.MINOR.PATCH
```

在 `1.0.0` 前：

- `0.x.0`：新增一组明确的产品/架构能力；
- `0.x.y`：兼容性修复、测试补强、文档/体验优化；
- Git Tag / GitHub Release 使用 `v0.1.0`、`v0.2.0` 形式。

### 历史 Workflow 名称与项目版本分离

`dev-workflow-2-0` / “开发工作流 2.0”来自 Gold Band 迁移历史，用于区别早期工作流，不再作为本项目软件版本号。

近期保持现有 Workflow ID，避免破坏：

- 模板 ID；
- Skill ID；
- 触发词；
- 生成目录；
- 用户已有引用。

后续在蓝图契约中明确区分：

```jsonc
{
  "contractVersion": "1",
  "version": "0.1.0",
  "id": "dev-workflow-2-0"
}
```

其中：

- `contractVersion`：蓝图协议版本；
- `version`：某个 Workflow 模板自身的版本；
- `id`：稳定标识；
- 项目 Release 版本：仓库整体产品版本。

## 3. 当前基线（已完成）

截至 2026-08-21，项目已经完成第一次关键架构收敛。

### 3.1 Blueprint 单一事实源 ✅

`templates/*.json` 已成为具体工作流定义的唯一事实源。

```text
templates/<id>.json
        │
        ▼
 scripts/generate.mjs
        │
        ▼
.generated/<id>/
  ├── script.mjs
  ├── vwf-dsl.json
  ├── SKILL.md
  └── meta.json
```

`.generated/` 为生成物，禁止直接编辑。

旧的手写 `dsh/workflow/dev-workflow-2.0.mjs` 已退役删除，DSH 入口改由生成 Skill 承接。

### 3.2 Workflow Schema / 状态机已进入蓝图 ✅

节点的以下能力已由蓝图声明：

- `profile` / `goal`；
- `output.schema`；
- `output.successCondition`；
- `output.files`；
- `manualCheck`；
- `verifyBranch`；
- `bindings.models`；
- `edges` / success / failure；
- `control.maxRounds`；
- `onMaxRounds`；
- `heteroCheck`。

因此“业务流程规则 = 手写 DSH 脚本”的耦合已经显著降低。

### 3.3 统一编译器 ✅

DSH 与 vwf 已统一使用 `scripts/generate.mjs` 中的 `compileBlueprint()`。

原有第二套 `host.js compileDsl` 已删除。

当前架构硬原则：

> 同一 Blueprint 不允许由两个业务语义不同的编译器解释。

### 3.4 统一校验内核 ✅

唯一规则集为：

```text
scripts/validate-core.cjs
```

分为：

- `validateStructure()`：拓扑、边、入口、走通性、条件、Schema 路径、maxRounds 等框架约束；
- `validateBlueprint()`：异源、`verifyBranch`、`output.files`、模型绑定等业务约束。

原 `validate-blueprint.mjs` 与宿主独立 `validateDsl` 等重复规则实现已删除。

### 3.5 运行时排练厅 / 行为测试 ✅

测试已经从“嗅探生成脚本字符串”升级为真实执行生成脚本并断言返回状态机行为。

当前 runtime harness 覆盖：

- 框架级走通性；
- 模板级回归；
- DSH / vwf 统一编译路径；
- 人工门禁；
- 打回循环；
- 分流；
- 可信度闸门；
- 超限归因等关键行为。

后续 Contract 变更必须继续以行为测试而非仅静态字符串测试作为主要回归依据。

### 3.6 可视化编辑器基础能力 ✅

当前 vwf 已具备：

- 模板库；
- 节点增删；
- 拖拽连线；
- 节点/边配置；
- provider / model / role / goal；
- JSON Schema；
- `successCondition`；
- `maxRounds`；
- `heteroCheck`；
- `onMaxRounds`；
- JSON / 画布双向编辑；
- 实时校验与字段定位；
- 保存 / 删除 / 另存为；
- 运行看板基础能力。

因此后续重点是产品化与补齐，而不是重新建设编辑器。

### 3.7 用户模板持久化与 Skill 闭环 ✅

用户模板当前采用文件系统持久化：

```text
~/.dsh/visual-workflow/templates/<id>.json
```

保存成功后同步生成：

```text
~/.dsh/skills/<id>/
```

形成：

```text
编辑 → 校验 → 保存 Blueprint → 编译 → Skill 可运行
```

Skill 写盘已采用暂存目录 + rename 换入的原子化流程，并具有失败清理测试。

### 3.8 开发工作流关键健壮性规则 ✅

当前已实现：

- dev / review 异源模型硬规则；
- `verified_branch` / `verified_head` 可信度闸门；
- Git worktree 物理隔离；
- test / review / accept 结论校验；
- 最多 9 轮打回；
- 超限失败归因；
- AI 验收 + 人工裁决分离；
- `AWAITING_HUMAN_<id>` 可续跑门禁；
- `output.files` 与 goal / role 文件名的一致性机器核对。

### 3.9 AGENTS.md 基础版 ✅

根目录已经建立 `AGENTS.md`，覆盖：

- 项目结构；
- 生成物规则；
- 构建 / 测试命令；
- 编码与命名约定；
- 提交 / PR 规范；
- 安全与本地状态边界。

后续从“已有 AGENTS.md”转向“AGENTS 治理与漂移控制”。

### 3.10 CI / validate 基线 ✅

根级 `npm run validate` 与 GitHub Actions 已用于：

- Blueprint 校验；
- 重生成一致性；
- 引擎测试；
- runtime harness；
- 插件测试。

## 4. v0.1.0 — 统一 Workflow Engine 基线

### 目标

发布首个正式项目版本，确认当前架构具备稳定、可重复、可回归的基线。

本版本原则：**只收口，不扩大能力边界。**

### 已完成

- [x] Blueprint 单一事实源
- [x] Schema / 状态机蓝图化
- [x] 统一编译器
- [x] 统一校验内核
- [x] runtime harness
- [x] DSH / vwf 双入口同编译语义
- [x] 可视化编辑器基础能力
- [x] 用户模板持久化
- [x] save → Skill 闭环
- [x] Skill 原子写盘
- [x] 异源 enforcement
- [x] `verifyBranch` 可信度闸门
- [x] worktree 隔离
- [x] 人工门禁
- [x] 9 轮 / 超限归因
- [x] 文件契约机器核对
- [x] 旧手写 mjs 退役
- [x] 根级 `AGENTS.md`
- [x] CI / validate 基础

### 发布前待完成

- [ ] 正式统一版本号：根项目与尚未正式发布的子包从 `0.1.0` 建立一致基线
- [ ] 清理文档中容易误解的软件版本表述：历史 “Workflow 2.0 / v1 / v1.1 / v2” 与项目 SemVer 分离
- [ ] 完成 `docs/design/equivalence-checklist.md` 8 个维度的正式人工签核
- [ ] 以生成 Skill 触发词完成一次完整 E2E 实跑并记录结果
- [ ] 对 GitHub Issues 与当前实现做 Reality Reconciliation：关闭已完成项、重写已过时方案
- [ ] 清理或明确已跟踪 `.scratch/` 历史遗留，避免与 `AGENTS.md` / `.gitignore` 规则冲突
- [ ] 给 `AGENTS.md` 增加最小架构硬规则和 SemVer 规则
- [ ] 创建 Git Tag / GitHub Release：`v0.1.0`

### v0.1.0 完成定义

以下条件必须同时成立：

1. `npm run validate` 全绿；
2. 等价验收清单签核完成；
3. 生成 Skill 的真实 E2E 流程通过；
4. 文档、Issue、代码对当前架构描述一致；
5. 版本号语义无歧义；
6. 发布 `v0.1.0` Release。

## 5. v0.2.0 — Contract 正式化 + AGENTS 治理 + DSH 产品化

### 5.1 Formalize Workflow Contract

现有 `blueprint-schema.md + validate-core + compileBlueprint + runtime harness` 已经形成事实上的 Workflow Contract。

本阶段不是从零创建，而是正式化：

- [ ] 为 Blueprint 增加 `contractVersion`
- [ ] 为具体 Workflow 模板增加独立 `version`
- [ ] 明确字段兼容策略：新增 / 废弃 / breaking change
- [ ] 定义 Blueprint migration 机制
- [ ] 定义状态码、Gate、Artifact 的稳定协议
- [ ] 明确哪些字段属于业务 Workflow，哪些属于某个执行运行时扩展
- [ ] 为 Contract 变化建立兼容性测试矩阵

目标：

> Workflow Contract 可以独立描述“软件开发流程要发生什么”，而不要求消费者理解 DSH 实现细节。

### 5.2 AGENTS 治理

根 `AGENTS.md` 已完成基础版。本阶段补治理能力：

- [ ] 增加架构硬规则：禁止重新引入第二套编译器 / 校验器
- [ ] 明确权威性层次：Blueprint 实例 / Contract / validator / generated artifact
- [ ] 加入 SemVer 与命名规则
- [ ] review / closeout 增加 AGENTS drift 检查
- [ ] 项目级定期漂移审计持续执行
- [ ] 仅在目录出现独立且稳定规则后再增加子目录 `AGENTS.md`

知识分层目标：

```text
AGENTS.md           项目共同规则
CONTEXT.md          项目统一术语
blueprint-schema    机器/业务契约
wayfinder/MAP.md    决策记录
dsh/roles/*.md      角色岗位规则
```

### 5.3 DSH 插件产品化

完成真正可安装的 DSH 组合包，而不是依赖 Creative Mode 动态 `cordis_define`：

- [ ] 完成组合包 manifest / patch 接线
- [ ] `dsh plugin --profile <name> add link:...` 安装验证
- [ ] 重启 Profile 后功能完整保留
- [ ] 明确开发安装、升级、卸载流程
- [ ] 为后续 GitHub / registry 分发准备构建产物

GitHub Issue #16 应作为本阶段核心施工项之一。

### 5.4 持久化边界重新定义

当前 Blueprint 文件持久化已经满足模板可移植、可 diff、可 Git 管理的目标，因此暂不把模板迁回 opaque storage。

建议：

```text
Blueprint / Template  → 文件系统
Run metadata/history  → storageDomain（如确有需要）
UI state              → storageDomain（如确有需要）
```

原 Issue #17 的“模板整体迁 storageDomain”应按现状重新评审。

## 6. v0.3.0 — External Agent Execution Adapter

### 目标

在不破坏 Workflow Contract 和现有 DSH Schema Gate 的前提下，让外部 Coding Agent 成为真实执行者。

### 架构方向

抽象执行接口：

```text
executeNode(node, context)
        │
        ├── DshAgentExecutor
        ├── CodexExecutor
        └── ClaudeCodeExecutor
```

### Codex 第一阶段策略

优先使用 DSH 内置 `subagent_codex`，而不是立即把整个 Workflow 迁到 ACP。

推荐路径：

```text
Workflow node
    │
    ▼
DSH wrapper / adapter
    │
    ▼
subagent_codex
    │
    ▼
Codex 执行真实开发任务
    │
    ▼
DSH wrapper 校验 / 归一化
    │
    ▼
Workflow output.schema
```

原因：

- 当前 Workflow 强依赖 `output.schema`；
- Codex 产品 subagent 与 ACP backend 当前都不直接继承 DSH structured output 契约；
- wrapper 可以保留现有状态机与 Gate，同时把重型开发交给 Codex。

### 本阶段任务

- [ ] 定义 Executor capability matrix
- [ ] 抽象节点执行接口
- [ ] 保持 DSH Executor 为默认实现
- [ ] Codex Executor 原型
- [ ] Claude Code Executor 原型
- [ ] 外部 Agent 输出归一化与本地 Schema 验证
- [ ] 权限 / sandbox / cancel / timeout 统一错误分类
- [ ] 同一 Workflow 在至少两个执行器上完成行为测试

### 非目标

本阶段不把 ACP 设为强制中间层。

## 7. v0.4.0 — Plugin Development Profile

### 目标

支持“普通仓库开发”和“DSH/Cordis Runtime 插件开发”共享同一个 Workflow Core，但拥有不同运行 Profile。

```text
Workflow Core
    │
    ├── normal
    └── cordis-plugin
```

### 插件开发专属阶段

可能包括：

```text
inspect runtime
      ↓
develop
      ↓
static test
      ↓
runtime define / run
      ↓
AWAITING_PLUGIN_APPROVAL
      ↓
human / main Creative session
      ↓
runtime verify
      ↓
review / accept / closeout
```

### 原则

- [ ] Workflow 不同步等待需要多轮人工交互的 runtime approval
- [ ] 复用当前 `AWAITING_HUMAN_*` 人机边界
- [ ] 主 Creative Session 负责 live runtime / approval 生命周期
- [ ] 自动 Workflow 负责可重复的开发、静态验证、review 与状态管理
- [ ] 尽量不复制一套独立工作流实现

## 8. v0.5.0 — ACP 通用执行层

### 目标

在 Workflow Contract 和 Executor 抽象稳定后，引入 ACP 作为跨 Agent 通讯 / 会话传输层之一。

职责必须分层：

```text
AGENTS.md
= 项目共同规则

Workflow Contract
= 软件开发任务、节点、结果、状态、Gate 的业务协议

ACP
= Agent 会话 / Prompt / 生命周期 / Permission 等通讯协议

DSH / Codex / Claude / Other
= 真正执行工作的 Agent
```

### 本阶段任务

- [ ] ACP Executor
- [ ] capability negotiation
- [ ] Workflow Contract 在 ACP 上的 namespaced extension / envelope
- [ ] structured output 的本地解析与 JSON Schema 强制验证
- [ ] 无效结构结果的 repair / retry 策略
- [ ] permission / cancel / error 映射
- [ ] Codex ACP Adapter 实验
- [ ] 至少一个非 Codex ACP Agent 互操作实验

### 关键原则

ACP 不替代 Workflow Contract。

不能因为“通过 ACP 通讯”就降低：

- Schema Gate；
- Artifact Contract；
- 状态机可验证性；
- 人工门禁；
- 行为测试。

## 9. v0.6.0+ — 高级编排与分发

在 Contract / Execution Adapter 稳定后再逐步推进：

### 并行编排

- [ ] fanOut 受限并行子任务
- [ ] 结果聚合
- [ ] item / agent 数量上限
- [ ] 部分失败策略

对应现有 Issue #18。

### 多 Workflow 并行

- [ ] 多 run 看板
- [ ] 同 taskId 互斥
- [ ] 人工门禁队列
- [ ] closeout 串行规则
- [ ] 状态 / 日志互不串扰

对应现有 Issue #19。

### AiDynamic / 动态规划

- [ ] 在约束内允许 Agent 动态拆解任务
- [ ] 动态结果必须落入 Contract
- [ ] 不允许绕过 max rounds / Gate / Schema

### 分发

- [ ] 独立插件仓库评估
- [ ] GitHub 安装
- [ ] registry 发布评估
- [ ] 升级 / migration / rollback

对应现有 Issue #21。

## 10. GitHub Issue 对账方向

现有 Issue 是重要历史记录，但部分描述已经被实际实现超前或替代。

建议在 `v0.1.0` 前完成一次集中对账：

| Issue | 当前判断 | 建议 |
|---|---|---|
| #4 P0 动态插件原型 | 大部分能力已落地 | 按验收证据复核后关闭或补缺口 |
| #5 P1 可视化编辑器 | 大部分能力已落地 | 重写剩余产品化缺口，避免继续按旧描述施工 |
| #6 P2 持久化产品 | 范围已变化 | 作为高层 Epic 重写 |
| #16 组合包安装 | 仍是真实缺口 | 进入 v0.2.0 |
| #17 storageDomain 模板迁移 | 已被文件系统持久化替代大半 | 重写为 run/UI 持久化或关闭 |
| #18 fanOut | 未开始 | v0.6.0+ |
| #19 多工作流并行 | 未开始 | v0.6.0+ |
| #20 执行路径文档化 | 已落地：三入口统一为「获取脚本 → 平台 workflow 工具」，wf_run 为条件注册增强路径 | 已验收，随本轮 PR 关闭 |
| #21 独立仓库分发 | 后置合理 | v0.6.0+ |

## 11. 架构硬规则

以下原则应逐步进入 `AGENTS.md` 并由测试/Review 保护：

1. **Blueprint 是具体 Workflow 的唯一事实源。**
2. **`.generated/` 永远是生成物，不允许成为人工修改源。**
3. **唯一业务编译器是 `compileBlueprint()`；禁止重新引入第二套语义实现。**
4. **唯一校验规则集是 `validate-core.cjs`；UI 可以有布局辅助逻辑，但不能成为权威业务校验器。**
5. **Workflow Contract 变更必须增加或更新 runtime harness 行为测试。**
6. **项目共同规则属于 `AGENTS.md`；角色规则属于 `dsh/roles/*.md`。**
7. **Workflow Contract 与 Agent 通讯协议分层；ACP 不等于 Workflow Contract。**
8. **人工 Gate 不由 AI 代签。**
9. **外部 Agent 接入不能绕过 Schema / Artifact / branch verification Gate。**
10. **优先渐进抽象现有真实能力，不为未来兼容性提前复制多套 Workflow。**

## 12. 近期优先顺序

当前建议施工顺序：

```text
v0.1.0 收口
  │
  ├─ 版本统一
  ├─ 等价验收签核
  ├─ E2E 实跑
  ├─ Issue / 文档对账
  └─ AGENTS 架构规则
        │
        ▼
v0.2.0
  │
  ├─ Workflow Contract 正式化
  ├─ DSH 安装产品化
  └─ AGENTS drift 治理
        │
        ▼
v0.3.0
  │
  └─ Codex / Claude Execution Adapter
        │
        ▼
v0.4.0
  │
  └─ Plugin Development Profile
        │
        ▼
v0.5.0
  │
  └─ ACP Execution Layer
        │
        ▼
v0.6.0+
     fanOut / 多 Workflow / AiDynamic / 分发
```

## 13. 成功标准

项目进入 `1.0.0` 前，至少应满足：

- Workflow Contract 稳定且具有兼容/迁移机制；
- DSH 运行时可正式安装使用；
- 至少两个不同 Coding Agent 执行器通过同一 Workflow Contract 的 E2E 验证；
- structured output、Artifact、Gate、错误状态均可机器验证；
- Blueprint 可视化编辑与文本编辑都不会产生语义分叉；
- 多 run / 人工门禁生命周期可可靠管理；
- 版本、文档、AGENTS、Issue 与真实实现长期保持一致。

---

本 Roadmap 随项目实际实现滚动更新。短期决策以稳定现有引擎为优先；新的抽象只有在能够消除已发生的重复实现、协议漂移或接入成本时才进入核心架构。
