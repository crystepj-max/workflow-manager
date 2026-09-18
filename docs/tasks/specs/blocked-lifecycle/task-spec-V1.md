# LOC-030｜统一受阻、恢复与完成的生命周期语义

| 元数据 | 值 |
|---|---|
| 任务标识 | LOC-030 |
| 需求基线版本 | V1 |
| 来源需求 | WR-009 |
| 对应 Issue | 无；本地轨道，GitHub 同步 pending |
| 优先级 | P0 |
| 分类 | bug |
| 体量 | M |
| 前置依赖 | 无 |
| 施工环境组 | LOC-030 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-14T10:05:31Z |
| 准备时间 | 2026-09-14T09:32:27.648693+00:00 |
| 当前状态 | 本地已定义 |
| 源码核验 HEAD | 49ad73a1079bdd556dc18bab081f0bf1aaa54429 |

> 当前“无人值守许可=允许”表示已获本次确认的施工许可；许可仅覆盖已确认范围内施工与验证，不涵盖代签验收、扩大范围或未经授权的对外动作。

## 1. 需求背景

建设、优化、诊断的 BLOCKED 多指向 $end，脚本 DONE 被宿主映射为 COMPLETED。recoverable-blocked 中测试环境暂不可用也 terminal=true，用户不能按预期继续同一任务。

来源为[系统评审存档](../../../../docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-2026-09-14.md)。评审证据为源码查阅、195 项相关自动检查与 7 个替身环境复现；不代表真实模型故障频率或产品人工验收。新增规则与数值是本条建议基线，不是已有批准记录。

- [templates/wf-diagnose.json](../../../../templates/wf-diagnose.json:195)
- [packages/dsh-visual-workflow/src/host.js](../../../../packages/dsh-visual-workflow/src/host.js:850)
- [docs/design/ai-task-define-delivery/single-task-delivery-m2.md](../../../../docs/design/ai-task-define-delivery/single-task-delivery-m2.md:35)

本轮重新核验：recoverable-blocked：诊断环境缺失变 COMPLETED/terminal=true；与已有模型服务预检受阻为不同路径。 当前 HEAD 与评审基线之间只更新了既有任务记录，运行代码、模板和角色无差异。`.out-of-scope/` 不存在，未发现本条被正式拒绝的本地记录；GitHub 不可用，未宣称完成远端历史检索。

## 2. 用户问题

建设、优化、诊断的 BLOCKED 多指向 $end，脚本 DONE 被宿主映射为 COMPLETED。recoverable-blocked 中测试环境暂不可用也 terminal=true，用户不能按预期继续同一任务。

## 3. 目标

技术执行段结束不再自动等于业务完成；暂时受阻可恢复，已完成必须有明确终结语义。

## 4. 非目标

不重新设计顶层任务状态，不增加新调度器，不将业务 BLOCKED 与模型连接预检 BLOCKED 混为一条未经验证路径。

## 5. 修改前

recoverable-blocked：诊断环境缺失变 COMPLETED/terminal=true；与已有模型服务预检受阻为不同路径。

## 6. 修改后

技术执行段结束不再自动等于业务完成；暂时受阻可恢复，已完成必须有明确终结语义。 成功、拒绝、等待、恢复分别有可追溯原因；保持本条未覆盖能力的现有边界。

## 7. 功能范围

四模板终止状态、宿主恢复入口、并发名额释放及生成操作说明。

- [scripts/generate.mjs](../../../../scripts/generate.mjs)
- [packages/dsh-visual-workflow/src/host.js](../../../../packages/dsh-visual-workflow/src/host.js)
- [packages/dsh-visual-workflow/src/client.js](../../../../packages/dsh-visual-workflow/src/client.js)
- [templates](../../../../templates)
- [dsh/skills/construction-bootstrap](../../../../dsh/skills/construction-bootstrap)
- [docs/design/ai-task-define-delivery/single-task-delivery-m2.md](../../../../docs/design/ai-task-define-delivery/single-task-delivery-m2.md)

## 8. 不修改范围

不重新设计顶层任务状态，不增加新调度器，不将业务 BLOCKED 与模型连接预检 BLOCKED 混为一条未经验证路径。

不改 P1/P2 需求、不实施兄弟任务、不修改用户全局技能与 Agent Policy、不清理历史任务现场。实现若需改变已确认的范围/验收，回定义处理变化部分，不能为了测试通过降低标准。

