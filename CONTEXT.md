# CONTEXT.md — 领域术语表（workflow-manager）

> 本仓库的共享领域语言：架构评审 / 设计 / 实现会话的权威词汇来源。新增术语在此登记。
> 由 improve-codebase-architecture 会话（候选三收口）懒创建。决策记录见 `wayfinder/MAP.md` 与
> `docs/design/`；本文件只收词汇，不收决策。

## 核心对象

- **蓝图（blueprint）**：`templates/*.json`，工作流唯一事实源——人只改它，生成物禁手改。
- **生成物（artifact）**：`.generated/<id>/` 四件套（script.mjs / vwf-dsl.json / SKILL.md / meta.json），gitignore + 重生成比对保护。
- **节点 / 边 / 入口 / $end**：蓝图图结构。边分 success（成功/打回后继续）与 failure（打回/终止）两类。

## 引擎层（框架，与业务无关）

- **翻译员（编译器）**：把蓝图翻译成可执行脚本的模块。仓库现有两位——
  - `compileDsh`（住在 `scripts/generate.mjs`）：DSH 入口，带全部增强（折叠/闸门/归因/异源日志）。
  - `compileDsl`（住在 `packages/dsh-visual-workflow/src/host.js`）：vwf 入口，无增强。
  - **已知差异（候选一待统一）**：折叠（宿主侧走 LLM）、可信度闸门（宿主侧无）、超限归因（宿主侧无）。
- **校验器**：蓝图形态 `validate-blueprint.mjs` 与 DSL 形态 `host.js validateDsl` 两份规则集（候选二待统一）。
- **走通性（walkability）**：框架级保证——任何蓝图运行要么走通（DONE），要么以明确终态终止
  （`FAILED_AT_*` / `FAILED_MAX_ROUNDS` / `TECHNICAL_FAILURE` / `ENDED_NO_*` / `ERROR`），绝不卡死。
  创作期规则：有 successCondition 的节点必须有 failure 边（否则判定失败无出口，运行时只能报
  `ENDED_NO_FAILURE_EDGE` 兜底）。
- **运行时排练厅（runtime harness）**：测试基建——`scripts/test/helpers/runtime-harness.mjs`。
  以预置「演员表」（剧本）驱动生成脚本真实执行，断言**返回体（接口）**而非脚本字符串。
  剧本 = 按出场标签提供台词（可静态可函数）；交作业按 `opts.schema` 八关键字子集验收，
  不合格返回 null（仿真真实引擎的 agent 契约）。
- **对拍**：同一批场景跑双翻译员产物——公共语义断言一致（C1）、已知差异断言存在（C2）；
  C2 差异断言翻转为一致的那天 = 候选一（统一编译器）完工日。

## 模板层（业务规则，非框架契约）

- **三要素**：调度节点校验 issue 的 目标/范围/验收标准（内置图纸业务规则）。
- **打回与轮次（round / maxRounds）**：failure 边驱动的重做循环与上限。
- **分流折叠**：两路同路径条件分流的节点在 DSH 侧折叠为脚本内 if（零 LLM）；vwf 侧保持 route 节点。
- **可信度闸门（verifyBranch）**：验证节点开工分支自检 + `verified_branch`/`verified_head` 硬校验。
- **异源（heteroCheck）**：dev↔review 模型绑定必须不同（save/validate 层强制；运行时日志）。
- **人工门禁（manualCheck）**：节点产出后挂起（`AWAITING_HUMAN_<节点id>` + resume 载荷），人工裁决后续跑。
- **受阻语义（Q12 修正）**：run 级无 BLOCKED；节点结果枚举（test `BLOCKED` / dev `blocked`）仍有效——
  dev 受阻 = `FAILED_AT_dev`（failure 边兜底），test 受阻 = 沿 failure 边打回开发。
