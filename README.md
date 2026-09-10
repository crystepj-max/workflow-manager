# workflow-manager

![Runtime](https://img.shields.io/badge/Runtime-DeepSeek%20Harness-blue)
![Plugin](https://img.shields.io/badge/Plugin-dsh--visual--workflow%20v0.2.0-2EA9A0)
![Status](https://img.shields.io/badge/Status-v0.1%20%E6%94%B6%E6%95%9B%E4%B8%AD-orange)
![Repo](https://img.shields.io/badge/Repo-Private-lightgrey)

面向复杂软件研发与通用知识工作的 **AI 协作工作流系统**。

Workflow Manager 不只是"按顺序调用 Agent"。它希望把 Workflow、Role、模型、人工决策、运行快照、正式成果和验证证据组织成一个**可配置、可运行、可干预、可恢复、可追溯**的协作系统。

当前以 **DeepSeek Harness（DSH）** 作为首个运行环境。Codex、Claude Code 等 Coding Agent 属于后续执行器扩展，不反向定义 Workflow Manager 的产品模型。

---

## 目录

- [1 · 项目介绍](#1--项目介绍)
  - [核心特性](#核心特性)
  - [四套内置工作流](#四套内置工作流)
  - [12 个内置角色](#12-个内置角色)
  - [当前状态](#当前状态)
- [2 · 下载与安装](#2--下载与安装)
  - [环境要求](#环境要求)
  - [安装可视化工作流插件](#安装可视化工作流插件)
  - [安装 AI 任务技能包](#安装-ai-任务技能包)
  - [开发模式安装](#开发模式安装)
  - [验证 / 更新 / 卸载](#验证--更新--卸载)
- [3 · 深入了解](#3--深入了解)
  - [快速开始](#快速开始)
  - [单一事实源架构](#单一事实源架构)
  - [目录结构](#目录结构)
  - [常用命令](#常用命令)
  - [文档权威性](#文档权威性)
  - [常见问题](#常见问题)
- [4 · 参与贡献](#4--参与贡献)
- [5 · 路线图](#5--路线图)
- [6 · 许可与状态](#6--许可与状态)

---

## 1 · 项目介绍

### 核心特性

| 能力 | 说明 |
|---|---|
| **可视化编辑器** | 拖拽连线画布 + 配置面板，参照 Gold-Band 桌面端《工作流编辑器》实现；画布 / JSON 双 tab 实时互同步 |
| **双根模板库** | 内置模板（只读）+ 用户模板（可增删改）；保存即校验、即编译、即同步为可调用技能 |
| **人工门禁** | 节点产出后挂起等待人工裁决，支持断点续跑；**AI 不代签** |
| **运行看板** | 每 3 秒轮询，呈现运行状态 / 阶段 / 子代理表格 / 最近 20 条日志 |
| **多 run 并行** | 数据按 runId 分账隔离；同 taskId 互斥；门禁卡片排队裁决 |
| **受限扇出** | 一个节点按运行时数组展开为 N 个并行子任务，聚合结果后交给下游 |
| **异源校验** | dev ↔ review 模型绑定必须不同（保存 / 校验层强制，运行时日志提示） |
| **走通性保证** | 任何蓝图要么走通（DONE），要么以明确终态终止，绝不卡死 |
| **Git worktree 隔离** | 每个任务一个独立 worktree，消除"main 被占用"与"共享工作区互踩" |

### 四套内置工作流

1. **建设 · 完整功能开发** — 需求分析 → 方案设计 → 开发 → 独立审核 → 独立测试 → 人工验收 → 收口
2. **优化 · 快速迭代** — 目标确认 → 执行 → 评估 → 收口
3. **诊断 · 缺陷修复** — 缺陷诊断 → 修复 → 审核 → 回归验证 → 收口
4. **探索 · 多视角探索** — 探索统筹 → 专家研究 Fan-out → 综合分析 → 结论评估

探索模板总研究轮次最多 **3 轮（包含首次 BROAD）**；自动 TARGETED 补充最多 2 轮。

> 历史 `default-workflow` 和 `dev-workflow-2-0` **已迁为 Custom Workflow**（蓝图在 `templates/custom-seeds/`，无内置标签，可覆盖 / 删除），不再作为系统正式标准。

### 12 个内置角色

- **通用能力**：`requirements`（需求分析）、`designer`（方案设计）、`dev`（开发）、`review`（审核）、`test`（测试）、`evaluator`（评估）、`accept`（验收助手）、`closeout`（收口）
- **专业能力**：`diagnose`（缺陷诊断）、`orchestrator`（探索统筹）、`researcher`（专家研究）、`synthesizer`（综合分析）

旧 `dispatcher` 已迁移为 Custom Role。

### 当前状态

项目处于 **v0.1 正式工作流体系收敛阶段**。必须区分两件事：

- **当前 main 已实现基线**：现有 Blueprint / Skill / VWF Runtime 能力；
- **v0.1 目标规格**：正在按 #76–#83 实施的正式 Workflow / Run / Role 模型。

目标规格不是"main 已经具备"的能力清单。实现、Review 和验收必须同时核对实际代码与目标规格。

权威目标规格：[`docs/design/workflow-manager-v0.1-final-product-spec.md`](./docs/design/workflow-manager-v0.1-final-product-spec.md) ｜ 完整版本规划：[`roadmap.md`](./roadmap.md)

**当前 main 已具备**（截至 2026-08-30 形成的可用底座）：

- `templates/*.json` Blueprint 作为具体 Workflow 的唯一事实源；
- 单一校验 / 生成链和行为回归；
- 可视化模板库、画布编辑器和配置面板；
- 保存 Blueprint 后生成 / 更新可运行 Skill；
- Built-in / Custom Role Library 基础能力（#58 / PR #61）；
- Git worktree 工作隔离与验证分支 / HEAD 留痕；
- 测试、审核、人工门禁与失败回路；
- 受限 Fan-out 与结果聚合（#18 / PR #38）；
- 多 run 并行、同 taskId 互斥、人工门禁排队（#19 / PR #41、#44）；
- legacy engine-run 运行历史跨 DSH 重启持久化（#40 / PR #50）；
- DSH 静态组合包产品形态；
- 版本内开发模式 / 发布前产品模式的长期双轨规则。

> 这些能力仍包含早期契约（如 `success/failure` 二态业务路由、`AWAITING_HUMAN_*` / `FAILED_MAX_ROUNDS` 等字符串状态）。它们是当前兼容基线，不是 v0.1 新设计目标。

---

## 2 · 下载与安装

本仓库是**私有工程仓库**（`private: true`，未发布到 npm），因此采用**本地路径安装（link）**，而非从包管理器拉取。

### 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| **DSH** | 插件对齐基线 **v0.1.1-rc.2** | 宿主运行时。本机实测 v0.1.5-rc.1 可用 |
| **Node.js** | 未声明硬性下限；实测 **v22.22.2** | 构建插件产物与执行脚本 |
| **@deepseek-ai/dsh-tools** | 固定 **0.1.1-rc.2** | 静态 bundle 的 `defineTool` 兜底，与宿主版本对齐 |
| **npm / pnpm** | 任意可用版本 | `dsh plugin` 底层即 pnpm（v11.7.0），安装依赖时 `prepare` 会自动构建 |
| **gh CLI** | 可选 | 收口节点建 PR / 关 issue；无远端时退化为本地 commit 清单 |

> ⚠️ 插件产物 `dist/` 和生成物 `.generated/` **均不入库**（已在 `.gitignore`）。克隆后必须先构建，否则 link 安装仍加载旧产物（issue-33 的教训）。

### 安装可视化工作流插件

这是**产品模式**安装，装完随 profile 持久化，重启仍在。

```bash
# ① 获取源码
git clone https://cnb.cool/chris.ai/workflow-manager.git
# 或（历史镜像）：git clone https://github.com/crystepj-max/workflow-manager.git
cd workflow-manager

# ② 构建插件产物（prepare 会自动跑 build-bundle；改过 src/ 后必须重跑）
cd packages/dsh-visual-workflow
npm install
npm run build
npm run check:dist        # 确认 dist 与 src 一致，防加载旧产物

# ③ 安装到 profile（必须用绝对路径）
dsh plugin --profile web add link:/Users/chris/workspace/workflow-manager/packages/dsh-visual-workflow

# ④ 完整重启 DSH GUI → 设置 →「工作流」
```

### 安装 AI 任务技能包

技能包装入公共池 `~/.agents/skills/` 后，**任何项目的 DSH 会话都能按触发词直接调用，无需往项目里复制文件**。

```bash
cd workflow-manager

./dsh/install-requirements-analysis.sh     # 需求分析（定义入口）
./dsh/install-construction-bootstrap.sh    # 建设 · 完整功能开发（单任务交付）
./dsh/install-execution-plan.sh            # 执行计划（批量调度）
./dsh/install-skill.sh                     # dev-workflow-2.0（历史内置工作流）
```

| 技能 | 用途 | 安装后位置 |
|---|---|---|
| `requirements-analysis` | 把原始需求加工为「已定义」任务 | `~/.agents/skills/requirements-analysis/` |
| `construction-bootstrap` | 单任务完整交付工作流 | `~/.agents/skills/construction-bootstrap/` |
| `execution-plan` | 候选任务批量调度（P0 → P1 → P2） | `~/.agents/skills/execution-plan/` |
| `dev-workflow-2-0` | 历史「开发工作流 2.0」 | `~/.agents/skills/dev-workflow-2-0/` |

> 前三个脚本在默认参数下会**交由统一治理**：先同步到 `my-agent-skills` 仓库，再由 `manage-skills.py apply` 分发，避免独立副本覆盖正式来源。
>
> DSH 的技能目录是**会话启动时快照**——新装技能需要**重启会话**才能被 `skill()` 调用。

### 开发模式安装

开发模式只用于**版本内快速迭代**，使用独立 Home `~/.dsh-workflow-dev`，**不安装正式组合包、不改动产品 `$DSH_HOME`、凭据或 Profile**，可与产品 DSH 并行运行。

```bash
cd workflow-manager
npm run dev:plugin            # 查看隔离状态与联合版本标识
npm run dev:plugin -- start   # 启动开发 DSH（系统分配空闲端口）
```

然后在开发会话中按 **联合版本** 一次提交两半（`vwf-dev-<host+client 联合哈希>`）：

1. `cordis_define` 定义该版本，在**同一次 `code` 中同时提交 host 与 client**；
2. `cordis_run` 把完整 Package 作为一次更新激活；
3. `cordis_inspect_self` 核对当前版本标识；
4. 结束开发时先 `cordis_stop`，再 `cordis_undefine`。

> 禁止单独更新 client 或 host —— Cordis update 会先停止旧 Run，只提交一半会让另一半能力消失。
> 开发 DSH 重启后动态插件自动消失是正常行为。

### 验证 / 更新 / 卸载

```bash
# 验证：配置里能看到 visual-workflow 的 patch 层
dsh --profile web --dump-config | grep visual-workflow

# 更新：改 src/ → 重建产物 → 重装（link 指向同一路径，重跑 add 即可）
cd packages/dsh-visual-workflow && npm run build && npm run check:dist
dsh plugin --profile web add link:/绝对路径/packages/dsh-visual-workflow

# 卸载（pnpm 语义）
dsh plugin --profile web remove dsh-visual-workflow
```

发布前必须遵循 `AGENTS.md` 的**开发模式 / 产品模式双轨**：开发态验证不是发布证据，正式发布必须重建产物、完整重启 DSH 并执行真实 E2E。

---

## 3 · 深入了解

### 快速开始

1. **选模板**：设置 →「工作流」→ 模板库，选一个内置模板（如「建设 · 完整功能开发」）或新建。
2. **编译脚本**：在编辑器中打开工作流，点「获取脚本」。
3. **执行**：把脚本交给平台内置 `workflow` 工具执行；回执中的 `runId` 可用于运行看板轮询状态。

`wf_run` 是**条件注册的增强路径**：仅在宿主 `agents` 可用时注册，可直接完成 DSL 编译与执行。若其解析 `workflowEngine` 失败，工具会明确报错——此时回到上面的「获取脚本 → 平台 `workflow` 工具」正式路径即可。

技能包入口（等价的第二条路）：在任意项目会话说「用开发工作流 2.0 跑 issue #N」，技能按 runbook 装配参数并驱动全流程。

### 单一事实源架构

```text
templates/<id>.json
   │
   │  生成 / 校验
   ▼
.generated/<id>/
   ├── script.mjs
   ├── vwf-dsl.json
   ├── SKILL.md
   └── meta.json
   │
   ├─ VWF：可视化编辑 / 保存 / 运行观测
   └─ DSH：生成 Skill 执行
```

约束：

- 人工只修改 **Blueprint** 或对应权威规则文件；
- `.generated/` 是生成物，**禁止手改**；
- 同一 Blueprint 不允许多套业务解释；
- Blueprint / Contract 变更必须有行为回归保护；
- v0.1 Runtime 升级必须向后兼容现有 Custom Workflow。

### 目录结构

| 路径 | 说明 |
|---|---|
| `templates/` | 当前具体 Workflow Blueprint，**唯一事实源** |
| `.generated/` | 生成物，禁止手改 |
| `scripts/` | 编译、校验、行为测试与生成流程 |
| `packages/dsh-visual-workflow/` | 可视化编辑与运行观测插件（本 README 安装主体） |
| `packages/dsh-llm-account-auth/` | DSH 账户鉴权 LLM 适配器 |
| `dsh/` | DSH 侧角色与 Skill 真源、安装脚本 |
| `docs/design/` | 当前 / 目标 Contract 与设计文档 |
| `docs/design/workflow-design-principles.md` | 长期工作流设计原则（方法论权威，#71） |
| `docs/research/` | 调研结论 |
| `specs/` | 已形成的规格 / OpenSpec |
| `wayfinder/` | 决策地图与历史决策 |
| `AGENTS.md` | 项目共同硬规则 |
| `CONTEXT.md` | 当前实现领域术语；目标语义以 v0.1 最终规格为准 |
| `roadmap.md` | 产品 / 架构路线图 |

### 常用命令

```bash
npm run generate        # templates/*.json → .generated/<id>/
npm run validate        # 蓝图校验 + 测试 + 重生成一致性检查
npm test                # 引擎层行为与契约测试
npm run dev:plugin      # 开发模式（隔离 Home）
npm run release:verify  # 发布前完整验收闸门
```

插件包内还有独立闸门：

```bash
cd packages/dsh-visual-workflow
npm test                # host 单测 + client 冒烟 + 静态 bundle + dist 新鲜度
bash verify.sh          # Gate1–4：版本对齐 + 构建 + 新鲜度 + 包测试
```

### 文档权威性

不同类型文档承担不同职责：

1. `AGENTS.md`：项目共同硬规则；
2. [`docs/design/workflow-design-principles.md`](./docs/design/workflow-design-principles.md)：长期工作流设计原则（why / how to design）；
3. `docs/design/workflow-manager-v0.1-final-product-spec.md`：v0.1 正式产品目标规格；
4. `CONTEXT.md`：当前实现术语与兼容语义；
5. `templates/`：当前 main 中具体 Workflow 的唯一事实源；
6. `roadmap.md`：版本顺序和实施依赖；
7. GitHub Issue / PR：施工范围、迁移和验收状态；
8. `main`：实际已经进入产品基线的实现。

原则文档是跨版本方法论；产品规格是某一版本的实例。`CONTEXT.md` 在对应实现进入 `main` 前保持 Current，不提前改成 Target 语义。

> 当目标规格与当前实现不同，这是正常的"迁移中状态"。Agent 必须明确自己是在维护兼容基线还是实施 v0.1 目标，**不能把两者静默混合**。过时设计应显式标记 Historical / Superseded / Deferred。

### 常见问题

**Q：装完插件，设置页看不到「工作流」？**
先确认 `dsh --profile web --dump-config | grep visual-workflow` 有输出；再确认**完整重启**了 GUI（不是刷新页面）。插件目录的技能 / 配置是启动时快照。

**Q：改了 `src/` 但界面行为没变？**
`dist/` 是构建产物且**不入库**。必须 `npm run build` 重建，否则 link 安装仍加载旧产物——`npm run check:dist` 和 `verify.sh` 就是为此设的闸门。

**Q：`wf_run` 工具不存在 / 报错？**
它是条件注册的增强路径，仅宿主 `agents` 可用时注册。用正式路径：编辑器点「获取脚本」→ 交给平台 `workflow` 工具执行。

**Q：开发和产品模式能同时跑吗？**
能。开发 DSH 使用独立 Home 与系统分配的空闲端口。但正式包若被装进开发 Home，`dev:plugin` 会报冲突并中止。

**Q：技能包装了但会话里调不到？**
DSH 技能目录是会话启动时快照，**重启会话**后再试。

### 当前实施主线

```text
#71 全局原则
  ↓
#77 Outcome Routing / Completion
#72 Human Decision
#73 自动回退额度
#78 Formal Records / Provenance
  ↓
#79 Logical Run / Snapshot / Lifecycle
#80 Pause / Guidance / Resume
#74 Preflight Probe
  ↓
#81 12 Roles
#82 四正式 Built-in Workflows
#83 Skill/Chat Invocation
  ↓
#75 UI/交互实施拆分
```

实施总览：#76。Draft PR #70 已关闭且未合并；`feat/multi-perspective-exploration` 分支只作为 #81/#82 的素材库，不得整包直接合入 main。

### 独立分发后置

早期 P2 Epic #6 已关闭为 superseded。以下课题保留但不属于当前 v0.1 frontier：

- #21 独立仓库 + GitHub 分发；
- #45–#48 独立分发相关决策。

这些 Issue 必须在正式 Workflow / Runtime / 资产边界稳定后重新基于届时 main 取证。

### 外部兼容性

#35 跟踪 Minke / DSH 版本兼容问题。它与 Workflow Runtime 产品设计分离：只有当某个版本明确把 Minke 列为支持宿主时，才进入该版本发布门槛。

---

## 4 · 参与贡献

- **硬规则优先**：开工前先读 [`AGENTS.md`](./AGENTS.md)，尤其是开发模式 / 产品模式双轨与发布验收要求。
- **一个任务一个 worktree**：分支惯例 `dev2/<taskId>`，作业目录 `.agent-runs/<taskId>/worktree`，主工作区全程不切分支、保持干净，只承担 push / 建 PR / 合并 / 关 issue。
- **改蓝图不改生成物**：改动落在 `templates/*.json` 后跑 `npm run generate`，`.generated/` 与 `dist/` 禁止手改。
- **推送 / 建 PR / 合并归属收口节点**（2026-08-16 决策）：开发节点只提交到工作分支；收口统一执行 push + `gh pr create --draft` + 合并 + 关 issue。唯一保留的人工动作是**验收裁决**；唯一禁止项是**绕过 PR 直接推送 base 分支**。
- **需求三要素**：目标 / 范围 / 验收标准，是 issue 可施工的最低门槛。
- **文档术语**：新增领域词汇登记到 [`CONTEXT.md`](./CONTEXT.md)，决策记录落在 `wayfinder/MAP.md` 与 `docs/design/`。

---

## 5 · 路线图

```text
v0.1  Formal Workflow Foundation
      Blueprint / Outcome / Formal Records / Logical Run / Snapshot / 12 Roles / 四模板
  ↓
v0.2  Product Interaction & Governance
      UI / Context / Responsibility / Permission / Evidence / S-M-L
  ↓
v0.3  同一需求多角色协作
  ↓
v0.4  多 Coding Agent 执行器
  ↓
v0.5+ 专业 Profile / 动态规划 / 协议与生态
  ↓
Later  独立分发（#21 / #45–#48 重新评估）
```

详见 [`roadmap.md`](./roadmap.md)。

---

## 6 · 许可与状态

- **仓库性质**：私有工程仓库（`private: true`），**未发布到 npm，也未声明开源许可证**（仓库内无 `LICENSE` 文件）。在未明确授权前，代码不对外分发。
- **安装方式**：因未发布到包管理器，一律采用本地路径 `link:` 安装或仓库内安装脚本。
- **第三方素材**：项目中的角色与工作流设计引用 Gold-Band 桌面端《工作流编辑器》作为 UI / 交互对齐参考。
- **版本对齐**：插件依赖 `@deepseek-ai/dsh-tools@0.1.1-rc.2`，与宿主 DSH v0.1.1-rc.2 对齐。宿主升级后若 `defineTool` 签名变更，需同步调整插件并重建产物。
