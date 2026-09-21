# Definition Check · FIX-245 归属记录修复（agent 身份自动识别）

## 检查元数据

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-245` |
| 远端 issue | github#245 |
| 检查对象 | 让 `origin_agent` 由「无人会设的环境变量」改为「从运行期环境事实自动识别」，并在取不到身份时出声 |
| 检查时间 | 2026-09-21 |
| 结论位置 | 本文末「结论」节 |

## 9.1 目标与范围

- [x] 目标限定为：单机多 agent 并行时，每条新建任务记录都能自动带上真实执行会话的 agent 名称
- [x] 只改身份解析与它的调用点；不改施工认领互斥规则、不改登记册结构与既有字段语义
- [x] 不引入任何需要人工配置的新开关（这是本次缺陷的成因，不能再用同类方案修）
- [x] 明确排除：进程祖链识别（本机沙箱禁止读取进程信息，实测提权后仍不可得）
- [x] 明确排除：对历史 87 条空归属做回溯填充（无证据可依，填了即伪造留痕）

## 9.2 现状证据

- [x] 缺陷已量化：`docs/tasks/registry.json` 共 88 条，`origin_agent` 为 `null` 者 **87 条**，仅 1 条为 `CodeBuddy`
- [x] 根因定位到行：`scripts/local-task-registry.mjs` 的 `newRecord()` 与 `scripts/github-issues.mjs` 的两处调用点均写死 `process.env.AI_AGENT_NAME ?? null`
- [x] 缺陷当场重现：本票用 `allocate` 发号时，返回的 JSON 中 `origin_agent` 为 `None`（见发号输出），即缺陷在修复前确实可复现
- [x] 「机器码无法区分 agent」已实测：`machineCode()` 源自 `os.hostname()`，本机恒为 `chrisdem`；登记册中 42 条为同一值
- [x] 宿主自报指纹已实测可取：本会话环境内 `CLIENT_INFO_IDE_TYPE` = `WorkBuddy`、`WORKBUDDY_APP_NAME` = `WorkBuddy`，两者互相独立佐证
- [x] 指纹传递性已实测：在 `node → sh` 两级孙进程中仍稳定读到 `WorkBuddy`，故对任意子进程可用
- [x] 进程祖链路径已实测排除：沙箱内 `ps` 报 `operation not permitted`，提权后仍取不到输出
- [x] 变量名清单已核对：现有代码中除上述两处外，全仓脚本无其他 `AI_AGENT_NAME` 取值点（改后全域已无裸取）

## 9.3 验收标准

- [x] 每条标准可复现，且以测试为判据：`node --test scripts/test/agent-identity.test.mjs`（期望 `pass 9 fail 0`）
- [x] 显式覆盖优先：`AI_AGENT_NAME` 存在时压过宿主标识与通用约定
- [x] 宿主自报可识别：无显式覆盖时取 `CLIENT_INFO_IDE_TYPE`
- [x] 通用约定可识别：`CURSOR_AGENT_NAME` / `CODEX_AGENT_NAME` 等任意 `*_AGENT_NAME` 均被识别（未来 agent 免改代码）
- [x] 空串不误判：指纹变量为空白时不视为命中，继续向后取值
- [x] 兜底文件生效：环境无痕迹时读仓库根 `.agent-identity`
- [x] 取不到不伪造：三级全空返回 `null`，不猜、不给默认值
- [x] 记录确实落盘：`allocate` 后登记册条目与 CLI 输出均带 agent 名（测试内二次读取登记册断言）
- [x] 不静默留空：无身份时 `allocate` 在 stderr 输出明确告警，且**不阻断**（记录仍落盘）
- [x] 改动面可机器断言：`git diff --name-only` 不含 `templates/`、不含生成物

## 9.4 依赖与前置

- [x] 无跨票代码依赖：身份解析为纯函数，调用点各自独立
- [x] 工具依赖已确认：`gh` 已登录 `crystepj-max`，发号得到 `github#245`
- [x] 施工隔离：本票在独立 worktree `fix-agent-identity-attribution` 施工，不动主检出内并行会话的在制内容
- [x] 兜底文件已加入 `.gitignore`，不会污染提交

## 9.5 风险与回归

- [x] 回归面已覆盖：`scripts/test/local-task-registry.test.mjs`、`github-issues.test.mjs`、`local-task-registry-mark-ready.test.mjs`、`ai-task-source-admission.test.mjs` 合计 55/55 通过
- [x] 全量引擎层已跑：`836/836` 全绿（含本票新增 9 项）
- [x] 包测试已跑：`dsh-llm-account-auth` 14/14、`dsh-visual-workflow` 全绿
- [x] 蓝图与生成结果零影响：`① 蓝图校验` 6 份合法、`② 重生成一致性` 37 个文件一致、`②′ 生成指南漂移` 通过
- [x] 与本票无关的红灯已用基线对照排除：
  - `validate-workspace` 的 9 项（D-1b/D-2/D-3/D-4/D-5/D-7/D-8/D-9/D-10）在**干净 `origin/main` 上同样 9 项**失败，属工作区治理历史遗留
  - `dsh-llm-account-auth` 曾失败一次，经排查为**新建 worktree 缺 `node_modules`** 的环境问题，装上依赖后 14/14 通过，非本票引入
- [x] 残留风险如实登记：除 WorkBuddy 外，其余 agent 的宿主自报变量名**本会话无法实测**，只能靠 `*_AGENT_NAME` 通用约定或 `.agent-identity` 兜底；后续各 agent 会话补测后可另行回填对照表

## 结论

**通过。** 目标范围明确、根因定位到行、缺陷在修复前可复现、验收标准全部以测试为判据且已实测通过；与本票无关的两处红灯均已用基线对照法排除，未纳入本票范围。
