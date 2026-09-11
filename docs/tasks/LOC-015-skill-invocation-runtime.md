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
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无本地卡依赖；#80（外部）落地形态为本卡输入 |
| 施工环境组 | LOC-015 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；实施前如需细化，按 Vn→Vn+1 流程升版 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

消除调用入口双轨：当前 `wf_run`（插件工具）路径已完整接入 Logical Run Runtime，但主会话拿编译脚本直起平台 `workflow` 工具的 Skill 路径绕过 wf_run 边界，只产生"退化"逻辑运行摘要（单段、completion=null、人工决策记录只回到主会话文本、看板不可续跑）。目标：Skill / Chat 发起的运行与插件入口共享同一 Runtime（规格 §2.3：新入口只能是 Invocation Adapter，禁止第二套运行体系）。

### 涉及范围

- 做：首选方案 = 生成 SKILL.md runbook 引导主会话改经 `wf_run` 运行（模板产物四件套调整 + runbook 驱动说明）；备选/补充 = 最小"结果回灌"通道（脚本终态回写插件，使退化摘要升级为完整记录）；平台 `workflow` 工具直起的 run 至少补全 completion 与 HD 可续跑路径。方案取舍在实施 Definition Check 时按 #80 落地形态定，走 V1 基线内决策记录。
- 不做：新建第二套 Runtime；改变 `wf_run` 既有语义；非 DSH 执行器接入（那是 v0.4 边界）。

### 验收标准

- [ ] Skill 发起的一次任务跨多段执行（人工决策/恢复）仍是一个 Logical Run，看板可见完整分段与摘要
- [ ] Skill 路径的人工决策可按 `decision_id + user_choice` 续跑，Decision/Control Record 落档
- [ ] `DONE` 的完成类型（completion）不再为 null
- [ ] 既有 `wf_run` 路径回归不变（`runtime-logical-run` / `human-decision-e2e` 不改断言全绿）；`npm test`、`npm run validate` 全绿

## 详细规格

产品语义：`docs/design/workflow-manager-v0.1-final-product-spec.md` §2.3 / §11（Invocation 与 Runtime 分离；Chat/Skill/插件入口共享同一 Runtime）；现状事实：`CONTEXT.md`「执行路径（D5 正式化）」与「回灌（未实现）」；退化摘要逻辑见 `host.js` `recordDegenerateLogicalRun`。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
