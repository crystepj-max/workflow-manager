# PR Review Controller 触发通道从 Codex 切换到 Cursor Bugbot

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 任务标识 | `TMP-chrisdem-260919m`（临时号） |
| 对应远端 | GitHub #134（Controller 本体；正式发号待 CHORE-111/#215） |
| 需求来源 | github-issue（#134）＋ 产品 2026-09-19 会话决策 |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 不允许 |
| 当前状态 | 待确认 |

## 1. 需求背景

#134 建立的 PR Review Controller 让 Agent 只能通过 `/codex-review next` 进入受控入口，由 Actions 里的 Controller 发真正的 `@codex review` 触发评论，并管轮次、去重、`extend`、fail-closed。Codex 侧因额度不足已不可用（最后一次真实调用停在 PR #188，那轮被额度耗尽白吃；CNB 恢复后合并的 11 个 PR 完全未走 Controller）。产品 2026-09-19 选定改用 **Cursor Bugbot**。

## 2. 用户问题

不换引擎，受控评审入口整体停摆：Agent 要么绕过入口自触发（回到当初要治理的无限 Review 循环），要么干脆不走 PR Gate。换到 Cursor 后，Cursor Bugbot 与 Codex 的触发模型不同——它只认仓库常驻规则、不接受单条自由提示词，且能否接受 `github-actions[bot]` 身份尚未确认。直接照搬会把「轮次差异化提示词」静默丢失，或把无限自动评审带回。

## 3. 目标

把实际评审引擎换成 Cursor Bugbot，**治理语义逐项不变**（唯一入口 / 3 轮 / 去重 / 人工 extend / fail-closed / 可审计轮次）；把原本靠逐轮提示词表达的评审要求，落成 `.cursor/BUGBOT.md` 常驻规则；轮次上下文以 Controller 状态评论留痕。

## 4. 非目标

- 不改命令命名空间 `/codex-review`（改名见决策票 DT-01，交产品）。
- 不改轮次/去重/extend/retry/fail-closed 算法与内部审计标记（`STATE_MARKER`、trigger/retry marker token 名保持，避免在途 PR 状态断链）。
- 不擅自把触发从「评论」改为「API 调用」（DT-02 备选，交产品）。
- 不做 Cursor 控制台连接 / 关自动评审 / 配 Secret / 真实冒烟（工具外，交用户）。
- 不推送、建 PR、合并、关闭 #134（对外动作）。
- 不改历史变更日志里的 Codex 记录（准确性属当时事实）。

## 5. 修改前

| 位置 | 现状 |
|---|---|
| `scripts/codex-review-controller.mjs:54-66` | `buildReviewPrompt` 返回 `@codex review 第 N/M 轮…` 逐轮自由提示词 |
| 同文件 `:93` | 状态评论抬头「Codex PR Review Controller」 |
| 同文件 `:107` | User-Agent `workflow-manager-codex-review-controller` |
| 同文件 `:153-165` | fail-closed 文案引用「Codex / `CODEX_REVIEW_TOKEN`」 |
| 同文件 `:174/177/238/248` | 面向用户的消息含「Codex」 |
| 同文件 `:273` | `const reviewToken = process.env.CODEX_REVIEW_TOKEN` |
| `.github/workflows/codex-pr-review-controller.yml:24,28` | 步骤名「Codex Review」；`CODEX_REVIEW_TOKEN: ${{ secrets.CODEX_REVIEW_TOKEN }}` |
| `AGENTS.md §Codex PR Review 收敛规则` | 通篇 `@codex review` / 「Controller 负责逐轮提示词」 |
| 测试 `codex-review-controller.test.mjs` | 断言 `@codex review` 语义；「非 PR 评论不触发」无自动化用例 |

## 6. 修改后

- `buildReviewPrompt` 首行为 `@cursor review`；轮次/范围要求以可见留痕 + HTML 注释审计，不再作为对评审引擎的指令；正文不含 `codex`。
- Secret 环境变量与 workflow 引用统一为 `PR_REVIEW_TRIGGER_TOKEN`；fail-closed 文案指向 Cursor 与 PAT 身份。
- 新增 `.cursor/BUGBOT.md`：评审时 A/B/C 分类与不扩大当前 PR、收敛纪律；显式声明治理侧以 `AGENTS.md` + Controller 为准。
- `AGENTS.md` 一节更名为「PR Review 收敛规则（Cursor Bugbot）」，措辞换到 `@cursor review`，新增「评审聚焦口径改为 `.cursor/BUGBOT.md`」与「Cursor 集成前置条件（未满足即静默失效）」两条；命名空间沿用注记。
- 测试：断言首行 `@cursor review` 且无 `@codex`；新增「非 PR 评论不触发」「PR 内非命令不触发」；保留原轮次留痕断言。

