# 工作流统一引擎 · 地图（wayfinder:map）

> 本仓库无第三方 issue tracker 文档 → 采用 **local-markdown tracker**：本文件为地图，
> 票为 `wayfinder/tickets/<ID>-<slug>.md`。前沿（frontier）= status:open 且无未关闭阻塞项的票。
>
> **✅ 状态：已完成（2026-08-19）**——全部 11 张票（4 研究 + 7 决策）已关闭，v1 与 v2 的实现前决策全部锁定，可移交实现。

## Destination

把「开发工作流 2.0」的**双定义源**（`dsh/workflow/dev-workflow-2.0.mjs` + `packages/dsh-visual-workflow/src/host.js:29-74` 内嵌 `TEMPLATES`）收敛为**单一蓝图源** `templates/`，由生成器产出 vwf 注册与 DSH skill 双入口；v1 完成同源调用闭环（2.0 等价迁移、gold-band 清理、根基建+CI），v2 支持对话式创作与异源 enforcement（规格 §1.3、§6）。

**地图完成** = 实现启动前所有待决策项锁定：蓝图 schema、生成器编译策略、持久化/目录布局、生成物策略、2.0 等价验收标准、v2 两契约（对话式创作、异源 enforcement）。

## Notes

- 领域：DSH `workflow` 工具 + `dsh-visual-workflow` 插件的开发工作流编排。相关 skill：`research`（R 票）、`grilling`/`domain-modeling`（T 票）、`prototype`（T-01/T-02）。
- 规格 `docs/工作流统一引擎需求规格.md` 的 §2 问题清单已逐条核实（属实）；本图**只收录「实现前仍待决策」的问题**。规格中已明确的任务级工作（FR-5/FR-6 文档修链、FR-10 `.scratch` 迁移等）不是决策，不上图，直接按规格执行。
- 研究票产物落 `docs/research/<slug>.md`（工作树内、不提交；charting 会话统一收口，替代并发子代理不可用的 throwaway 分支）。R-01~R-04 已在本会话内联解析（子代理基础设施故障，fork 亦失败），四票已关闭，结论见 Decisions so far。
- 已核实的关键事实（供各票引用，细节见研究票产物）：
  - vwf 模板节点含规格 FR-1 字段清单**未列出**的 `model:{provider,model}`（硬编码）与 `manualCheck`（accept 节点）——schema 票必须收纳；
  - `compileDsl` 产物**已可被普通 `workflow` 工具直接执行**（host.js:581 回退路径的明示）——生成器复用 vwf 编译器的选项有事实支撑；
  - vwf 的条件边 `when`（如 `$.need_integration_test == true`）与 DSH 脚本内 `if` 分流语义同构，`if` 可由边编译而来；
  - 根 `.gitignore` 已覆盖 `.scratch/`（FR-10 的「产物不入库」部分已天然满足）；
  - `dsh/skills/` 已存在（`requirements-analysis`）——生成 skill 的落点有先例，但发现/路由机制未验证（R-04）。

## Decisions so far

<!-- 每关闭一张票，追加一行：- [<票名>](tickets/...) — <一句话结论> -->

