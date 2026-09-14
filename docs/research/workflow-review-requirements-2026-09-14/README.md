# 工作流评审优化需求包

**已将评审建议拆为 22 条可独立交接、独立验收的需求：10 条 P0、10 条 P1、2 条 P2。** 每条均包含问题来源与链接、明确规则、可检查验收、开发前置及接口归属、影响范围和优先级。所有原评审优化方向均有对应条目，详见覆盖矩阵。

| 项目 | 内容 |
|---|---|
| 输入 | [2026-09-14 系统评审](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-2026-09-14.md) |
| 评审基线 | 本地 `HEAD = main = 8e38d74955c67f0f196c93eb880cfef7cce71cbd`，未获取远端最新状态 |
| 本包版本 | 建议 V1，2026-09-14 |
| 本次交付 | 22 份独立需求文件、索引、机器清单及评审证据存档 |
| 状态边界 | 已完成需求拆分与文档校验；优化尚未实施；未创建 Issue、登记已定义任务或启动开发 |

## 阅读与交接

给接手 agent 一条 `WR-xxx.md` 即可获得该需求必要上下文；不需要重读整篇评审才能知道范围。链接使用本工作区绝对路径；迁移工作区时以链接标签中的仓库相对路径定位，源码事实以本包记录的基线为起点重新核对。需求 ID 是本评审包标识，不占用项目正式 `LOC-xxx` 或远端 Issue 编号。

“独立”指交付边界和验收独立，不假设所有需求没有技术依赖。硬前置只保留前一条未完成就无法正确实现本条的接口；修改同一文件不算硬依赖。优先级是建议顺序，不是工期或排期承诺。

项目已确认的建设定义外置、人工严格三态、业务返工上限 3 与 Current/Target 权威关系继续有效。新增裁决映射、重试时间限额和实验门槛均作为可审阅的 V1 建议写清，未伪造用户已确认记录。文档完整不等于自动获得正式“已定义”、无人值守或外部发布资格；后续接入现有任务流程时沿用已有有效批准并记录实际授权，不新增一套定义流程。

## 需求总览

| 需求 | 独立交付目标 | 建议优先级 | 硬前置 |
|---|---|---|---|
| [WR-001](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-001.md) | 显式交接节点输入与返工反馈 | P0 | 无 |
| [WR-002](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-002.md) | 阻止互相矛盾的裁决进入下一质量关口 | P0 | 无 |
| [WR-003](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-003.md) | 将审核与测试证明绑定到真实候选成果 | P0 | 无 |
| [WR-004](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-004.md) | 系统冻结并核验优化评价契约 | P0 | 无 |
| [WR-005](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-005.md) | 人工接受完成必须具备真实决定与版本来源 | P0 | WR-003 |
| [WR-006](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-006.md) | 逐次持久化节点执行与成果提交 | P0 | 无 |
| [WR-007](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-007.md) | 按实际输入版本维护依赖与证明失效 | P1 | WR-001, WR-006 |
| [WR-008](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-008.md) | 声明、核验并索引实际交付产物 | P1 | WR-006 |
| [WR-009](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-009.md) | 统一受阻、恢复与完成的生命周期语义 | P0 | 无 |
| [WR-010](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-010.md) | 落实探索覆盖度与定向补充规则 | P1 | 无 |
| [WR-011](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-011.md) | 限制技术重试、超时与无进展循环 | P0 | 无 |
| [WR-012](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-012.md) | 恢复执行时防止重复外部动作 | P0 | 无 |
| [WR-013](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-013.md) | 收敛内置角色职责并由节点提供场景信息 | P0 | 无 |
| [WR-014](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-014.md) | 将收口事实整理与授权交付动作分离 | P1 | WR-012 |
| [WR-015](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-015.md) | 建设实施前检查复用现有确定性判定 | P1 | 无 |
| [WR-016](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-016.md) | 声明协议版本与可执行的 Schema 能力 | P1 | 无 |
| [WR-017](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-017.md) | 收敛 Current、Target、Legacy 文档与生成运行指南 | P1 | 无 |
| [WR-018](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-018.md) | 由宿主落实节点权限与独立证明边界 | P1 | 无 |
| [WR-019](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-019.md) | 建立四模板的消费方契约与代表性端到端验收 | P1 | 无 |
| [WR-020](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-020.md) | 提供按 Run、节点和尝试关联的质量成本记录 | P1 | WR-006 |
| [WR-021](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-021.md) | 提炼状态与恢复核心，减少跨生成器和宿主的重复维护 | P2 | 无 |
| [WR-022](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/WR-022.md) | 用代表任务度量模板复杂度并形成简化决策 | P2 | 无 |

## 优化建议覆盖矩阵