## 7. 功能范围

1. Controller 引擎重指：触发词、Secret 名、面向用户与 fail-closed 文案、User-Agent。
2. `.cursor/BUGBOT.md` 常驻规则新建。
3. `AGENTS.md` 治理节同步。
4. 测试更新与补强。
5. 本卡与规格落档。

## 8. 不修改范围

`packages/dsh-visual-workflow/`、`templates/`、生成物、`registry.json`（他人在飞）、`docs/tasks/` 他人条目、历史变更日志、Cursor 控制台侧配置。

## 9. 业务规则

- 治理语义不得因换引擎而丢失或放松：额度、轮次计数、去重、人工 `extend` 只加 1 轮、`retry` 不增业务轮次、fail-closed 不消耗轮次、串行并发组，逐项保持。
- 评审时判定口径（A/B/C、不扩大 PR）必须有 Bugbot 能读到的可执行落点（`.cursor/BUGBOT.md`），因为 Bugbot 不读 `AGENTS.md`；该文件不复述额度/命令，指向 `AGENTS.md` 为事实源，避免第二套规则。
- 内部审计标记（`codex-review-controller-state` 等）不改名，保证在途 PR 的状态评论仍可被 `findStateComment` 命中。
- 对外动作（推送 / PR / 合并 / 关 #134）与工具外配置（Cursor 控制台 / Secret）默认不执行，交用户。

## 10. 用户操作路径

1. Agent 在 PR 评论 `/codex-review next` → Controller 校验身份/轮次 → 以触发身份发 `@cursor review` 评论 → Bugbot 按 `.cursor/BUGBOT.md` 起评审 → Controller 更新轮次状态评论留痕。
2. 第 4 次 `next` → 拒绝并提示 `extend`。
3. Secret 未配 / Bugbot 未起 → fail-closed，不消耗轮次，文案指引配置 `PR_REVIEW_TRIGGER_TOKEN`。

## 11. 异常和边界场景

- **触发词真实形式待冒烟**：设置页 Manual-Only 文案写 `@cursor review`（别名 `bugbot run`），公开文档另有不带 `@` 的 `cursor review`。已按设置页取 `@cursor review` 为单一常量 `TRIGGER_COMMAND`；冒烟时两种都要试，若 `@cursor review` 不被接受则只改常量一处即可。
- **`github-actions[bot]` 被 Bugbot 静默过滤**：现状已用独立 `reviewToken` 身份发触发评论（非 actions 身份），与该风险同构规避；若该 PAT 身份仍不被接受（Team 按 username 卡席位名单），须换被接受的账号身份或转 API 通道（DT-02）。表现为「评论发了、无评审、无报错」。
- **Trigger Mode 必须保持 Manual Only**：仓库侧已设 Manual Only（用户 2026-09-19 配置）。若被改回每次 push 自动评审，无限循环回归——列为发布前置且在 `AGENTS.md` 标注为配置异常。
- **Autofix 必须持续 Off（🔴）**：仓库侧现为 Off；一旦开启，Bugbot 会自动改码并推送，越过本仓库人工验收与推送授权边界。列为常驻约束，任何会话不得为图省事开启。
- **PR Summaries 现为 On（🟡 建议关）**：Bugbot 会生成/改写 PR 描述，而本仓库 PR 描述是收口证据（含 merge commit 回填、载荷标题定值），不得被外部工具覆盖。回报建议用户关闭；Controller/收口侧不得依赖 Bugbot 生成的描述。
- **Review Draft PRs = Off（🟡 待冒烟）**：与「Draft 转 Ready 后才跑 Round 1」一致，但 Manual 触发在 Draft 上能否生效未确认——Agent 须先转 Ready 再申请；若 Draft 上发了无反应，按配置事实处理，不当静默失败反复重试。
- **Effort = Smart（🟡 成本不可预估）**：智能路由使单次评审用量不可预估。回报给出「按 PR 规模固定档位」选项供用户选择，本会话不自行改。
- **在途 PR 状态连续**：不改 `STATE_MARKER`，旧状态评论仍可解析；轮次不被重置。
- **Incremental Review = On**：第 2/3 轮天然只看上次评审之后的新改动，部分补回逐轮提示词的丢失；正因如此**不再在提示词/规则里重复要求"只看新改动"**，避免两套口径。
- **命名空间未裁定**：本卡按不改名实现；若产品改 `/pr-review`，属后续 V2，需同步 `AGENTS.md`/workflow `if:`/测试并在途 PR 旧命令失效需公告。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 时间 |
|---|---|---|---|---|
| 换用评审引擎 | Cursor Bugbot | Codex 停用；产品选定 | 产品 | 2026-09-19 |
| 治理语义是否随之调整 | 不变 | 入口/轮次/额度是 Controller 职责，与评审引擎无关 | 本会话（依任务书） | 2026-09-19 |
| 轮次差异化提示词的去向 | 移入 `.cursor/BUGBOT.md` + 状态评论留痕 | Bugbot 不吃单次提示词，唯一可执行落点是常驻规则 | 本会话（依任务书） | 2026-09-19 |
| 命令命名空间 `/codex-review` | **暂不改名**（呈递 DT-01） | 改名影响在途 PR 与 Agent 习惯，须产品拍板 | 待产品 | — |
| 触发通道（评论 vs API） | **暂用评论**（呈递 DT-02） | 任务书范围＝换触发词；API 通道更稳但改动大 | 待产品 | — |

