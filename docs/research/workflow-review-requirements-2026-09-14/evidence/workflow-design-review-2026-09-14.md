**Workflow Manager 工作流设计机制系统评审**

审查日期：2026-09-14。基线：本地 `HEAD = main = 8e38d74955c67f0f196c93eb880cfef7cce71cbd`。未拉取远端更新。本次为只读评审，未修改仓库代码、模板、角色或配置。

**总体判断：通用编排底座已经形成，但跨场景协作、证据留存和业务完成判定尚未形成一致的运行时保证。局部存在过度工程化，主要来自重复契约、兼容层和角色中的工程流程耦合；4 种工作流机制与能力型角色本身有保留价值。**

| 评审维度 | 结论 | 首要改进方向 |
|---|---|---|
| 通用数据契约与通讯协议 | 部分成立；控制流标准化较好，输入交接、业务语义和版本证明存在缺口 | 显式输入引用、逐次执行记录、确定性的状态与证据检查 |
| 架构复杂度与业务需求匹配 | 核心概念有业务依据；模板作者与执行角色承担了过多协议细节 | 收敛角色职责、减少重复状态解释、复用已有机械检查 |
| 成熟工程实践对照 | 已有模块测试、工作区隔离、版本记录和发布验证分层；仍缺关键的不变量验证 | 端到端契约测试、有限重试与幂等、权限分工、质量与成本度量 |

**审查范围与证据口径**

查阅覆盖长期设计原则、v0.1 产品目标、Current 术语、M2 单任务交付契约、Portable Contract、七类建设交接样例、4 套蓝图与全部 12 个内置角色、生成器、校验与投影、Logical Run/Records/Workspace 的关键接线，以及相关测试和 Bootstrap 入口。

样板资产分别按以下用途评估：正式模板是当前实例；Portable Contract 七类 JSON 是证据包样例；`scripts/test/fixtures/` 是执行行为夹具；DSH/External Profile 是同一建设语义的执行适配。它们不能互相替代为真实业务完成证据。

本次在 Node.js 24.14.1 下运行 20 个相关测试文件：核心/模板 135 项、宿主 60 项，合计 **195 项通过、0 失败、0 跳过**。另外构造 7 个边界复现，使用真实编译器、真实宿主逻辑和既有测试替身，确认下文的语义缺口。没有调用真实模型、启动 DSH、做产品界面验收或执行完整发布验证；不能据此推断真实模型的故障发生率。

**当前四套模板与角色绑定**

| 模板 | 当前实际主链与角色 | 有效设计 | 重点问题 |
|---|---|---|---|
| 建设 `wf-construction-full-feature` | 实施前检查 `evaluator` → 开发 `dev` → 审查 `review` → 测试 `test` → UAT 准备 `accept` → 人工三态 → 收口 `closeout` | 定义与交付分离；审核、测试与人工验收职责独立；自动返工额度 3 | 开发/验收角色仍含旧流程约定；路由与审查结论可矛盾；候选版本核对不足 |
| 优化 `wf-optimize` | 目标确认 `requirements` → 执行 `dev` → 评估 `evaluator` → 收口 `closeout` | 冻结评价契约；只对具体差距返工；评估结果为 PASS/OPTIMIZE/CONFIRM | 评价反馈未显式交给执行节点；契约摘要可漂移；通用优化继承了开发/收口的 Git 流程 |
| 诊断 `wf-diagnose` | 诊断 `diagnose` → 修复 `dev` → 审核 `review` → 回归 `test` → 收口 `closeout` | 原始故障信号贯穿；修复问题与根因被推翻分开回退；额度 3 | BLOCKED 可形成 COMPLETED；审核/回归未声明 verifyBranch；完成类型缺少映射 |
| 探索 `wf-explore` | 统筹 `orchestrator` → 并行 `researcher` → 综合 `synthesizer` → 评估 `evaluator` | 首轮独立视角；保留分歧和反证；INSUFFICIENT 合法结束；最多 2 次自动补充 | 3–5 专家仅靠提示；空专家集也可推进；动态报告与每轮证据缺少稳定声明和版本交接 |

