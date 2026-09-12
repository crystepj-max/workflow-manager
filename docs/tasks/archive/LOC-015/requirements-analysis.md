# LOC-015 需求分析（现状核实 · 缺口 · 决策卡）

> 分析对象：`docs/tasks/LOC-015-skill-invocation-runtime.md`（登记册 `LOC-015`，基线 V1，卡上状态「本地已定义」）
> 采集时间：2026-09-11
> 结论：**任务方向成立，但卡上残留 1 项未决产品事项**（Skill 入口的接入机制被推迟到施工期决定）。
> 按硬规则 1 与 Definition Check 9.3 / 9.6，当前证据不足以维持「本地已定义」；需先决策，再走 V1→V2 升版并重跑 Definition Check。

---

## 1. 输入识别

| 项 | 判定 |
|---|---|
| 来源类型 | 本地轨道既有任务卡（会话录入 → 开发计划表 v2，W4 `#83`） |
| 需求源 | 产品规格 §2.3 / §12 Phase C；输入事实 = `#80` 落地形态 |
| GitHub 同步 | `pending`（本卡尚未补建 issue） |
| 本次分析请求 | 会话指令「分析 LOC-015」，非升版指令；分析中发现基线需修正，故按 §8 预备 V2 |

---

## 2. 现状核实（逐条带证据）

| 卡上主张 | 核实 | 证据 |
|---|---|---|
| `wf_run`（插件工具）路径已完整接入 Logical Run Runtime | ✅ 成立 | `packages/dsh-visual-workflow/src/host.js:2160` 工具注册；`host.js:2255+` Logical Run 归属（新启/同 taskId 终态派生/续跑追加分段）；`host.js:2584` `wf_control` 运行控制面（#80） |
| 主会话走平台 `workflow` 工具的 Skill 路径绕过 `wf_run` 边界 | ✅ 成立，且是两条 runbook 的书面口径 | `dsh/skill/SKILL.md:58`「### 3. 调用 workflow 工具」；`scripts/generate.mjs:748 skillWrap`（模板产物 SKILL.md）第 2 步「调用 `workflow` 工具……`script` = 编译产物全文」 |
| 该路径只产生「退化」逻辑运行摘要 | ✅ 成立 | `host.js:1207 recordDegenerateLogicalRun`：`task_id=''`、单段 `segments`、`completion=null`；触发点 `host.js:1416`（`workflow/end` 时该引擎运行未被 `wf_run` 登记） |
| 脚本返回值只回到主会话，插件进程拿不到 | ✅ 成立且已文档化 | `CONTEXT.md:134`（D5 执行路径推论）；`CONTEXT.md:141`「**回灌（未实现）**」 |
| 目标规格要求入口统一到同一 Runtime | ✅ 成立 | `docs/design/workflow-manager-v0.1-final-product-spec.md:34` §2.3「新入口只能是 Invocation Adapter……不能形成第二套运行体系」；同文件 §12 Phase C「#83 Skill / Chat Invocation -> Logical Run Runtime」 |
| 回归门禁测试存在 | ✅ 成立 | `scripts/test/runtime-logical-run.test.mjs`、`scripts/test/human-decision-e2e.test.mjs` |

### 2.0 术语口径（避免与第三方 coding agent 混淆）

本文的「平台」= **DSH（DeepSeek Harness）宿主**，不是 ZCode 等其他 coding agent：

| 说法 | 实际所指 | 归属 |
|---|---|---|
| 平台的通用 `workflow` 工具 | DSH 内置的脚本执行工具（参数是一段 `.mjs` 编排脚本） | DSH 宿主（引擎由 agent preset 平面挂载，`docs/工作流统一引擎需求规格.md:17`、`docs/research/vwf-host-internals.md:53`） |
| 插件的 `wf_run` 工具 | vwf 插件注册的工具（给 `templateId` 即自行编译并起跑） | `packages/dsh-visual-workflow/`（`host.js:2160`） |

两条路最终交给同一个工作流引擎（`workflowEngine.start`）。LOC-015 的全部范围都在 DSH 内；「共享同一 Runtime」中的 Runtime 指插件里的 Logical Run 运行记录体系。

补充事实：**技能可见 ≠ 技能可用**。生成 skill 与 `dev-workflow-2-0` 装在共享技能根（`~/.dsh/skills/`、`~/.agents/skills/`），其他 agent（如 ZCode）也能加载它们；但技能自我声明「仅适用于具备 `workflow` 工具的 DSH 会话」（`dsh/skill/SKILL.md:3`、前置条件见同文件第 21 行）。在非 DSH 环境触发会走到「手册要求调用的工具不存在」——属本卡范围外的已知事实，记录备查。

