# FIX-245 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-245` |
| 远端 issue | github#245 |
| 需求来源 | 会话录入：松哥指出归属记录长期为空 |
| 来源定位 | 2026-09-21 复盘 PR #218 时，问题「谁提交的就记录谁」被提出；核查登记册发现 88 条记录中 `origin_agent` 有 87 条为空 |
| 任务名称 | 归属记录修复：agent 身份自动识别（宿主自报名字 + 机器码），杜绝静默留空 |
| 任务类型 | 缺陷修复（编号类型 FIX） |
| 优先级 | P1 |
| 定义时间 | 2026-09-21T00:39:20Z |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FIX-245-agent-identity-attribution/task-spec-V1.md` |
| GitHub 同步 | synced#245 |

> 取值约束：`无人值守许可` 只写枚举原值，`GitHub 同步` 只写 `pending` / `synced#N` / `not-applicable`。

## 摘要

未决产品事项：0

### 问题

任务登记册要求记录「谁提交的」，但 `origin_agent` 实际长期为空。实测 `docs/tasks/registry.json`：**88 条记录中 87 条为 null**，仅 1 条写了 `CodeBuddy`。

根因不是没人愿意填，而是**唯一取值来源没人会去设**：

- 登记册侧 `scripts/local-task-registry.mjs` 与施工认领侧 `scripts/github-issues.mjs` 两处都写死 `process.env.AI_AGENT_NAME ?? null`。
- 该变量的名字在全仓只出现在一份任务规格里，**`AGENTS.md` 与 runbook 中没有任何一条规则要求会话设置它**——照着仓库规则干活的 agent 不会知道有这回事。
- 同一台机器上 `machineCode()` 一律返回同一个主机名（本机 `chrisdem`），**机器码无法区分 agent**，`origin_agent` 是单机多会话并行时唯一的区分依据。

三者叠加的后果：同一台 Mac 上并行跑多个 agent 时，归属必然塌缩成同一个空值，**且不报错、静默留空**。已产生的空记录无任何证据可依，**不做回溯填充**（视为伪造留痕）。

### 处理

身份解析收敛为单一入口 `agentName()`，三级取值命中即返回：

1. 宿主自报变量：`AI_AGENT_NAME`（显式覆盖）→ `CLIENT_INFO_IDE_TYPE`（宿主标识，本机实测为 `WorkBuddy`）
2. 通用约定：任何 `*_AGENT_NAME` 变量（新 agent 按约定命名即可自动被识别，无需改代码）
3. 兜底文件：仓库根 `.agent-identity`（本机标记，已加入 `.gitignore`）
4. 三级全空 → 返回 `null`，由 `allocate` 在 stderr **显式告警**，不伪造、不静默

不依赖任何人工配置项：身份取自环境事实（与施工认领身份同一口径，避免「配置写了别人的名字」这种伪留痕）。同时明确**不采用进程祖链识别**——本机沙箱禁止读取进程信息，实测提权后亦取不到，该路径不可用。

### 实测结果（见 `specs/FIX-245-agent-identity-attribution/definition-check.md`）

| 项 | 结果 |
|---|---|
| 新增 `scripts/test/agent-identity.test.mjs` | **9/9 通过**（含 2 项真实子进程 CLI 用例） |
| 相关既有用例（registry / github-issues / mark-ready / 任务源准入） | **55/55 通过** |
| `③ 引擎层测试` 全量 | **836/836 全绿** |
| `③′ 包测试`（dsh-llm-account-auth、dsh-visual-workflow） | **两个包均全绿** |
| `① 蓝图校验` / `② 重生成一致性` / `②′ 生成指南漂移` | 全绿 |

### 范围与边界

- 改动限于身份解析与调用点收敛，**不改蓝图、不改生成结果、不改施工认领互斥逻辑**。
- 未纳入本票：CI runner 缺 git 身份、`validate-workspace` 的 D-* 工作区治理项——均已实测确认与本票无关（见 Definition Check 的基线对照）。
- 已产生的 87 条空归属**不回溯**：无证据可依，填了就是伪造。