依据：[建设模板](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-construction-full-feature.json:1)、[优化模板](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-optimize.json:1)、[诊断模板](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-diagnose.json:1)、[探索模板](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-explore.json:1)。

12 个正式角色中，以上模板实际绑定 11 个；`designer` 保留在角色库，但当前四套模板没有绑定它。建设已按 M2 把定义外置，不能据旧七阶段叙事把它判成“漏掉方案设计”。`dispatcher` 已是兼容自定义角色。`designer` 是否继续保留，应看定义阶段或自定义工作流的复用需求，不能仅按当前引用数删除。[角色清单](/Users/chris/.codex/worktrees/77ea/workflow-manager/dsh/roles/builtin-roles.json:1)、[M2 主链](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/design/ai-task-define-delivery/single-task-delivery-m2.md:11)。

**一、通用数据契约与通讯协议**

**现状：已经具备可复用的控制协议，但业务交接还不完整。**

已有值得保留的基础：

- Blueprint 是模板事实源，统一编译器生成执行脚本和 Skill；投影内核负责编辑器与蓝图往返。
- `output.schema` 约束结构化结果，`outcomePath` 与边负责业务路由，`completionPath` 负责完成类型摘要。
- 业务结果、引擎段状态与 Logical Run 生命周期分层；人工决策有 ID、选项与恢复载荷。
- Role 表达能力，Node 表达场景；不是每个业务都复制一套近义角色。
- Formal Record 有 Revision、依赖与 provenance，建设 Portable 样例还包含现场、基线、独立证明和人工决定。

这些足以支持“在同一执行器内按约定协作”。但 JSON Schema、路由与共享文件不自动构成可靠的跨业务协议：还要规定输入是什么版本、谁生产、如何交付、下游如何确认接收、失败是否能重试，以及什么证据允许宣布完成。任意业务的成功还依赖可用资料、工具、业务规则与验收标准；框架应承诺协议与执行保证，不能承诺任意任务都完成。

**F1｜高优先级：业务反馈没有形成明确的输入交接。**

普通节点的调用上下文注入原始任务、路径、角色、目标和 `feedback`，没有自动注入声明过的前序结果集合。新业务边路由后只改变当前节点、记历史，没有把刚产生的业务反馈写入下一次执行输入。优化模板的执行目标仅显式读取 `evaluation-contract.md`；共享 dev 角色又主要要求读取 dispatch-result 与旧交接文件。

复现：Evaluator 返回 `OPTIMIZE`，并在 `gaps` 填入唯一标记。第二次执行确实发生，但其提示中既没有该差距，也没有 `evaluation-report.md` 的明确引用。模型可能自行找到文件，但协议没有保证它知道本次要修什么。

影响：图上的循环成立，业务上的反馈循环可能无效；增加轮数只增加消耗。

建议：为节点声明输入绑定，至少包括原始目标、基线引用、当前成果引用、最新评估/审查反馈引用；由运行时解析成带版本的输入清单。正文可存为文件，关键路由反馈必须显式交接。下游不应猜文件名或扫描目录找“最新”。[上下文与节点调用](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs:260)、[业务边流转](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs:707)、[优化执行目标](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-optimize.json:50)。

**F2｜高优先级：结构合法不等于业务结论一致，也不等于证明了当前成果。**

建设的 review 同时输出 `route` 和 `verdict`，test 同时输出 `route` 和 `result`；这些字段可各自合法而互相矛盾。`claimError` 检查分支相等和 HEAD 非空，没有比较审核、测试与当前候选成果的实际 HEAD。