## 13. 功能切片关系

单切片：引擎重指 + 常驻规则 + 治理节 + 测试。可独立 UAT（本地跑测试 + 审阅文案）；真实生效 UAT 依赖用户完成 Cursor 配置与冒烟。

## 14. 前置依赖说明

```text
前置依赖：无
```
产品已选定引擎，无代码/文档前置。运行生效依赖工具外的 Cursor 集成配置（记为验收前置，不阻塞本卡施工）。

## 15. 验收条件

- [ ] 见卡面验收标准 6 条。
- [ ] 触发评论首行 `@cursor review`、测试 11 项全绿、`node --check` 通过。
- [ ] 用户完成：仓库连 Cursor 并启用 Bugbot（已做）、Trigger Mode 保持 Manual Only（已做）、配 `PR_REVIEW_TRIGGER_TOKEN` 后，在**已转 Ready 的**开放 PR 上冒烟；并建议关闭 PR Summaries、确认 Autofix 仍为 Off。

## 16. UAT 场景

### UAT-01 轮次治理不变
- 步骤：在测试内以 `initialState()` 走 `nextDecision` 4 次 → 第 4 次 `EXHAUSTED`；同 HEAD 重复 → `DUPLICATE_HEAD`；`extend` 未耗尽 → 拒绝、耗尽 → +1。
- 预期：与切换前逐项一致（既有 4 条测试守护）。

### UAT-02 触发词与留痕
- 步骤：`buildReviewPrompt(1,3)` / `(3,3)` / `(4,4,'x')`。
- 预期：首行 `@cursor review`、无 `@codex`；仍含「完整/最终收敛审查/人工追加原因」审计字。

### UAT-03 非 PR 不触发（补的缺口）
- 步骤：`runController({issue:{number:1},comment:{body:'/codex-review next'}})`。
- 预期：`{handled:false,reason:'NOT_PR'}`，不发任何评论/网络。

### UAT-04 真实冒烟（须用户，工具外）
- 前置：Secret `PR_REVIEW_TRIGGER_TOKEN` 配好、PR 已转 Ready。步骤：先手动发 `@cursor review verbose=true`（看 Bugbot 加载了哪些 `.cursor/BUGBOT.md` 规则、有无响应），无反应再试不带 `@` 的 `cursor review`；确认后走 `/codex-review next` 验轮次链路。预期：Bugbot 起评审。
- 分支处置：`@cursor review` 无效但 `cursor review` 有效 → 只改常量 `TRIGGER_COMMAND`；两者在 Ready PR 上均无反应 → 命中身份/席位过滤，按 DT-02 转 API 通道；Draft 上无反应属预期（须先转 Ready），不计为缺陷。

## 17. 风险

- **身份静默失败（高）**：见 §11 首条。缓解：独立触发身份 + 前置核对条 + 冒烟 UAT-04；回报明说退路。
- **误把常驻规则当提示词（中）**：若 `.cursor/BUGBOT.md` 未随代码入库或路径/文件名不符，Bugbot 无口径。缓解：文件已建并 `git check-ignore` 确认可跟踪。
- **无限自动评审回归（中）**：靠仓库 `manualTriggerOnly`，属配置非代码；已写入 `AGENTS.md` 前置条与回报。
- **成本（低-中）**：usage-based，`dryRun` 亦计费；轮次额度即成本闸门，保持不变。

## 18. 已知限制

- 本卡为 TMP 草稿、未进 registry（原因见卡面注记）。
- 命令命名空间、触发通道（评论/API）两项产品选择未裁，本卡按默认实现并各立 DT。
- Cursor 文档未确认 bot 身份能否触发、也未确认 Bugbot 读 `AGENTS.md`；结论以真实冒烟为准，不当已确认事实。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-19 | 初版基线：引擎重指到 Cursor Bugbot，治理语义不变，评审口径移入常驻规则，两项产品选择呈递 | 待人工确认 |
