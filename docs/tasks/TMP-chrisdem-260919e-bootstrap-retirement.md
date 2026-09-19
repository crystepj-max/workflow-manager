# TMP-chrisdem-260919e｜construction-bootstrap 退役与引用改指 wf-construction-full-feature

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | TMP-chrisdem-260919e（临时号；正式号待 CHORE-111 发号源落定后申请并换取） |
| 需求来源 | github-issue |
| 来源定位 | GitHub Issue #102（epic：建设·完整功能开发工作流双执行 Profile）Slice 4「Formal Convergence」余项 |
| 任务名称 | construction-bootstrap 退役与引用改指 wf-construction-full-feature |
| 任务类型 | 维护性（CHORE 性质：文档与入口收敛，无产品语义变更） |
| 分类 | 收口/退役 |
| 体量 | M |
| 优先级 | P1 |
| 当前状态 | 施工中（本会话交付后待人工验收） |
| 需求基线版本 | V1 |
| 前置依赖 | 无（依赖的九项 Runtime issue 已全部 CLOSED） |
| 施工环境组 | TMP-chrisdem-260919e |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许（改动全为仓内文档/脚本，对外动作不自主执行） |
| 任务规格位置 | `docs/tasks/specs/TMP-chrisdem-260919e-bootstrap-retirement/task-spec-V1.md` |
| 定义时间 | 2026-09-19（用户以开工指令 + 两项裁定给出基线） |
| GitHub 同步 | pending |

未登记进 `docs/tasks/registry.json`、未重写 `docs/tasks/BOARD.md`：发号源正由 CHORE-111 迁移且该票仍「待确认」，规则未生效；且本检出上 `registry.json` / `BOARD.md` 已有其他在途会话的未提交改动，`allocate` 会覆盖他们的工作。正式号换取与看板重写留待发号口径落定后单独处理。

## 摘要（三要素）

**目标：** 已被 `wf-construction-full-feature` 取代的 Bootstrap 执行 Profile（`dsh/skills/construction-bootstrap/`）在仓库里正式退役，所有引用指向新的正式模板与对应 skill，且退役不丢任何现行有效规则、不留双事实源。

**范围：** 做——① 把 runbook 仍承载的 DSH 轨道操作序列迁到 `docs/runbooks/construction-dsh/runbook.md`；② 把 `$CWF_ASSETS` 口径统一改为仓库内 `scripts/`；③ 九项 Bootstrap shim 的退役事实与落地证据按 shim-map 自身纪律回写 `construction-workflow-portable-contract.md` §9.6；④ 改写全部现行引用点（历史任务记录不动）；⑤ 修两处会因删目录而失效的脚本（机械验收断言、skill 集同步的复活路径）；⑥ 删除 skill 目录与安装脚本。不做——改蓝图中断言与出边、改生成器、改四套模板的触发词、清理历史任务卡与 research 记录、动 `registry.json` / `BOARD.md`。

**验收标准：**

- [ ] AC-01：仓库内不再有 `dsh/skills/construction-bootstrap/` 与 `dsh/install-construction-bootstrap.sh`。
- [ ] AC-02：全仓 grep `construction-bootstrap` 只剩历史/收口记录类提及（`docs/tasks/**`、`docs/research/**`、`wayfinder/**`、契约 §9.6 收敛记录与示例链的历史 `produced_by` 值）。
- [ ] AC-03：原 runbook §0（开发 DSH 单实例 9527 / Run 命名空间前缀 / 单激活 / 收口回收）与 §6（人工验收严格三态、裁决前重跑证据校验）的现行规则，在新 runbook 或其权威文档里逐条仍可找到，无静默删除。
- [ ] AC-04：九项 shim 逐项带 issue 与 main 落地证据写入契约 §9.6，证据 hash 均可 `git merge-base --is-ancestor` 核对。
- [ ] AC-05：`node scripts/validate-guide-drift.mjs`、`node scripts/ai-task-deliver-m2-check.mjs`、`node --test scripts/test/ai-task-deliver-m2.test.mjs` 全绿。
- [ ] AC-06：`node --test scripts/test/*.test.mjs` 不新增失败项——与 base 提交在同等环境（无 `node_modules` / 无 `packages/*/dist`）下逐项对照。
- [ ] AC-07：`node scripts/sync-ai-task-skill-set.mjs` 不再包含把 `construction-bootstrap` 装回公共技能池的路径。

## 成立性判定（本会话复核结论，含对开工简报的校正）