### 2.1 影响方案可行性的补充事实

1. **`wf_run` 是条件注册，不是默认可用**：`host.js:2155`「agents 未挂载：wf_run 工具不注册；编译产物经 vwf.script RPC 提供给 workflow 工具执行」；引擎解析失败时 `host.js:2241` 明确报错并指引回退到「获取脚本 + workflow 工具」。
2. **引擎由 DSH agent preset 平面挂载**（`docs/research/vwf-host-internals.md:53`；preset 声明在 DSH 包 `config/agent-presets/code/agent.cordis.yml:222-228`）——即日常 code 会话应可解析，但属**部署事实**，需在实施期真实验证，不能只靠推断。
3. **文档口径已把 wf_run 定位为「增强路径」**：`dsh/README.md:320-324`，正式路径是「编辑器点『获取脚本』→ 平台 `workflow` 工具执行」；`docs/design/workflow-manager-v0.1-final-product-spec.md:240` §11 亦写「当前真实路径仍是：模板库 → 编辑器 → 保存生成/更新 Skill → Chat 调用 Skill」。
4. **主会话可用的插件工具只有四个**：`wf_run` / `vwf_workspace` / `wf_control` / `vwf_debug`（`host.js:2160 / 2562 / 2584 / 2600`）——「结果回灌」必须新增工具面，不能复用现有工具语义。
5. 现有看板**已经**渲染逻辑运行分段与暂停卡（`packages/dsh-visual-workflow/src/client.js:2548-2550`「同一次运行 · 第 N 段」「第 N/M 段」、`client.js:2599-2600` 暂停恢复指令卡）——验收 #1 的「看板可见」有现成判定基准，不必等 LOC-016。
6. **编辑器「获取脚本」按钮已不在当前界面**：`host.js:1534` 注释写明「面板不再暴露预览/准备运行按钮」，`client.js` 中不存在任何 `vwf.script` 调用。但 `CONTEXT.md:133` 与 `dsh/README.md:320-324` 仍把「获取脚本 → 平台 `workflow` 工具」写成正式路径——**文档落后于实现的漂移**，「手工传脚本」在界面层面已无对应入口，只剩 runbook 层的手册口径。

### 2.2 运行记录实测与口径修正（含用户澄清，2026-09-11）

**初次采集**（`~/.dsh/visual-workflow/`、`~/.dsh-workflow-dev/visual-workflow/`）：20 条有任务归属的模板运行全部 `trigger=start`（必经 `wf_run` 边界），2+4 条残缺记录（`task_id=''`、单段、`completion=null`）全部是临时探针脚本。当时据此推断「真实运行已走 `wf_run`」——🔴 **该推断已作废**。

**用户澄清**：那 20 条均为 `#79`/`#80` 的 UAT / 测试数据，不代表真实使用。近几天真实在跑的工作是 **ZCode 会话里的需求分析 skill + 配套单任务工作流**，不在 DSH 本体里。

修正后的两轨现状：

| 环境 | 实际跑法 | 插件侧能力 |
|---|---|---|
| ZCode / 非 DSH（近期真实工作所在） | 需求分析 skill 及配套单任务工作流：流程控制由 SKILL.md 文本定义 | **插件不在场**——无可视化模板、无编译脚本执行、无 Logical Run、无看板 |
| DSH 本体 | 可用编译脚本获得更细控制（如按节点切换 provider / model） | 插件在场：Logical Run、看板、暂停/指导/恢复、按节点模型覆盖 |

**结论性校准**：

1. 卡上「Skill 路径只产生退化摘要」的触发条件 = **在 DSH 内由 Skill 触发模板运行**；该场景目前**无真实样本**（既未证实也未证伪）。
2. 真实工作发生在 ZCode 侧时，插件完全不在场：那里既不会有"退化记录"，也不会有"完整记录"——**插件侧的运行记录体系在非 DSH 环境根本不存在**。规格 §2.3「共享同一 Runtime」只在 DSH 内可谈。
3. 「脚本返回值只回到调用方」是机制事实（`CONTEXT.md:134`）：DSH 内置 `workflow` 工具的调用方是会话，插件只能旁观事件流；反之调用方是插件的 `wf_run` 时，插件拿得到返回值。**两条路都能执行脚本，差别只在"谁拿到了结果"。**

