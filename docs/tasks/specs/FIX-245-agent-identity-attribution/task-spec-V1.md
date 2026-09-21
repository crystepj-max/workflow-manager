# 归属记录修复：agent 身份自动识别（宿主自报名字 + 机器码）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | github#245（本地轨道 `FIX-245`） |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（纯本地脚本改动，判据为可复现单测，无需产品 DSH 实测） |
| 定义时间 | 2026-09-21T00:39:20Z |
| 当前状态 | 本地已定义 |
| 分类 / 体量 | bug ｜ sized-s（一个解析器 + 三处调用点 + 一条仓库规则） |

## 1. 背景与问题

仓库要求「**谁提交的就记谁**」——任务登记册的 `origin_agent` 应反映真实执行会话的 agent。实测 `docs/tasks/registry.json`：**88 条记录中 87 条 `origin_agent` 为 `null`**，仅 1 条为 `CodeBuddy`。

根因是**取值来源本身不可达**，而非记录意愿问题：

| # | 事实 | 证据 |
|---|---|---|
| 1 | 身份只有一个来源 | `scripts/local-task-registry.mjs` 与 `scripts/github-issues.mjs` 两处均写死 `process.env.AI_AGENT_NAME ?? null` |
| 2 | 没有任何规则要求会话设置它 | 该变量名在全仓仅出现在一份任务规格中；`AGENTS.md` 与 runbook 零提及 |
| 3 | 机器码无法区分 agent | `machineCode()` 源自 `os.hostname()`，本机恒为 `chrisdem`，登记册中 42 条同值 |

三条叠加 ⇒ 同一台机器上并行多个 agent 时，归属必然塌缩为同一个空值，**且不报错、静默留空**。

## 2. 目标与非目标

**目标**：单机多 agent 并行时，每条新建任务记录都能自动带上真实执行会话的 agent 名称；取不到身份时必须出声，不得静默留空。

**非目标**（明确排除）：

- 不引入任何需要人工配置的新开关——这正是本次缺陷的成因，不能用同类方案修。
- 不做进程祖链识别：本机沙箱禁止读取进程信息（`ps` 报 `operation not permitted`，提权后仍取不到），该路径不可用。
- 不对历史 87 条空归属做回溯填充：无证据可依，填了即伪造留痕。
- 不改动施工认领互斥逻辑、不改登记册字段语义、不改蓝图与生成结果。

## 3. 方案

身份解析收敛为单一入口 `agentName()`（`scripts/local-task-registry.mjs`），三级取值，命中即返回：

| 级别 | 来源 | 说明 |
|---|---|---|
| ① | `AI_AGENT_NAME` → `CLIENT_INFO_IDE_TYPE` | 宿主自报。本机实测 `CLIENT_INFO_IDE_TYPE` = `WorkBuddy`，与 `WORKBUDDY_APP_NAME` 互相独立佐证；已在 `node → sh` 两级孙进程中验证稳定传递 |
| ② | 任意 `*_AGENT_NAME` | 通用约定：新 agent 按约定命名即可被自动识别，无需改代码 |
| ③ | 仓库根 `.agent-identity` | 兜底文件，供不自报名字的 agent 写一次；已加入 `.gitignore` |
| — | 三级全空 | 返回 `null`，由 `allocate` 在 stderr **显式告警**，不伪造、不静默 |

调用点收敛为三处：`newRecord()`、`github-issues.mjs` 的 `claimIssue` 与 `releaseIssue`。改后全仓脚本不再有裸取 `process.env.AI_AGENT_NAME` 之处。

## 4. 验收标准

| 编号 | 标准 | 判据 |
|---|---|---|
| AC-01 | 显式覆盖优先 | `AI_AGENT_NAME` 压过宿主标识与通用约定 |
| AC-02 | 宿主自报可识别 | 无显式覆盖时取 `CLIENT_INFO_IDE_TYPE` |
| AC-03 | 通用约定可识别 | `CURSOR_AGENT_NAME` / `CODEX_AGENT_NAME` 等任意 `*_AGENT_NAME` 被识别 |
| AC-04 | 空串不误判 | 指纹变量为空白时不命中，继续向后取值 |
| AC-05 | 兜底文件生效 | 环境无痕迹时读仓库根 `.agent-identity` |
| AC-06 | 取不到不伪造 | 三级全空返回 `null`，不猜、不给默认值 |
| AC-07 | 记录确实落盘 | `allocate` 后 CLI 输出与登记册条目均带 agent 名 |
| AC-08 | 不静默留空 | 无身份时 stderr 有明确告警，且不阻断（记录仍落盘） |

全部判据落在 `scripts/test/agent-identity.test.mjs`，含 2 项真实子进程 CLI 用例（覆盖参数解析与 stderr 层）。

## 5. 影响面

- 蓝图与生成结果：**零影响**（未触碰 `templates/`）。
- 既有行为：身份从「恒为 null」变为「自动识别」；对已正确设置 `AI_AGENT_NAME` 的会话行为不变。
- 回归面：`local-task-registry` / `github-issues` / `mark-ready` / 任务源准入合计 55 项用例。

未决产品事项：0
