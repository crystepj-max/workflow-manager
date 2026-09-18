# P1 定义现状核验与证据边界

本文件用于需求定义，不是产品实现报告或人工验收凭证。

## 检查基线

- 实际工作分支：`sync/main-p0-loc024-033`；HEAD：`775ac84e9c37e2278c2ee32a0f2bcb75cbbb8172`。
- 本地 main：`909ae5f7aed687098045daefb8bf3d4ee8825688`。相对工作 HEAD 仅新增 LOC-023 状态/验收文档变化；本轮不回退或覆盖该变化。
- 原评审：`8e38d74955c67f0f196c93eb880cfef7cce71cbd`。至本轮已有共享 DSH 资源调整和 heteroCheck 档位等运行修改，故不能宣称源码毫无变化；下面按当前实际代码重新核对。
- GitHub 仓库读请求本轮实际返回账号暂停的 HTTP 403；走本地任务载具。未将 CNB 当作已接入的任务状态机，也未检查/修改 CNB PR。
- 本轮使用 Node.js `v24.14.1`。没有调用真实模型，没有启动开发/产品 DSH，没有执行目标功能 UAT。

## 按条目的现状证据

| 来源 | 当前事实与接入点 | 对定义的影响 |
|---|---|---|
| WR-007 | [records-host](../../scripts/records-host.mjs) 的 `dependenciesOf` 给 Proof 加所有当前节点/产物；普通结果无真实消费边 | 依赖 LOC-024 的输入绑定及 LOC-029 的稳定 attempt，补准确失效，不重做存储层 |
| WR-008 | [生成器](../../scripts/generate.mjs) 提示 output.files；[探索模板](../../templates/wf-explore.json) 报告命名不含轮次 | 定义宿主读字节、固定版本和 manifest，不能只补文件名 |
| WR-010 | 当前探索首轮专家数组没有强制 3–5；本轮 zero-experts 探针仍为 DONE、0 调用 | 必须机械校验人数、目标映射和覆盖；耗尽行为需明确产品决定 |
| WR-014 | [closeout](../../dsh/roles/closeout.md) 仍混合事实、GitHub 操作和资源清理 | 固定 local/GitHub 范围、授权边界和失败语义；CNB 缺能力明确暴露 |
| WR-015 | [runPreflight](../../scripts/ai-task-preflight-check.mjs) 已有结构化入口；建设模板仍有资格 evaluator，检查对 Definition Check 文本很宽松 | 共用现有入口，严格检查实际勾选与依赖，不另造平行检查平台 |
| WR-016 | [runtime harness](../../scripts/test/helpers/runtime-harness.mjs) 明确只有八关键字；[Portable 校验](../../scripts/cwf-validate.mjs) 支持更多；四模板当前没有共同协议版本字段 | 源建议“复用现有版本字段”不符合当前实现，改为明确新增有限子集标记；不混合两套协议 |
| WR-017 | [CONTEXT](../../CONTEXT.md) 的 fanout 尚有规划中措辞；生成器 DONE 指南泛化合并/清理 | 文档切片独立成立，按实际 main 修正，不依赖未来功能上线 |
| WR-018 | [host](../../packages/dsh-visual-workflow/src/host.js) 以 Run 工作区启动；生成器 agent opts 无节点 cwd；[freezeReadOnly](../../scripts/workspace-isolation.mjs) 有尽力 chmod/chflags | 不能把提示/文件位当强隔离；限定公开子进程 Profile 适配，真实拒绝探针为必需验收 |
| WR-019 | 七项复现可运行但脚本写死作者路径；测试替身不能证明真实模型行为 | 交付可迁移样板和消费链断言，明确报告层次及既有产品失败 |
| WR-020 | 本轮循环探针实际 8 调用、3 次评估，最终只留 4 个逻辑 attempt、1 个评估 Revision | 必须依赖 LOC-029 逐次持久化；不得从最终结果推算历史成本 |

## 七项当前复跑

运行现有 `workflow-design-review-probes.mjs` 和 `workflow-design-review-feedback-probe.mjs`，详见 [本轮结果 JSON](p1-definition-probes-2026-09-15.json)。脚本自身打印的 baseline 是写死的旧评审值，本轮存档已单独保留该字段并明确实际执行 HEAD，不能误当旧版本复跑。

| 探针 | 本轮观察 |
|---|---|
| technical-retry | 1000 次调用后 FAILED_AGENT_CAP，budgetUsed 为 null |
| recoverable-blocked | 专业 BLOCKED，执行结果 DONE，宿主 COMPLETED/terminal=true |
| zero-experts | 0 名专家仍 DONE |
| contradictory-verdict-and-head | 矛盾 review/test 与不同 HEAD 仍到 WAITING_HUMAN |
| contract-and-completion-drift | 评价契约 A/B 不同，仍 USER_ACCEPTED 且无人工决定 |
| loop-attempt-loss | 8 次调用被最终结果折叠成 4 个逻辑 attempt |
| feedback-handoff | 第二次执行未收到本次评估缺口标记和明确报告引用 |

这些是**当前源码 + 测试替身**可复现的行为，不是新写的目标测试通过，也不是生产故障频率。替身中模型探针不可用和工作区集成缺失会回退，因此不用于证明真实宿主安全边界。原评审的 195 项检查属于历史证据，本轮没有声称重跑该整套检查。

## 宿主路径调查

读取本机 deepseek-harness 源码 HEAD `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`，没有编辑上游。对应公开源码定位：

- [SDK 子进程 provider 配置](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/subagent/subagent-dsh-sdk/src/index.ts)：独立 profile、patches、dshHome、cwd；cwd 是配置加载时解析的目录，不是现有 agent 调用中任意可加的节点参数。
- [子进程运行入口](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/subagent/subagent-dsh-sdk/src/run.ts)：以 spec.cwd 创建子进程/会话。
- [会话沙箱策略](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/sandbox/sandbox-policy/src/index.ts)：会话 cwd 决定 workspace-write 根，实际约束仍依赖已安装的 enforcing capability。

引用指向本轮读取的源码版本；没有把网页可达性或该源码对应的当前产品安装状态标为验证通过。已识别的工程路线是注册受控的节点 provider/配置和独立可写根，配合有效文件与进程沙箱，而不是往引擎未支持的 agent opts 注入 cwd。真实 API 版本、直接 shell/网络限制和合法测试仍需开发时实测；失败时按 LOC-041 规则受阻，不能伪称已实现。

## 开工与批量能力

当前 [runbook](../../dsh/skills/construction-bootstrap/runbook.md) 还规定共享 9527 只允许一个任务激活插件，切换时可能重启环境。本批候选默认并发 1，执行者不得抢占其他活跃任务。当前实现与本轮提供的 AGENTS“每 Run 独占 Home”要求存在冲突，已经在 D-BATCH 明列为人工选择，未以代码现状静默覆盖指令。

[批量计划脚本](../../scripts/ai-task-execution-plan.mjs) 的 `assessCandidate` 对任何非“无”的依赖直接排除；[独立环境计划器](../../scripts/ai-task-workspace-env.mjs) 不自动核验跨组依赖。当前可用措施是执行者在 Run 创建前记录前置合入证据，再进入单任务；不是假称系统已有自动拓扑调度。

新增材料的实际结构/路径检查和预检结果分别存档。当前预检预期拒绝 10/10，原因为尚未定义与缺无人值守许可；这证明草稿没有被提前放行，**不是开工成功**。