**对决策的影响**：决策前先确定一个前提——**DSH 内的 Skill 入口是否仍在你的使用路径上**。若在，则收敛为「口径统一 + 一次真实验证」（方案 A 的最小形态，B 不采纳）；若近期真实工作全部走 ZCode，本卡收益面需重新评估，可能应降级 backlog 并说明理由，把资源让给真实在跑的那条线。

---

## 3. 三要素复核

- **任务目标**：成立。消除调用入口双轨，使 Skill / Chat 发起的运行与插件入口共享同一 Logical Run Runtime（规格 §2.3）。
- **涉及范围**：**不成立（需修正）**。原文写「首选方案 A……备选/补充 B……方案取舍在实施 Definition Check 时按 #80 落地形态定」，等于把决定产品结果的取舍推迟到施工期。
- **验收标准**：方向成立，但两条判据需补口径：
  - #1「看板可见完整分段与摘要」：判定基准 = **现有运行看板**（已具备分段徽标与暂停卡）；LOC-016 的完整 Decision 卡 / 工作区 UI 不在本卡验收内。
  - #2「可按 `decision_id + user_choice` 续跑」：需明确「续跑由谁驱动」——若走 `wf_run`，续跑由插件执行并落档；若走平台 `workflow` 工具，插件只记录，续跑仍由主会话驱动（与 §2.3「同一 Runtime」存在口径差）。

---

## 4. 缺口（未决产品事项：1 项）

**决策对象（一句话）**：在 DSH 内由 Skill / Chat 触发起跑的工作流，**由谁发起执行**——由插件发起（`wf_run`），还是由会话拿 DSH 内置 `workflow` 工具发起。

为什么这一项决定产品结果：脚本执行结果只回到**发起方**。发起方是会话时，插件只能旁观引擎事件流，看板记录残缺且控制面不可用；发起方是插件时，记录完整、暂停/指导/恢复/续跑都可用。所以"谁发起"直接决定用户在看板上看到什么、能不能续跑。

它触及 §2.1 的多条「必须人工决定」判据：

- 改变用户体验：是否仍需要会话搬脚本（界面上的「获取脚本」入口已不存在，只剩手册口径）；
- 改变功能范围：是否需要新增插件工具面（回灌）；
- 改变风险承担：`wf_run` 不可用时 Skill 入口是「记录退化」还是「根本跑不起来」；
- 改变验收标准口径：验收 #2 的「续跑」由谁驱动。

**因此与卡上「无人值守许可 = 允许」互相冲突**：一张允许无人值守的卡不能内含「施工时再由人选择」的产品问题（Definition Check 9.6）。

**决策前提（用户澄清后新增）**：先确定 DSH 内的 Skill 入口是否仍在真实使用路径上（§2.2）。若近期真实工作全部走 ZCode，本卡问题面不成立，应重新定优先级，而不是先选 A/B/C。

---

## 5. 决策卡

需要决策：**DSH 内 Skill / Chat 触发的运行，发起权放在插件还是会话？**

为什么必须现在决定：它决定会话是否还要搬脚本、插件是否新增工具面、以及 `wf_run` 不可用时 Skill 入口是「记录退化」还是「根本跑不起来」——三项都会改变验收与风险边界。

**方案 A：runbook 改经 `wf_run`**
- 成本：改 `scripts/generate.mjs:748 skillWrap`（模板产物 SKILL.md）+ `dsh/skill/SKILL.md` 两条 runbook 的调用步骤与续跑步骤；`wf_run` 的 args 装配从「script 全文 + meta」变为「templateId + taskId + entry + issue/requirement」；跑 `npm run generate` + `npm run validate` 复核生成物。
- 收益：一次工具调用即完整 Logical Run——分段、任务归属、`completion`、HD 续跑、#80 控制面（pause/interrupt/guidance/resume）全部可用；主会话不再粘贴长脚本（同时缓解编译产物入参体量问题）。
- 风险：链条依赖 `wf_run` 在主会话可解析（引擎由 agent preset 挂载）。解析失败时入口会**报错**而非降级——比现状（能跑但记录退化）在可用性上更强硬。