| 原评审建议 | 对应需求 |
|---|---|
| F1：普通输入与返工反馈 | WR-001 |
| F2：矛盾裁决、成果版本、评价基线、人工完成来源 | WR-002、WR-003、WR-004、WR-005 |
| F3：逐次执行、精确依赖、必需产物 | WR-006、WR-007、WR-008 |
| F4：受阻/完成/恢复与 M2 额度解释 | WR-009 |
| F5：探索人数、唯一性、部分失败、定向补充、完成类型 | WR-010；动态产物归 WR-008 |
| F6：失败分类、有限重试、超时、无进展、副作用幂等 | WR-011、WR-012 |
| 角色工程耦合、规则冲突及 12 角色清单 | WR-013 |
| 收口职责、发布授权、适配与清理 | WR-014 |
| 机械 preflight 复用 | WR-015 |
| 协议版本、Schema 支持子集、最小 envelope | WR-016 |
| Current/Target/Legacy、按模板生成 runbook、兼容收敛 | WR-017 |
| 宿主最小权限与独立证明 | WR-018 |
| 消费方契约、四代表场景、真实安装产品验收 | WR-019 |
| 运行可观测性与质量/成本指标 | WR-020 |
| 状态/恢复纯逻辑、必要适配保留、避免重写 | WR-021 |
| 调用开销比较、以效果决定是否简化 | WR-022 |

## 四模板与角色覆盖

| 模板 / 资产 | 重点需求 |
|---|---|
| 建设：evaluator → dev → review → test → accept → 人工三态 → closeout | WR-001/002/003/005/009/013/014/015/018/019 |
| 优化：requirements → dev → evaluator → closeout | WR-001/004/005/011/013/014/019/022 |
| 诊断：diagnose → dev → review → test → closeout | WR-001/003/009/011/013/014/019 |
| 探索：orchestrator → researcher → synthesizer → evaluator | WR-006/008/010/013/018/019/022 |
| designer 与全部 12 个角色的通用职责 | WR-013；designer 保留为定义或自定义场景资产 |
| 公共运行底座与样板契约 | WR-006/007/008/009/011/012/016/017/020/021 |

## 开发依赖与接口所有权

硬依赖链共 6 条边，无环：`WR-003 → WR-005`；`WR-001 + WR-006 → WR-007`；`WR-006 → WR-008`；`WR-012 → WR-014`；`WR-006 → WR-020`。

| 接口 | 唯一需求所有者 | 主要消费方 / 接续约定 |
|---|---|---|
| 节点输入绑定与 resolved_inputs | WR-001 | WR-007；无正式 Record 时只提供明确标注的临时引用 |
| candidate_ref 与版本核验 | WR-003 | WR-005；Git 同时考虑未提交内容，非 Git 使用声明集合摘要 |
| evaluation_baseline_ref | WR-004 | 优化执行与评估，重新确认显式升版 |
| Decision 校验与完成来源 | WR-005 | WR-009 负责生命周期映射，不重复判人工授权 |
| attempt_id / 提交 ID / 逐次记录接口 | WR-006 | WR-007/008/020 |
| 精确 dependencies 与 stale | WR-007 | 证明与成果消费者；只依据实际正式输入 Revision |
| artifact_manifest | WR-008 | WR-010 及其他文件成果消费者 |
| 生命周期和终止描述 | WR-009 | WR-011 输出失败原因；WR-017 生成一致说明 |
| 技术预算 / 无进展 | WR-011 | WR-020 汇总，业务额度维持原规则 |
| operation_id / 执行与回读 | WR-012 | WR-014 适配授权交付动作 |
| 版本与能力注册 | WR-016 | 各字段所有者登记能力，不接管其业务规则 |
| 节点能力与真实权限保证 | WR-018 | WR-013 角色声明引用实际能力 |

WR-019 可先交付真实暴露缺口的验证体系；各修复未完成时保留失败，不能要求全部先绿才开始建测试。WR-021 没有业务硬前置，但建议在状态修复稳定后做，以减少核心文件冲突。WR-022 可利用既有日志人工采集，不必等待看板完成。

## 建议推进批次

1. 先处理错误放行和失控消耗：WR-002/003/004/009/011/013，并启动 WR-012；WR-003 完成后接 WR-005。
2. 补齐可靠交接：WR-001/006，随后 WR-007/008/020；WR-010/015/016/017/018 可按资源独立安排；WR-012 后接 WR-014。
3. WR-019 从首批起建立验收资产并逐步闭合真实环境证据；最后实施 WR-021，并以 WR-022 判断是否值得进一步简化。

同改 `scripts/generate.mjs`、宿主或模板时使用独立工作区，串行整合或明确文件边界。不得为了减少合并冲突把所有条目并成一个大需求，也不得靠多个 agent 共用一个未隔离现场解决。

## 完整性与证据边界

- [文档校验结果](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/validation-report.md)：22 条需求、89 条验收条件、6 条无环硬依赖；逐项结构与引用检查通过。
- 每条含来源、现状、必要性、目标、具体规则、正反向验收、代表操作、模块/数据接口、前置、范围、风险与交付要求。
- [机器清单](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/requirements.json) 用于检查 ID、优先级、依赖和验收项；各 Markdown 是详细语义来源，后续改动须同步两者。
- [评审证据说明](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/evidence/README.md) 保存原自动检查和复现材料。本次只做文档与引用/依赖校验，没有重新宣称 195 项测试针对尚未实施的优化通过。
- 这些条目足以独立进入需求分析和实施准备；正式开工状态与授权按项目现有任务契约登记，未填造无人值守许可或人工确认人。


## P0 定义接续

10 条 P0 已进入正式任务定义，分配 LOC-024–033；当前状态与开工检查以[本轮定义清单](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/tasks/p0-workflow-readiness-2026-09-14.md)为准。原 WR 文件保留作为需求建议来源，正式 V1 规格与卡片见该清单。
