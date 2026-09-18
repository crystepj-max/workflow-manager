# P2 定义核验记录

本轮仅分析，没有重构代码、运行付费实验或测试目标功能。沿用本会话已核实的本地轨道；GitHub此前返回账号暂停403，本轮未宣称远端状态恢复或已创建Issue。

检查工作HEAD为 `775ac84e9c37e2278c2ee32a0f2bcb75cbbb8172`，本地main为 `909ae5f7aed687098045daefb8bf3d4ee8825688`；main多出的LOC-023状态文档不被本轮覆盖。分配前当前登记册43条、主检出33条，尚无LOC-044/045；本轮使用现有registry的allocate/update接口分配两项。

## 现状与定义决策

| 来源 | 本轮证据 | 收敛结果 |
|---|---|---|
| [WR-021](../research/workflow-review-requirements-2026-09-14/WR-021.md) | [generate](../../scripts/generate.mjs)构造检查点/多种恢复载荷；[host](../../packages/dsh-visual-workflow/src/host.js)有canonicalStop/lifecycleFor、extractCheckpoint、buildPauseResumeArgs与多个恢复入口；[projection](../../scripts/projection-core.cjs)已是纯计算单源 | 只抽取可证明重复的状态/恢复规则；生产消费不同职责不强行合并；既有投影内核继续复用 |
| [WR-022](../research/workflow-review-requirements-2026-09-14/WR-022.md) | 源建议明确12任务×3基准、候选按适用子集，未有真实收益记录；P1的LOC-042/043是未确认候选 | 固定36次基准+C1九次+C2三次，上限48；可独立采集，不硬依赖P1；模型配置和费用仍需真实决定 |
| 环境 | [runbook](../../dsh/skills/construction-bootstrap/runbook.md)为共享9527且单活跃插件；本轮提供的AGENTS要求Run独占Home | P2单独呈递环境安排确认，不能沿用P1未批准提案；本轮没有操作DSH |

## 外部方法参考

本轮打开核验 [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)，借鉴其“按效果增加复杂度、权衡质量与成本”的方法。文章的工具生态部分已提示随时间变化；这里不据此选择模型/价格，也不把它当成20%阈值或48次样本量的科学证明。具体任务、阈值和预算边界均是本项目V1提案。

## 证据限制

- 本轮不重跑与纯文档分析无关的整套产品测试；P1的七项探针和旧评审195项检查均不冒称本轮目标验收。
- 尚未执行LOC-044前后行为对照或真实打包恢复；尚未执行LOC-045的36/48次真实样本。两条均未开发、未验收。
- 材料检查覆盖19节规格、原始8项AC、8组UAT、相对路径、登记册一致、既有P0/P1文件与记录保全；预检预期拒绝未获确认的任务。
- 现有preflight不会检查研究任务的实验预算/模型配置。即使未来字段检查通过，也不能替代LOC-045的实验授权门；本轮不制作会暗示可自动跑付费研究的通用批次配置。
- 所有材料处于本工作区，尚未提交/合入main/同步CNB。相对链接可迁移不等于远端已可获取。