**方案 B：保留平台 `workflow` 工具直起，新增最小「结果回灌」**
- 成本：新增主会话工具（如 `vwf_report`）+ 两条 runbook 增加回填步骤 + host 侧把退化摘要升级为完整记录（task 归属、`completion`、HD 续跑现场、Decision/Control Record）+ 新增测试。
- 收益：不依赖引擎可达性，正式路径与文档口径（§11 / `dsh/README.md:320`）不变。
- 风险：记录完整性依赖主会话照 runbook 回填，漏填即回到退化态；执行仍由平台工具驱动，Logical Run 只是「镜像记录」——`pause` / `guidance` / `model_overrides` 等控制面对这些运行实质不可用，与 §2.3「不能形成第二套运行体系」的边界需要单独说明。

**方案 C：A 为主 + B 为兜底**
- 成本：A 与 B 的并集，单卡体量偏大，需按可 UAT 切片拆两张（A：Skill 入口走 wf_run；B：回灌兜底）。
- 收益：无论引擎是否可达，验收 #1/#3 都能达成。
- 风险：范围最大；B 的双驱动口径问题依然存在。

**推荐：方案 A（本卡），B 登记为后续独立任务。**
推荐原因：A 是目标规格 §2.3 的直译——Skill 只是新的 Invocation Adapter，运行、续跑、控制面全部由同一个 Runtime 承载，用户路径也更短；B 让插件退化为「影子账本」，控制面在这些运行上不可用。A 的唯一硬依赖是引擎可达，而 v0.1 产品模式运行在 DSH 默认/code preset 下，该条件预期成立，可在实施第一步真实验证。

> **决策前置（建议先做，不需产品拍板）**：两个前置都缺真实样本——① DSH 内 Skill 入口是否仍在使用路径上（只有用户能回答，属使用意图）；② 若在用，它实际走 `wf_run` 还是内置 `workflow` 工具（可由一次真实运行观察，`trigger=start` 即有任务归属 ⇒ 走 `wf_run`）。两者确定后 A/B/C 大概率收敛：走 `wf_run` 则只剩「口径统一 + 验证」；走老路才需要在开工前拍板。

**若选 A，需同时写入基线的两条护栏：**

1. **前置验证（必须真实验证，不得只凭推断）**：在产品模式下由主会话发起一次 `wf_run`，确认可解析引擎；若不可用 → **停下呈报**，不得静默改走 B 或降级为退化记录。
2. **回退不静默**：`wf_run` 不可用时 runbook 明确回退到「获取脚本 + `workflow` 工具」，并显式提示「本次运行记录将退化为单段、无 `completion`」，不得让用户误以为记录完整。

---

## 6. 若选 A 的落地影响清单

- **改**：`scripts/generate.mjs` `skillWrap` 生成 runbook；`dsh/skill/SKILL.md` 调用与续跑步骤；必要时 `docs/design/blueprint-schema.md` / `dsh/README.md` 的路径口径对齐（「增强路径 / 正式路径」表述需随 A 调整）。
- **不改**：「四件套」产物集合（`script.mjs` 仍作为回退路径产物保留，仅 SKILL.md 内容变化）；`wf_run` 既有语义；非 DSH 执行器接入。
- **验证**：`npm test`、`npm run validate`（含生成物一致性闸门 `generated-diff`）；`runtime-logical-run` / `human-decision-e2e` 断言不改且全绿；真实走一次「Skill 触发 → 多段/HD 续跑 → `DONE` 有 `completion`」。
- **验收边界澄清**：验收 #1 判定基准 = 现有看板；LOC-016 负责完整 Decision 卡与工作区 UI。

---

## 7. 附带发现（不影响本次决策，供登记）

- 卡文件名 slug = `skill-invocation-runtime`，登记册 `slug` = `skill-logical-run-runtime`（`docs/tasks/registry.json:295` 附近）。二者不一致，建议随 V2 落档时对齐为卡文件名所用的 slug（低优先级，不影响施工）。
- 卡上「前置依赖：无本地卡依赖」成立；`LOC-018` 依赖本卡（`docs/tasks/LOC-018-release-acceptance.md:15`），本卡的范围变化会顺延影响发布验收范围，但不构成前置依赖。

---

## 8. Definition Check 结论

**未通过**：9.3「不存在施工时再决定的产品问题」、9.6「允许无人值守则无施工期人工选择项」两项未勾选，未决产品事项 = 1。

处置：状态不得停留在「本地已定义」，应先进入「待确认」→ 人工决策 → 更新基线 V2 → 重跑 Definition Check → 人工确认基线。逐项结果见同目录 `definition-check.md`。