- 简报的「runbook §6 = 九项证据链校验」与实际不符：runbook §6 是**人工验收严格三态**，九项校验在 `construction-workflow-portable-contract.md` §8.3（①–⑨），回收口径在 §7.3。本任务按实际分块逐项核承载点。
- 简报的「install 脚本零调用者」需限定：无自动调用者成立，但 `README.md` 把它写成安装入口，删脚本必须同改 README。
- **简报未提的两个硬依赖**：`scripts/ai-task-deliver-m2-check.mjs` 直读该 skill 的 SKILL.md 与 runbook.md（经 `ai-task-deliver-m2.test.mjs` 进入 `npm test` 与 `npm run validate`），只删目录会让主干测试变红；`scripts/sync-ai-task-skill-set.mjs` 把该 skill 同步进 my-agent-skills 且缺源即 `exit 1`，是**双事实源复活路径**。两处已在本任务内修掉。
- 「两份用户可见建设模板并存」从未发生：`~/.dsh/skills`、`~/.agents/skills`、`~/.workbuddy/skills`、`~/workspace/my-agent-skills/my-skills` 四处实测均无 `construction-bootstrap` 安装副本。本任务删的是仓库定义源，不影响任何运行态。
- 九项 shim 的 GitHub issue 全部 `CLOSED / stateReason=COMPLETED`（非 won't fix）。

## 已拍板的产品口径

- ✅ **裁定一 = 保留一份 DSH 轨道 runbook**：命令序列改写成 `docs/runbooks/construction-dsh/runbook.md`（与既有 Codex/Cursor 版 `construction-external/` 对称），只留仍有效的操作序列，删掉已被引擎取代的 controller 逐节点路由解释。确认人 松哥（crystepj-max），2026-09-19 本会话。
- ✅ **裁定二 = `$CWF_ASSETS` 统一改写为仓库内 `scripts/` 路径**：不为安装态另建 assets 打包机制（那属真实功能开发，超出退役范围）。代价如实记录：脱离本仓的安装态会话不再自带 `cwf-*.mjs`。确认人 同上，2026-09-19。

## 影响与已知遗留（待人工决定是否另立任务）

- 🟡 **触发词损失**：旧 Bootstrap skill 的触发词含「建设工作流」「construction」「用建设工作流跑 issue」「construction-bootstrap」；正式生成 skill 的触发词来自模板 `displayName`「完整功能开发」与模板 id。改触发词要动蓝图 `description`（属已发布产物，牵动 release:verify 与产品验收），本任务未做。
- 🟡 契约文档头版本行进到 **v0.1.9**（仅追加 §9.6 收敛记录，正文七阶段语义仍按 v0.1.8 冻结，未触发 §9.3 冻结解除条件）。
- 🟡 `AGENTS.md` 的 VWF 开发双轨段仍写「独立开发 DSH Home `~/.dsh-workflow-dev`」，与决策六的单实例口径并存——那是插件开发轨的既有表述，不属本任务范围，未顺手清理。
- 🟡 **连带影响（本任务引入，未自行处理）**：改 `dsh/roles/dev.md` 与 `dsh/roles/closeout.md` 会改到编译进 `.generated/*/script.mjs` 的角色正文，四套内置模板的编译摘要随之变化，`scripts/benchmark/loc-045/config/freeze-manifest.json` 记录的 `template_digests` 因此过期。重新冻结属 LOC-045 基准主人的动作（`npm run benchmark:loc-045:freeze`），不在退役提交里夹带。
- 🔴 **附带发现（先于本任务存在）**：该 freeze manifest 在本任务动工前就已与仓库不一致——`scripts/generate.mjs` 未被本任务改动，其实算摘要 `5ca5ff4b…` 与 manifest 记录的 `script_digest` `fc0940db…` 不符。另：跑 `node --test scripts/test/*.test.mjs` 会把 52 个 LOC-045 已跟踪产物（`results/prepared/*`、`reports/research-report.*`、freeze manifest）就地重写；本会话已全部 `git checkout --` 还原，未纳入提交。这两件事建议各自另立任务。

## 详细规格

见 `docs/tasks/specs/TMP-chrisdem-260919e-bootstrap-retirement/task-spec-V1.md`。本任务的需求基线由开工指令 + 上列两项裁定给出，未另跑 Definition Check 清单（不新建第二套定义入口；实质变更走 Vn→Vn+1）。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-19 | 施工中 | 独立开工会话完成承载比对取证，呈递两项去向裁定；用户落定后在 `dev-tmp-chrisdem-260919e-r1` 施工：新建 DSH runbook、契约 §9.6 回写、22 处引用与脚本改写、删除 Profile 目录与安装脚本 |