复现：`route=APPROVE` 搭配 `verdict=REQUEST_CHANGES`，以及 `route=PASS` 搭配 `result=FAILED`，仍能进入 UAT 等待。两份证明填写不同旧 HEAD 也通过编译脚本的分支检查。这是编译/契约层的接受行为，未验证真实工作区的后续集成闸门是否会在某些场景另行拦截。

优化还有类似问题：confirm 的 `contract_digest=A`，evaluate 的摘要为 B，流程仍可完成；closeout 即使没有对应人工决策，也能自报 `completion_type=USER_ACCEPTED`。

建议：专业裁决保留一个权威字段；必须保留重复字段时增加跨字段约束。基线摘要由系统计算并比较；候选成果标识由宿主读取，支持 Git HEAD 或非 Git 内容摘要。人工接受类完成必须引用有效 Decision Record，并核对被接受的版本。不能只要求 AI 自报一个非空字符串。[分支/HEAD 检查](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs:505)、[优化完成映射](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-optimize.json:125)。

**F3｜高优先级：正式记录内核支持版本，但运行时未完整记录每次执行。**

脚本将结果写入 `results[nodeId]`，再次执行同一节点时覆盖该槽。宿主在执行段结束时根据结果键收集 node attempts 与正式记录；同一段内多次执行同一节点只看到最后一份结果。段首已有键的节点还被排除，不能可靠表达“恢复后又执行过”。历史边仍保留部分路由事实，因此不是全部历史消失，但不足以恢复各次完整业务产出。

复现：优化发生 3 次执行与 3 次评估，连同确认、收口共 8 次调用；宿主仅记录 4 个 node attempts，评估只保留 1 个正式 Revision。

另外，Records 宿主对普通成果主要串接自身旧版本，对 Proof 则依赖签发时所有 node/artifact 当前记录；它没有表达下游实际读取的精确输入集合。结果是部分依赖缺失，部分依赖过宽，不能普遍保证“仅让受影响证明失效”。

建议：每次调用分配独立 `attempt_id`，节点完成时追加记录，`results[nodeId]` 仅作为最新索引。依赖来自输入绑定，引用具体 Revision。研究专家按轮次与专家 ID 记录，保留原结果集合供综合消费。正式证据写入失败应阻止签发相应证明/最终完成，不必改写节点的原始专业结论。[结果槽写入](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs:697)、[attempt 收集](/Users/chris/.codex/worktrees/77ea/workflow-manager/packages/dsh-visual-workflow/src/host.js:891)、[段末提交](/Users/chris/.codex/worktrees/77ea/workflow-manager/packages/dsh-visual-workflow/src/host.js:2908)、[依赖组装](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/records-host.mjs:91)。

**F4｜高优先级：三层状态在模板落地时仍有语义错位。**

建设、优化、诊断的多条 `BLOCKED` 业务边通向 `$end`，脚本由此返回 `DONE`；宿主将 `DONE` 映射为 `COMPLETED`。而必要外部条件暂时缺失，在产品语义上应可恢复。

复现：诊断输出“测试环境暂时不可用”的 BLOCKED，宿主记录为 `COMPLETED`、`terminal=true`。这不等同于已经存在的模型 Preflight Probe BLOCKED 路径；后者在宿主另有处理。

建议：保持业务结果与生命周期分离，并用显式的结束/挂起映射处理“业务已结束”“等待资料”“环境暂时受阻”“需要重新定义”。客观证据不足可以受控完成，但必须有明确完成类型；暂时阻塞应保留同一个 Run 的恢复入口。同步统一 M2、Bootstrap、生成 Skill 与宿主对额度耗尽的解释。[诊断结束边](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-diagnose.json:195)、[宿主状态映射](/Users/chris/.codex/worktrees/77ea/workflow-manager/packages/dsh-visual-workflow/src/host.js:850)、[M2 受阻定义](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/design/ai-task-define-delivery/single-task-delivery-m2.md:35)。

**F5｜中高优先级：探索的关键约束尚以提示词为主。**