- [R-01 dev-workflow-2.0.mjs 语义盘点](tickets/R-01-mjs-semantics.md) — DSH 脚本语义全集已盘点（入口四态/脚本内分流/9 轮+超限归因/roleRef 自读角色/人工门禁在脚本外）；vwf 编译产物缺 3 个 DSH 增强：超限归因、verified_branch 可信度闸门、异源 warning。细节见 `docs/research/mjs-semantics.md`。
- [R-02 vwf 宿主与 DSL 盘点](tickets/R-02-vwf-host-internals.md) — validateDsl 规则全集与 compileDsl 机制已确认；**compileDsl 产物即标准 workflow 脚本、可被普通 workflow 工具执行**（T-02 复用路线有据）；模板节点含规格漏列的 model/manualCheck/description；save 仅内存。细节见 `docs/research/vwf-host-internals.md`。
- [R-03 workflow 工具脚本契约](tickets/R-03-workflow-tool-contract.md) — 脚本契约已确认：vm 执行、5 钩子、agent opts 白名单（label/phase/schema/provider/model）、schema 8 关键字子集、META_INVALID/SCRIPT_PARSE 同步抛、run.result 永不 reject、上限 1000/4096。生成脚本检查清单见 `docs/research/workflow-tool-contract.md`。
- [R-04 DSH skill 发现与触发词路由](tickets/R-04-skill-discovery.md) — **`dsh/skills/` 不是默认发现根**（发现根 = `.dsh/skills`/`.agents/skills`/`~/.agents/skills` 等）；生成 skill 须配套安装步骤或改落 `.dsh/skills`；无 harness 别名，触发词路由是 description 软路由；防与现有 `dev-workflow-2-0` 重名。细节见 `docs/research/skill-discovery.md`。
- [T-01 蓝图 schema 与校验规则定稿](tickets/T-01-blueprint-schema.md) — schema 定稿 `docs/design/blueprint-schema.md`：单标识 id=name+displayName；bindings.models 节点粒度；分流=route 节点+双 when 边、DSH 折叠为 if；DSH 三增强进蓝图（onMaxRounds/heteroCheck/verifyBranch）；校验分层对齐 validateDsl（入口不唯一一律拒绝）；契约落 docs/design/。→ **T-07 已解锁**。
- [T-02 生成器编译策略](tickets/T-02-generator-strategy.md) — **S1 单编译器**（compileDsl 语义移植 + 增强编译选项）；S2 生成物 gitignore 区+重生成；S3 幂等=重生成 diff 比对；S4 根 package.json scripts.generate+CLI。原型 `.scratch/generator-prototype/` 已验证：全量 2.0 编译通过、route 折叠识别、引擎真实运行生成脚本（状态机/失败路径按契约）、幂等 identical；端到端 DONE 待子代理基础设施恢复复验。产物四件套 `out/<id>/{script.mjs, vwf-dsl.json, SKILL.md, meta.json}`；模型绑定编译期固化。
- [T-03 模板持久化与目录布局](tickets/T-03-persistence-layout.md) — **双轨**：内置蓝图仓库 `templates/`、用户模板宿主目录 `~/.dsh/visual-workflow/templates/`；save 撞名拒绝提示改名（更新自身允许）、内置只读、remove 仅用户；**save 即闭环**——保存用户模板同步编译自包含技能目录 `~/.dsh/skills/<id>/`（update 重编译、remove 同步删），零动作实现图形→文字版；仓库显式发布保留为可选；host.js 双根加载（内置生成物位置归 T-04）；workflows/ 不重定位（随 FR-5 删）。→ R-04 的 skill 安装问题由 save 联动天然解决。
- [T-04 生成物策略](tickets/T-04-artifact-policy.md) — **gitignore + 重生成、不入库**（T-02 S2/S3 确认）：目录 = 根级 `.generated/<id>/` 四件套；validate 集成 = 编译到 `.generated.check/` 临时目录逐文件比对（不一致即失败，CI 可加 git diff 兜底）；只读三层 = gitignore + 重生成 diff + 头部注释/README；风险 5 的入库+新鲜度检查路线**关闭**（FR-9 不再需要该检查）；T-03 移交的「内置生成物目录」= `.generated/`，host.js 双根接口闭合。
- [T-05 2.0 等价性验收标准](tickets/T-05-equivalence-acceptance.md) — **语义等价 + 新契约统一**：8 维度全收；验收 = 结构断言（10 项，`scripts/equivalence.test.mjs` 进 validate）+ 行为清单（`docs/design/equivalence-checklist.md`，v1 收口人工核对）；不做双路对拍；**新发现**：三要素缺失由 `REJECTED_INCOMPLETE` 变为 `FAILED_AT_dispatch`（接受差异，runbook 增补 `FAILED_AT_*` 驱动）；返回体统一 `AWAITING_HUMAN_<节点id>`+resume；旧 mjs 验收后退役。→ **v1 决策面清空**。
- [T-06 异源 enforcement 契约](tickets/T-06-heterogeneity-contract.md) — **弱异源放行+完全同模型拒**（判定键 provider+model，消解规格措辞冲突）；save/update/validate 三处校验，engine 不拦；**全局强制**（凡含 dev+review 节点一律校验，缺绑定拒）；错误沿用 errors[]；AC-8 细化 6 例（T1 同模型拒/T2 弱异源过+警告/T3 真异源过/T4 缺绑定拒/T5 跳过/T6 update 同 save）；heteroCheck 退化为运行时日志。blueprint-schema.md 已同步（§3.1 规则 7，v2 生效）。→ **T-IMP-07 ✅（2026-08-20 插件层落地）**：识别键按节点 `id` 或 `profile` 定位 dev/review，引擎规则 4/7 与 host.js 内联校验同源，测试 T7/T8 增补。
- [T-07 对话式创作会话契约](tickets/T-07-conversational-authoring.md) — **统一 T-03 闭环**（会话创作 = 蓝图接受管线：门禁→宿主目录→同步 skill；共享=显式发布）；生成物保护 = 约定+重生成 diff+generate 恢复；入口 = 专用 skill（workflow-template-authoring，复用生成器/校验器）；门禁自修 3 轮；内置只读、修改=fork 新 id；AC-7 验收 = 会话演练 + 自动化断言（含重建覆盖手改）。→ **全图最后一张票，地图完成**。

## Not yet specified

- **CI 细化范围（FR-9）**：剩余候选 = 多模板回归（v1 validate + v2 异源校验集成已落定）；v2 执行时定。
- **NL 触发词路由的实现验证**：R-04 结论 + T-03 闭环已覆盖大半（skill 落 `~/.dsh/skills/` 发现根、id 唯一防重名）；「description 软路由是否满足 AC-6」留 v1 实现时实测验证（规格风险 3）。
- **per-node 权限管控（v2 候选）**：T-01 评审（Q4）确认当前宿主统一沙箱（workspace-write）管控、蓝图不预置权限字段；若未来需要节点级读写差异（如审核只读），属引擎/宿主能力扩展——何时做、怎么做待定。

<!-- 已消化项（保留为历史）：NFR-1 只读机制 → T-04 三层已定；既有 vwf 用户模板迁移 → P0 原型不落盘（内存 Map），无历史数据，N/A；生成物入库 → T-04 关闭；异源校验集成 → T-06 落定 -->

## Out of scope

- **引擎统一**：已核实运行时本就同源（DSH `.mjs` 即 workflow 工具 script；host.js:588 将编译产物交给同一 `workflowEngine.start`），规格 §1.2 已确认，不再处理。
- **gold-band 编辑器 / WorkflowGraph 重构**：本期只清理不修复（规格 §1.4）。
- **运行时调度/并发策略**：vwf 已有，不在本期。