## 9. 业务规则

- 建立显式终止描述：业务结果、生命周期目标、原因码、是否可恢复、恢复节点和完成类型分开。环境/资料/权限暂缺及技术额度耗尽映射 BLOCKED，可恢复；完成目标且材料有效才映射 COMPLETED。
- 建设遵从已确认 M2：自动返工 3 轮耗尽为 BLOCKED 并释放并发；人工 REJECT 后新一轮交付重置业务额度。优化/诊断沿用各自既有业务额度，耗尽统一进入有理由的受阻状态，不冒充成功。
- NEED_REDEFINE 标记基线需重定义并保留旧 Run；原基线不自动换版，升版后走现有新运行/基线接续规则。探索 INSUFFICIENT 可以受控完成，但必须显式标注证据不足。
- 恢复同一受阻 Run 前重检阻塞条件；恢复不改变快照、基线或自动补签人工决定。

**接手者可直接采用的实现边界：**为新模板生成显式 termination 描述，host.logicalTransitionFor 优先使用经校验描述；旧无描述的 Run 保留 legacy 标识。复用同 taskId 的恢复入口，并让生成 Skill/Bootstrap 指向该入口。

**接口与数据约定：**termination={business_outcome,lifecycle,reason_code,resumable,resume_node,completion_type?}。新运行 BLOCKED→BLOCKED/非 terminal；NEED_REDEFINE 保留旧基线，不在同 Run 静默升版。诊断正常回归 PASS 后 DELIVERED 必须有完成映射；探索 INSUFFICIENT 合法结束。WR-005 未完成时本条不宣称已实现人工来源安全。

本条拥有 lifecycle_mapping/termination descriptor；消费现有完成结果，WR-005 接入后只接受其核验结果。与 WR-011 约定 TECHNICAL_BUDGET_EXHAUSTED 为可恢复受阻原因。

**兼容方式：**新运行使用本条新规则；已启动运行保持其冻结快照。无法补证的旧历史明确 legacy/unverified，不改写成已验证完成。若其他 P0 已合入，复用其公共接口并运行集成检查；没有硬依赖的条目允许通过既有接口完成自身切片，不能自行等待整个需求包。

## 10. 用户操作路径

1. 从本地任务卡读取本规格 V1 与已有批准，执行正式 preflight；独立任务由现有建设入口分配隔离工作区，成员沿用指定组。
2. 在隔离开发环境运行本条样例并观察本条改变的行为。
3. 用户看到实际成果、错误/等待说明和逐项证据；开发与独立审核/测试分别记录。
4. 提交 UAT 卡，保留人工 ACCEPT/REJECT/CONDITIONAL_PASS；本次定义不启动该交付阶段。

## 11. 异常和边界场景

本条各 AC 中的非法输入、失败、版本变化及恢复即必测反例；具体顺序见 §16。输入不满足时不猜测成功，不自动扩大资源/授权；无法执行的真实宿主层明确未验证。读写失败时保留已知事实和恢复定位，不把证据缺失包装为成功。

历史 DONE 无法可靠推断真实业务结果，迁移时保留原记录并标记旧映射；不得批量改写历史已完成状态。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 / 当前状态 | 原因 | 依据 |
|---|---|---|---|
| 本轮对象 | 已确认：逐个定义现有 10 个 P0，包含本条 | 用户明确指定 P0 范围 | 2026-09-14 本会话请求 |
| 优先级 | 已确认：P0 | 沿用用户选定优先级 | 同上 |
| 需求基线 V1 | 已确认：按 V1 的具体规则、验收及环境关联 | 用户已确认本 V1 基线 | 本次确认记录 |
| 无人值守许可 | 已确认：允许按确认基线施工至人工验收关口 | 满足现有单任务开工门禁；不授权代签 | 本次确认记录 |

未决产品事项：0。技术路径已明确，没有“施工时再决定”的开放产品选项；内部命名和模块组织由执行者在上述边界内决定。

## 13. 功能切片关系

用户看到的受阻/完成及恢复入口构成完整切片，状态映射涉及编译与宿主。 体量为 M，技术路径见 §9，未留下 L 型前置设计迷雾。

原评审编号 WR-009 保留为溯源标识，正式任务为 LOC-030。相关需求只有接口关系；各条独立 UAT 与收口。共享文件改动使用隔离工作区，整合前核对最新已合入行为。

## 14. 前置依赖说明

前置依赖：无