首轮要求 3–5 名专家，但 `expert_briefs` 没有数量或唯一 ID 校验。通用 fanout 的空集合成功语义是合理的通用选择，探索模板却没有补充自己的最低覆盖约束。未声明 `failOn` 时默认只有全部失败才失败，部分专家失败仍会进入综合。专家动态报告未进入 `output.files` 的明确产物清单。

复现：专家数组为空，研究调用 0 次，仍可经综合和评估返回 `DONE`。该例中评估是脚本化输出，说明缺少硬约束，不说明真实评估必定误判。

建议：首轮校验人数与互补视角，定向补充允许按实际缺口减少专家；部分失败可继续，但必须传递失败专家与缺失视角，终评检查覆盖度。用专家产物索引替代文件扫描，报告路径包含轮次或 Revision。`NEEDS_RESEARCH` 应要求非空可执行研究目标；PASS/INSUFFICIENT 的完成类型应与裁决一致。[探索计划与产出](/Users/chris/.codex/worktrees/77ea/workflow-manager/templates/wf-explore.json:17)、[fanout 聚合](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs:621)。

**二、是否过度工程化**

**现状：核心机制与目标相匹配，复杂度主要泄漏在使用方式和兼容语义中。**

不建议因为存在 Blueprint、Snapshot、Record、Decision、Workspace 就合并这些概念：它们分别回答“按什么流程跑”“使用哪个定义版本”“产出了什么”“谁作了决定”“在哪操作”，解决的是不同问题。当前也已将编译器、投影与角色注册表收敛为单一来源。

