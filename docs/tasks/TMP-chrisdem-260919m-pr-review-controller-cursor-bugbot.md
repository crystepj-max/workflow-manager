# TMP-chrisdem-260919m｜PR Review Controller 触发通道从 Codex 切换到 Cursor Bugbot

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | TMP-chrisdem-260919m（临时号；正式号待 CHORE-111 / GitHub #215 发号源落定后申请并换取，本会话不代申请） |
| 需求来源 | github-issue |
| 来源定位 | GitHub Issue [#134](https://github.com/crystepj-max/workflow-manager/issues/134)（PR Review Controller 本体）＋ 产品 2026-09-19 决策：Codex 触发通道停用，改用 Cursor Bugbot |
| 任务名称 | 把 PR Review Controller 的触发引擎从已停用的 Codex 切换到 Cursor Bugbot，并把轮次治理语义保持不变 |
| 任务类型 | 维护性（把在用受控入口从停后端切到等价的在用后端的引擎重指） |
| 优先级 | P1 |
| 当前状态 | 待确认 |
| 需求基线版本 | V1 |
| 前置依赖 | 无（产品已在会话内选定 Cursor Bugbot） |
| 施工环境组 | TMP-chrisdem-260919m |
| 施工环境角色 | 独立 |
| 无人值守许可 | 不允许（含 Cursor 控制台配置、真实冒烟、Secret 配置、命令命名空间裁定等须人在环项） |
| 任务规格位置 | `docs/tasks/specs/TMP-chrisdem-260919m-pr-review-controller-cursor-bugbot/task-spec-V1.md` |
| 定义时间 | （确认「已定义」时写入） |
| GitHub 同步 | pending |

> 未登记进 `docs/tasks/registry.json`：登记册门禁（`scripts/validate-task-spec-sync.mjs` 规则 1）要求活跃任务有远端锚点，而正式号需向远端发号——属对外动作且发号源正由 CHORE-111（GitHub #215）迁移中、状态仍「待确认」；且本检出 `registry.json` 此刻含他人未提交改动，本会话不代写、不代申请。发号授权后一并登记并重命名目录。
> 编号口径：迁移未生效前沿用现有「远端发号 / 不可达降级 TMP」口径，故取 TMP 草稿号；卡内 slug 为本任务独有，目录不会与其他在飞卡片撞名。

## 摘要（三要素速览）

### 任务目标

让 GitHub PR 的受控评审入口（Controller）在 Codex 停用的情况下改由 **Cursor Bugbot** 完成实际评审，同时**完整保留**治理语义：唯一入口、默认 3 轮、同 HEAD 去重、人工 `extend` 只加 1 轮、服务故障 retry 不消耗业务轮次、fail-closed、可审计轮次记录。

### 涉及范围

- 做：
  - Controller 触发评论正文由 `@codex review + 逐轮自由提示词` 改为触发词 `@cursor review`（以 Cursor 设置页 Manual-Only 文案为准，收成单一常量 `TRIGGER_COMMAND`；Cursor Bugbot 只认常驻规则、不吃单次提示词）；
  - Secret 环境变量名由 `CODEX_REVIEW_TOKEN` 改为 `PR_REVIEW_TRIGGER_TOKEN`，脚本与 workflow 同步；fail-closed 文案同步到 Cursor；
  - 新增 `.cursor/BUGBOT.md` 常驻规则：A/B/C 分类、不扩大当前 PR、收敛纪律（评审时判定口径的唯一可执行落点）；
  - `AGENTS.md`「PR Review 收敛规则（Cursor Bugbot）」一节措辞与事实同步；
  - 更新 Controller 测试：断言新触发词、补「非 PR 评论不触发」与「PR 内非命令不触发」两条缺口用例，不削弱既有断言。
- 不做：
  - ~~不改命令命名空间 `/codex-review`~~：DT-01 于 2026-09-20 裁定 **B**，已改名 `/pr-review`（V2，见变更记录）；
  - 不改轮次/去重/extend/fail-closed/串行算法与内部审计标记（`STATE_MARKER` 等），保证在途 PR 状态连续；
  - 不擅自把触发方式从「评论」改成「`POST /api.cursor.com/bugbot/review`」（更稳但机制改动大，作备选呈递）；
  - 不在 Cursor 控制台连接仓库 / 关自动评审 / 配 Secret（工具外动作，交用户）；
  - 不推送、不建 PR、不合并、不关闭 #134（对外动作，须另行授权）。

### 验收标准

- [ ] 触发评论首行为常量触发词 `@cursor review`，正文不再出现 `@codex`；轮次计数、去重、`extend`、`retry`、fail-closed 行为与切换前逐项等价。
- [ ] `.cursor/BUGBOT.md` 存在且自带评审时 A/B/C 与不扩大 PR 的判定规则（因 Bugbot 不读 `AGENTS.md`），并与 `AGENTS.md` 一节口径一致、不另立额度规则。
- [ ] `AGENTS.md` 该节不再出现「Codex 触发 / `@codex review`」的现行指令表述；历史变更日志中的 Codex 记录保持原样。
- [ ] `scripts/test/codex-review-controller.test.mjs` 全绿，含新增「非 PR 评论不触发」「PR 内非命令不触发」用例；既有断言未删除。
- [ ] `node --check` 通过；`npm run validate:task-context` 不因本卡新增失败。
- [ ] 产品对「命令命名空间是否改名」「是否改用 API 触发」两项作出裁定后，按其选择收口或明确记为后续卡。

## 详细规格

见 `docs/tasks/specs/TMP-chrisdem-260919m-pr-review-controller-cursor-bugbot/task-spec-V1.md`；Definition Check 见同目录 `definition-check.md`；两项待裁产品选择见 `decision-tickets/`。实质变更走 V1→V2。

## 关键事实（实施前复核 + 用户实测设置页，2026-09-19）

| 项 | 结论 | 出处 |
|---|---|---|
| 触发命令 | **以设置页 Manual-Only 文案为准：`@cursor review`**（别名 `bugbot run`）；公开文档另有不带 `@` 的 `cursor review` 写法——**真实生效形式待冒烟，两种都要试**；实现走单一常量 `TRIGGER_COMMAND` | 仓库 Bugbot 设置页 + cursor.com/docs/bugbot |
| 设置页实况（用户 2026-09-19 配好） | Trigger Mode = **Manual Only**；Incremental Review = **On**；Review Draft PRs = **Off**（安装默认）；PR Summaries = **On**（🟡 建议关，PR 描述属收口证据）；Autofix = **Off**（🔴 须持续关）；Effort = **Smart**（🟡 用量不可预估） | 用户提供的设置页现状 |
| 一次性提示词 | 不接受（只有 `verbose=true` 与 `@cursor remember` 常驻学习） | cursor.com/docs/bugbot |
| 规则文件 | `.cursor/BUGBOT.md`（`.cursor/rules/*.mdc` 对 Bugbot 无效）；Bugbot 是否读 `AGENTS.md` 未确认 | 同上 |
| 自动评审可关 | 仓库级 Trigger Mode / `manualTriggerOnly=true`（`POST /bugbot/repo/update`）；个人级 UI「Run only when mentioned」 | cursor.com/docs/bugbot |
| bot 身份能否触发 | **未获官方确认**；Team 有按 username 的 Bugbot 席位 allowlist/blocklist，`github-actions[bot]` 大概率被静默过滤 → 须用独立触发身份 | 同上（推断标注） |
| 计费 | usage-based，私有仓库按正常评审计费，`dryRun` 也计费；Effort=Smart 使单次用量不可预估 | 同上 |
| 集成前置 | 须在 Cursor 控制台连接仓库并启用 Bugbot | 同上 |

## 关联

- GitHub #134（Controller 本体）、#215 / `CHORE-111`（发号源迁移，状态待确认）
- `docs/tasks/CHORE-110-*`、`docs/tasks/specs/…/` 现有格式先例
- `.github/workflows/codex-pr-review-controller.yml`

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-19T21:4xZ | 定义中 | 独立开工会话立卡；按在飞 TMP 草稿口径不代写 registry、不代发号 |
| 2026-09-19T22:0xZ | 定义中 | **据用户实测 Cursor 设置页修正**：触发词以 Manual-Only 文案为准改 `@cursor review`（单一常量 `TRIGGER_COMMAND`，公开文档无 @ 写法保留为冒烟备选）；写入 Incremental Review=On（收敛只看新改动，不再重复要求）、Review Draft=Off（须先转 Ready）、PR Summaries=On（建议关，PR 描述属收口证据）、Autofix=Off（🔴 须持续关）、Effort=Smart（成本不可预估，另给固定档位选项）；同步 BUGBOT.md / AGENTS.md / 规格 |
| 2026-09-20T07:0xZ | 交付中 | **DT-01 裁定 B**：命令 `/codex-review`→`/pr-review`（无兼容），同步 Controller 解析 / workflow `if:` / AGENTS.md / BUGBOT.md / 测试；内部标记与文件名保留旧名。#134 已因引擎切换关闭，本改名作为其后续在同一分支链跟进 |