施工环境组：LOC-030；施工环境角色：独立。

本任务无业务硬前置；与其他任务修改同文件只构成合并风险，不新增串行门禁。 当前仅登记环境安排，不创建虚假运行/环境记录，不执行 Git 分支与工作区分配。

## 15. 验收条件

- [ ] AC-01：诊断“环境暂不可用”得到 BLOCKED、terminal=false；环境恢复后继续同一 Run，而非新建假成功记录。
- [ ] AC-02：建设第 3 次业务返工后仍失败时按 M2 受阻；人工退回后正确重置业务额度。
- [ ] AC-03：DONE 但无有效业务完成映射时不记 COMPLETED；合法 PASS、人工接受及探索 INSUFFICIENT 能形成各自明确结果。
- [ ] AC-04：宿主状态、生成 Skill、Bootstrap 与用户界面对同一事件给出一致解释；恢复后不重复已确认节点。

这些勾选框代表未来实现验收，当前全部未执行；Definition Check 通过不自动勾选功能验收。

## 16. UAT 场景

### UAT-01 主路径与关键反例

- 验收目的：验证 §3 用户目标与 §15 全部 AC。
- 前置条件：对应候选源码在隔离 worktree；Node.js 24 与所需依赖可用；真实产品模式验证按既有发布规则使用安装产物。
- 操作步骤：诊断环境缺失→受阻→补环境→恢复同一 Run；建设业务额度耗尽→受阻；探索证据不足→完成但类型 INSUFFICIENT，三种结果分别展示。
- 预期结果：正常输入达成目标；非法/缺失/过期输入按 §9 和 AC 拒绝；结果状态、产物和原因一致。
- 人工关注：界面/报告能看懂通过或受阻原因，不把测试替身结果当成用户已经接受。

### UAT-02 恢复与兼容

- 前置条件：保存一个旧快照与一个新规则 Run 的中间状态；仅在隔离环境制造中断。
- 操作步骤：分别恢复旧快照、新运行，再执行一次同请求重放或同内容重读；核对输出与证据。
- 预期结果：旧快照不静默迁移；新运行不丢有效成果、不伪造历史证明；本条涉及的非法条件仍被拦截。
- 证据要求：输出日志/实际产物/状态快照与候选 HEAD；不能只附最终 PASS 字样。

**优先复用的检查入口：**

- [scripts/test/runtime-logical-run.test.mjs](../../../../scripts/test/runtime-logical-run.test.mjs)
- [scripts/test/runtime-count-round.test.mjs](../../../../scripts/test/runtime-count-round.test.mjs)
- [packages/dsh-visual-workflow/tests/logical-run.test.mjs](../../../../packages/dsh-visual-workflow/tests/logical-run.test.mjs)
- [packages/dsh-visual-workflow/tests/run-control.test.mjs](../../../../packages/dsh-visual-workflow/tests/run-control.test.mjs)

修改蓝图/生成规则执行 `npm run generate`、`npm run validate`；按风险运行相邻测试。发布时再执行 `npm run release:verify` 与真实产品模式验收，不在定义阶段运行或宣称通过这些实施验收。

## 17. 风险

历史 DONE 无法可靠推断真实业务结果，迁移时保留原记录并标记旧映射；不得批量改写历史已完成状态。

GitHub 目前返回 403，本条按本地轨道定义。平台调用/提交/推送/合并遵守实际仓库政策与已有授权；无人值守许可只覆盖已确认范围内施工与验证，不自动涵盖对外发布或代替人工验收。

## 18. 已知限制

- 本轮完成定义准备，不实施上述优化；已有评审复现证明现状缺口，不证明新方案已经通过。
- 基线与无人值守许可已由用户确认；Definition Check 已按确认结果更新。
- 开工脚本属于 M2：技能安装目录不包含该脚本，使用本项目绝对路径 `scripts/ai-task-preflight-check.mjs`；任务登记脚本使用所选技能 assets，已核验与仓库版本相同。
- 本地卡与登记册归入 `docs/tasks/`；详细规格位于受 Git 跟踪的 `docs/tasks/specs/`。另一工作区接手时必须携带同版本规格并核对确认后的摘要；不得因 `.scratch` 被忽略而开工时找不到基线。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-14T09:32:27.648693+00:00 | 由 WR-009 建议转为完整任务规格，补齐接口、UAT、环境、兼容与门禁；已确认基线 V1 | 已确认 |