4 套模板的分工有实际依据：建设重交付证明，优化重评价闭环，诊断重根因证据，探索重视角覆盖。它们与成熟 Agent 工作流中顺序链、Evaluator–Optimizer、Orchestrator–Workers 的组合方式相容。复杂度应由实际效果证明，而非预先堆叠节点。[Anthropic 的工作流设计经验](https://www.anthropic.com/engineering/building-effective-agents)。

| 复杂度问题 | 证据与业务影响 | 改进建议 |
|---|---|---|
| 角色同时承载能力与特定工程流程 | dev 要求 Git worktree、dispatch-result、dev-report；优化声明的资源却可为文档/配置；closeout 固定 GitHub/PR/人工验收前提 | Role 保留专业能力、独立性和边界；文件名、环境、验收条件由 Node/任务输入声明；发布与清理由执行适配层处理 |
| 角色内部规则冲突 | dev 开头和硬规则禁止写/跑测试，中间又要求先写失败测试、运行验证；test 同时要求不改业务代码与解决合并冲突 | 允许开发者做必要自测，独立测试负责最终行为证明；冲突解决回开发或独立集成动作；不以“独立证明”禁止开发自检 |
| 收口职责过宽 | closeout 要一致性清理、创建/合并 PR、关 Issue、回收环境，且写死 origin/gh；与只整理冻结成果及当前仓库远端政策容易冲突 | 将交付动作参数化并按授权执行，收口只整理事实；必要源码/文档修改应在最终证明前完成；失败清理不伪装成功 |
| 可机械检查的事项仍由模型重新判断 | preflight 是 evaluator 节点，但已有 `runPreflight` 机械实现；模板中的前置依赖要求与新版 M2 环境组规则不同 | 复用现有机械检查，模型解释例外与缺口；避免另做第二套判断逻辑 |
| 兼容与文档状态增加理解成本 | CONTEXT 仍将已实现 fanout、Logical Run 等列为待实现；生成 Skill 的 DONE 统一要求 cleanup 和 merge commit，探索却没有收口节点 | 为 Current/Target/Legacy 提供明确版本索引；生成 runbook 按模板能力与完成类型输出；兼容分支集中转换并设置退役条件 |

依据：[dev 角色](/Users/chris/.codex/worktrees/77ea/workflow-manager/dsh/roles/dev.md:1)、[test 角色](/Users/chris/.codex/worktrees/77ea/workflow-manager/dsh/roles/test.md:17)、[closeout 角色](/Users/chris/.codex/worktrees/77ea/workflow-manager/dsh/roles/closeout.md:16)、[机械 preflight](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/ai-task-preflight-check.mjs:28)、[生成 runbook](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs:775)、[Current/Target 标注](/Users/chris/.codex/worktrees/77ea/workflow-manager/CONTEXT.md:199)。

从模板计算，正常路径的模型节点调用数为建设 6、优化 4、诊断 5；探索首轮为 6–8（3–5 专家 + 统筹/综合/评估），不含节点内部进一步委派。对正式交付与复杂研究，这些开销有理由；对极小文档修改，应通过真实任务比较是否需要独立确认、独立收口调用。此处是成本优化建议，不是要求删除质量关口。

实现组织也有收敛空间：`generate.mjs` 约 1069 行、host 约 3015 行、client 约 3368 行。行数本身不证明过度工程化；实际问题是状态、决策、记录与恢复需要跨生成字符串和宿主共同修改。建议围绕状态转换、输入解析、记录提交提炼可单测的纯逻辑，再打包到 DSH 支持的形式。保留必要的沙箱/子进程适配，不新增远程服务或第二套执行引擎。

**三、对照成熟软件工程实践的优化方向**

**F6｜高优先级：技术重试需要独立预算和失败分类。**

四套模板的大多数普通节点配置了技术失败自环。结构化结果为空时，脚本先节点内重试一次，再走技术边；技术边不消耗业务返工额度。当前主要靠累计 `AGENT_CAP=1000` 最终停止。

复现：优化目标确认持续返回无效结果，实际调用 1000 次后返回 `FAILED_AGENT_CAP`。这不是无限循环，但远超“自动返工最多 3 轮”容易让用户形成的成本预期。`RECONFIRM_REQUIRED` 等不计额度的业务回路也需要无进展检测。

建议：把业务返工、结构修复、暂时性服务错误分开计数；增加每节点有限尝试、总耗时/费用界限、退避和不可重试分类。工具执行成功但返回格式失败时，不能简单重跑整个有副作用节点；使用稳定操作 ID、幂等检查和恢复点避免重复创建/发布/合并。相关原则可借鉴 Temporal 的重试策略和有费用调用的次数限制。[技术失败处理](/Users/chris/.codex/worktrees/77ea/workflow-manager/scripts/generate.mjs:655)、[Temporal 重试策略](https://docs.temporal.io/encyclopedia/retry-policies)、[有限次数与幂等实践](https://docs.temporal.io/design-patterns/fixed-count-retries)。

| 工程实践 | 本项目现状/差距 | 建议与可观察验收标准 |
|---|---|---|
| 契约优先与版本兼容 | 路由 Schema、Portable Schema、运行时输入和角色文案并未完全一致 | 给协议声明版本与支持的 Schema 子集；不支持的关键约束明确拒绝；跨字段一致性、上下游引用和完成映射纳入校验 |
| 消费方契约测试 | 现有脚本化代理测试能验证走哪条边，但不会证明真实消费者拿到了所需输入 | 验证“生产者真实输出 → 输入解析 → 消费者接收”；评价差距必须出现在重做输入，缺文件/旧版本/错误类型必须被拦截 |
| 逐次事件记录与可恢复执行 | 已有段恢复、快照、Formal Record；每次节点产出与副作用提交尚未统一 | 节点执行、结果提交、流转分别有稳定 ID；重复提交去重；进程中断恢复不丢已完成结果、不重复已确认动作 |
| 最小权限与独立证明 | 已有 Run 隔离和探索只读源冻结；审核/测试的只读约束仍大量依赖角色文案 | 将“可写源码/可写证据/可发布”等权限交给宿主校验；同一 Run 内评审者不能修改被审成果；区分认知独立与文件访问隔离 |
| 质量与成本的可观测性 | 已有运行事件、阶段、模型绑定与日志，尚不足以证明每个节点的收益 | 按 run/node/attempt 关联耗时、输入版本、重试原因、成本、人工介入与最终质量；在真实样例上比较模板复杂度的收益 |
| 发布一致性与代表性验收 | 已有生成一致性检查、模块测试和产品模式验收纪律 | 保留现有检查；新增实际角色+真实产物+宿主入口的代表性 E2E，并覆盖模型输出偏差；不以机器测试通过代替业务与人工验收 |

Schema 规范本身支持数量、长度、组合等校验，项目可按业务选择支持子集，不必为了标准化实现全部规范。[JSON Schema Validation](https://json-schema.org/draft/2020-12/json-schema-validation)。消费方契约测试关注双方实际使用的输入输出，适合借鉴到节点交接，不意味着本项目必须引入 Pact 服务。[Pact 契约测试说明](https://docs.pact.io/)。运行观测可沿用 OpenTelemetry 的 trace/span 关联方式；小规模阶段先产出本地结构化指标即可。[OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/)。

**建议的最小通用协议**

沿用项目“公共系统元数据 + 专业业务包”的原则，不创建包含所有场景字段的巨大 Schema。

| 层 | 建议保留的责任 |
|---|---|
| 系统交接信息 | 协议版本、run/node/attempt、定义快照、实际模型、输入 Record Revision、输出 Record/Artifact 引用、关联 Decision |
| 专业业务包 | 本节点裁决、发现、证据、风险、不确定性、未解决问题；按领域各自定义 |
| 控制协议 | 成功/技术失败/受阻的区分，错误可重试性、预算、超时、暂停恢复、结束与完成类型映射 |
| 执行适配 | Git 或非 Git 资源访问、外部工具、发布权限、幂等动作；不写进通用角色正文 |

对使用者而言，接口应能回答三件事：这一步需要什么、结果交到哪里、失败后怎么办。其余标识、版本、去重和留痕由运行时承担。

**建议推进次序与验收要求**

1. **先修正会造成错判的规则。** 处理裁决/路由矛盾、错误版本 Proof、受阻误记完成、人工完成来源与角色指令冲突。验收：无矛盾结论能进入 UAT；环境恢复继续同一 Run；无对应人工决定不能记成人工接受。
2. **再补齐真正的数据交接。** 实现节点输入绑定、业务反馈传递、每次 attempt 记录与精确依赖。验收：三次执行留下三份记录；旧 Proof 不替新成果背书；只使受影响证明失效；缺少声明产物不能签发完成证明。
3. **同时约束自动执行成本。** 技术重试独立限额、暂时错误退避、有副作用动作去重。验收：连续无效结果在节点限额内停下；中断后不重复发布；业务额度与技术额度可解释。
4. **最后做有度量的简化。** 机械 preflight 复用、模板角色去工程耦合、兼容 runbook 收敛、定向研究按缺口分配专家。验收：软件交付、文档/配置优化、缺陷诊断、开放研究各有代表样例，记录产物质量、总调用、时延和人工介入；只有效果成立才增加新层次。

本次建议不包含大规模重写、换引擎或删除整套工作流。优先把现有设计原则落实为可验证的执行规则，能同时提升可靠性并减少执行者理解成本。

**复现与检查附件**

- [7 个复现的结构化结果](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-probes.json)
- [前 6 个复现脚本](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-probes.mjs)
- [反馈交接复现脚本](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-feedback-probe.mjs)
- [135 项核心与模板检查](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-core-tests.tap)
- [60 项宿主检查](/Users/chris/.codex/worktrees/77ea/workflow-manager/docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-host-tests.tap)

证据状态：代码与契约查阅已完成；相关自动检查通过；7 个语义缺口在替身环境复现；真实 DSH、模型行为频率与人工业务验收未验证。所有建议均未实施。
