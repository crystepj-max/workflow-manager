# LOC-015 · Skill 调用入口接入 Logical Run Runtime

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-015` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W4，#83）；输入 = #80 落地形态（已验收合并） |
| 任务名称 | Skill 调用入口接入 Logical Run Runtime |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 等待验收 |
| 需求基线版本 | V3 |
| 前置依赖 | 无本地卡依赖；#80（外部）落地形态为本卡输入 |
| 施工环境组 | LOC-015 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/LOC-015-skill-invocation-runtime/task-spec-V3.md`（详细规格）；本卡「三要素速览」为同源摘要 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标

消除调用入口双轨：让 DSH 内由 Skill / Chat 发起的工作流运行，与插件入口共享同一 Logical Run Runtime（规格 §2.3：新入口只能是 Invocation Adapter，禁止第二套运行体系）。落点是**口径统一**——能力已在插件侧（`wf_run` 已完整接入 Runtime），缺口是两条 runbook 与 Current 侧文档都还指引走 DSH 内置 `workflow` 工具，导致插件旁观、记录残缺。

### 涉及范围

- 做：① `scripts/generate.mjs` `skillWrap`（模板产物 SKILL.md）执行与续跑步骤改为首选 `wf_run`；② `dsh/skill/SKILL.md` 第 3、5 步同口径改造；③ 两份 runbook 写入回退规则——`wf_run` 不可用时才用内置 `workflow` 工具执行编译脚本，且必须显式提示「记录将退化」；④ args 装配保留 `resource_kind` 说明（optimize 类模板需要）；⑤ Current 侧口径修正：`CONTEXT.md`（D5 执行路径段）、`dsh/README.md`（wf_run 增强路径节）、`packages/dsh-visual-workflow/README.md` 对应段落，并修正「编辑器点『获取脚本』」这一界面已不存在的入口表述；⑥ 真实验证：DSH 内 Skill 触发一次模板运行，确认走 `wf_run`、记录完整。
- 不做：新建第二套 Runtime；改 `wf_run` 语义与数据契约；新增插件工具面（备选「结果回灌通道」不采纳）；为内置 `workflow` 工具直起的运行补全记录；客户端 UI（LOC-016）；产品规格（Target 文档）正文；非 DSH 执行器接入（v0.4 边界）。

### 验收标准

- [ ] 起跑口径经仓库内验证：两份 runbook（生成器产物 + `dsh/skill/SKILL.md`）要求首选 `wf_run`、不需要传递脚本，`wf_run` 不可用时才回退内置 `workflow` 工具且如实提示记录退化；`wf_run` 起跑即产生完整 Logical Run（`task_id` 非空、`trigger=start`、分段齐全）由仓库内运行时测试覆盖。真实 DSH 内由 Skill 触发一次模板运行、会话实际走 `wf_run`、看板显示为同一次运行，由人工按 UAT-01 在验收环节实测确认。
- [ ] Skill 发起的一次任务跨多段执行（人工决策/恢复）仍是一个 Logical Run，看板可见完整分段与摘要（判定基准：现有运行看板）
- [ ] Skill 路径的人工决策可按 `decision_id + user_choice` 续跑，Decision/Control Record 落档
- [ ] `DONE` 的完成类型（completion）不再为 null
- [ ] 回退不静默：走内置 `workflow` 工具时，会话输出含明确的「记录将退化」提示
- [ ] 既有 `wf_run` 路径回归不变（`runtime-logical-run` / `human-decision-e2e` 不改断言全绿）；`npm test`、`npm run validate` 全绿；`npm run generate` 后无差异

## 详细规格

产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §2.3 / §11（Invocation 与 Runtime 分离；Chat/Skill/插件入口共享同一 Runtime）、§12 Phase C `#83`。现状事实：`CONTEXT.md`「执行路径（D5 正式化）」与「回灌（未实现）」；退化摘要逻辑见 `host.js:1207` `recordDegenerateLogicalRun`（触发点 `host.js:1416`）；`wf_run` 注册与 Logical Run 归属见 `host.js:2160`、`host.js:2255+`；`wf_control` 控制面见 `host.js:2584`。回退约束见 `host.js:2155` / `host.js:2241`。

需求分析与 Definition Check：`docs/tasks/specs/LOC-015-skill-invocation-runtime/{requirements-analysis.md,definition-check.md}`。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
| 2026-09-11 | 定义中（待决策） | 需求分析发现未决产品事项 1 项：Skill 入口接入机制未定，与「无人值守许可 = 允许」互斥；Definition Check 未通过（9.3 / 9.6）。 |
| 2026-09-11 | 定义中（待决策，前提待定） | 用户澄清：近几天真实工作在 ZCode 侧（需求分析 skill + 配套单任务工作流，SKILL.md 文本控流程），DSH 内近期模板运行均为 #79/#80 UAT 测试数据；据此作废「实际运行已走 `wf_run`」的推断。本卡问题面（Skill 路径产生退化记录）仅在 DSH 内成立。 |
| 2026-09-11 | 待确认（基线 V2） | 用户确认「DSH 的 skill 入口后面会调用」→ 决策落地：发起权归插件（方案 A），备选回灌方案（B）不采纳，内置 `workflow` 工具降为应急回退；范围收缩为「口径统一 + 真实验证」。规格升 V2，Definition Check 全部通过、未决产品事项 0，呈递基线确认。 |
| 2026-09-11 | 本地已定义 | 基线 V2 经用户会话确认（「确认」）；版本一致：任务卡 = 规格 = V2。可开工（无人值守许可 允许）；施工第一步为真实验证（DSH 内 Skill 触发一次运行，确认走 `wf_run`），不通过则停下呈报。 |
| 2026-09-11 | 交付中（基线 V3） | 开发完成后、呈递验收前，用户就验收第 1 条取证方式拍板：方案 A——按验证归属改写（仓库内可验证部分由施工/测试出证，真实 DSH 实测交人工 UAT-01；UAT-01 前置条件改为用户指定开发 DSH http://127.0.0.1:55191/），并指示部署该开发 DSH 完成验收流程。任务目标、范围、方案（A）不变；规格升 V3（task-spec-V3.md），Run 以 reverify 推进 attempt 重写基线载荷。 |
| 2026-09-12 | 等待验收 | 真机 UAT 完成（开发 DSH 55191）。UAT-01 全绿：Skill 触发 default-workflow，会话实际走 `wf_run`（task_id 非空、trigger=start），看板呈「同一次运行·第 1 段（人工验收）/第 2/2 段（DONE）」，人工裁决后按 entry=accept+approved=true 续跑至 COMPLETED，DONE.completion={type:done,node:closeout,path:$.completion_type} 非空。UAT-02 全绿：无插件会话回退内置 `workflow` 工具时输出显式「记录将退化」警示卡。UAT 过程发现并修复两处真机缺陷：① vm 沙箱未注入 structuredClone 致人工决策续跑 ReferenceError（54d0c9d，deepCloneData 守卫 + sandbox-clone-guard 回归测试）；② default-workflow 收口节点未声明 completionPath 致 DONE.completion 恒为 null（2c27856）；另有 dsh/README.md 引言旧口径残留返修（808a1c4）。收敛审查 approve（review_proof.a6）、独立测试 pass（test_proof.a7）均绑定最终 HEAD 2c27856；cwf 证据链校验 9/9 通过，acceptance_package.a8 呈 awaiting_decision。证据目录：`.scratch/uat-loc015-demo/evidence/`。待人工三态裁决（通过 / 退回 / 有条件通过），AI 不代签。 |
