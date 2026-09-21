# 本地任务规格 V1 · 证据呈递完整性：成熟刷新呈递保护与引擎时间序/conditional_pass 断言

| 元数据 | 值 |
|---|---|
| 任务标识 | `FIX-220`（待发号，见 §18） |
| 需求基线版本 | V1 |
| 对应 Issue | 待建（拟挂 GitHub；来源含 #123 与 PR #125） |
| 需求来源 | PR #125 未修评审意见（呈递保护两条）＋ GitHub #123 余项中的时间序子项 |
| 优先级 | P1 |
| 体量 | M |
| 分类 | bug（既有保证存在可绕过路径） |
| 前置依赖 | 无 |
| 施工环境组 | 本任务标识（独立） |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-19 |
| 当前状态 | 待确认 |

## 1. 需求背景

契约的可审计性建立在一条前提上：**人工签收的对象，就是当初呈递给他的那份内容**（§3.6）。PR #125 交付 `cwf-record` 时按这条做了 acceptance_package 一层，另两层留作未修意见。#123 的时间序子项同属「呈递过的事实能不能被机器验证」，且因 JSON Schema 无法表达跨字段比较，只能落在引擎——一并归入本片。

## 2. 用户问题

同一次 attempt 内，把 design package 从「未决」刷成「已决」时可以顺带换掉呈递的问题与候选集；把基线从 `draft` 刷成 `confirmed` 时可以顺带改掉呈递过的目标/范围/验收标准。事后仅凭记录本身，看不出人工答的是不是眼前这份。

## 3. 目标

交付后，「刷新成熟态」这一动作无法改变已呈递内容（除非显式声明换版），并且时间序与 conditional_pass 的 feedback 由引擎在磁盘记录上复核——绕过写入工具也躲不掉。

## 4. 非目标

- 不改 schema 约束强度（片 1）。
- 不把九项校验搬进写入路径（片 3）。
- 不追溯校验已归档历史记录；不重写历史。
- 不改 acceptance_package 那半条已落地的保护逻辑。

## 5. 修改前

| 缺口 | 实测位置 | 现状 |
|---|---|---|
| design 门可换呈递 | `cwf-record.mjs:227-240` `isFinalized()`：`design_package` 仅当 `payload.decision !== undefined` 才算终结 | 同 attempt「无 decision → 带 decision」允许整份覆盖，含 `decision_request` |
| 呈递历史不进比较 | `cwf-evidence-verify.mjs:139-149` 引擎⑥ | 只校验 `chosen ∈ 该记录自带 decision_request.options`；`decision.question` 与 `decision_request.question` 的文本一致性全仓无一处校验 |
| baseline 冻结可改内容 | `isFinalized()` 对 `requirements_baseline` 仅在 `status==='confirmed'` 后禁止覆盖 | `draft → confirmed` 刷新不比对呈递过的 `goal/scope/acceptance` |
| 已完成的一半 | `cwf-record.mjs:139-146` + 用例 `:407`/`:427` | acceptance_package `awaiting→decided` 改写 `assembled` 已拒且已测——本票照此模式补齐，不重做 |
| 时间序 | 全仓检索 `cwf-record` / `cwf-evidence-verify` / `schema-protocol-core` / schema 跨字段比较 | **零实现**。schema 只有单字段 ISO pattern |
| conditional_pass | schema `acceptancePackagePayload` 条件分支已强制带 `feedback`；`cwf-validate.test.mjs:86` 只有**正例** | 引擎对 `ap.decision` 无分支（②无条件要求 approve+pass）；「缺 feedback 应被拒」的负例测试缺失 |

## 6. 修改后

- 同 attempt 把 design 刷成带 `decision`：若已存在旧记录，其 `decision_request` 必须原样保留（问题文本、候选集、推荐项逐项等值），否则拒写并指明差异字段。
- 同 attempt 把 baseline 刷成 `confirmed`：已存在旧 `draft` 记录时，`goal/scope/acceptance` 必须等值；确需变更须显式绑定旧 Revision（换新 `baseline_revision` 并前进 attempt），此时允许内容不同但必须可追溯到被替换的那一版。
- 引擎新增两条判定：⑩ 时间序（验收包 `decided_at ≥` 其所引用各记录的 `created_at`；design `decision.decided_at ≥ decision_request` 所在记录 `created_at`）；⑪ `decision=conditional_pass` 时磁盘记录必须带非空 `feedback`。
- 引擎⑥补一条：`decision.question` 与 `decision_request.question` 等值。

## 7. 功能范围

1. `cwf-record` 写路径两条呈递保护（复用 `deepEqual`，与已有 assembled 保护同一模式与同一拒绝风格）。
2. 引擎⑥扩一条文本等值断言。
3. 引擎新增⑩⑪两条判定，输出结构与前九项一致（`id/name/ok/detail`）。
4. 负例先行：每条各一个「加固前能通过、加固后被拒」的用例。
5. 契约 §5.3/§8.3 相应文字与变更史；runbook 无需改（引擎仍人工执行，接线是片 3）。

## 8. 不修改范围

九项既有判定的语义；schema 文件；`cwf-record` 其他子命令；attempt/额度/回退语义；归档与清理链路；acceptance_package 既有保护。

## 9. 业务规则

- R-1 保护只在**同 attempt 覆盖同一文件**时触发；跨 attempt（回退重跑、reverify）本就落新文件，不受约束。
- R-2 「显式绑定旧 Revision」的形态：`confirmed` 记录携带被替换版本的 `baseline_revision`，且该版本在同 run 目录内实际存在。仅声明不存在的版本视为拒写。
- R-3 时间序只比较**同一 run 链路内**可得的成对时间戳，不做绝对时钟可信性判断（不引入 NTP 假设）。
- R-4 时间序比较时区口径：全部为 `isoDateTime` pattern 约束下的 UTC `Z` 串，直接按字符串可比较；但实现须以解析后时间戳比较，避免 pattern 允许的可选小数位造成误判。
- R-5 ⑪的「非空」与片 1 的下限解耦：本票只断言存在且非空白，长度下限属片 1 题域。

## 10. 用户操作路径

① Controller 呈递 design 待决包给松哥 → 松哥答 A；② Controller 写 `package_ready` + `decision`，但顺手把 `decision_request.options` 改成 A/B' → 立即拒写，报「呈递候选集被替换」；③ 恢复原呈递内容后重写通过。

## 11. 异常和边界场景

- E-1 首条 design 记录就同时带 `decision_request` 与 `decision`（无历史可保护）→ 允许写入，由引擎⑥保证自洽。
- E-2 旧记录无 `decision_request`、新记录有 → 属于「补呈递」而非替换，须放行还是拒绝？裁定：**放行**（缺呈递记录本就是⑥要抓的，补上是改进；保护的是「不替换」，不是「不许补」）。
- E-3 `options` 顺序变化但集合相同 → 按 R-1 之外的口径：顺序影响呈递外观，判为替换、拒写。
- E-4 baseline `draft` 从未呈递（无 gaps、一次性 confirmed 写入）→ 无旧文件可比，放行。
- E-5 时钟回拨使 `decided_at < created_at` → ⑪判失败，detail 指明是哪一对；这是真实故障信号（记录来自不同机器或手工填时间）。
- E-6 引擎⑩遇到引用记录缺 `created_at`（理论被 schema 挡住，但磁盘手改可能缺）→ 判失败不得静默跳过。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| 两条呈递保护是否并入本会话 | 并入，独立成片 2 | 缺口经代码复核成立，且与片 1 代码面不重叠，可并行 | 松哥 | 2026-09-19 |
| 时间序落点 | 引擎新增判定，不进 schema | schema 与本仓校验器无跨字段比较能力 | 松哥（认可拆片结论） | 2026-09-19 |
| conditional_pass 处理深度 | 引擎补磁盘复核 + 补负例测试（schema 已有规则，不重做） | 复核实测发现规则已在，缺的是断言与测试，避免重复施工 | 松哥（认可复核结论） | 2026-09-19 |
| E-2「补呈递」放行 | 放行 | 保护语义是「不替换」，不是「不许补齐」 | 施工裁定（不改产品结果） | 2026-09-19 |

## 13. 功能切片关系

- 本切片（片 2）：写路径保护 + 引擎断言，可独立 UAT（用一条真实 run 目录做呈递替换攻击）。
- 兄弟切片：片 1 schema 加固（不重叠）；片 3 写时整链自动校验（依赖本片，因为要自动化的正是补齐后的引擎）。

## 14. 前置依赖说明

```text
前置依赖：无
```

与片 3 的关系由片 3 单向声明；本片可先于片 1、片 3 交付。

## 15. 验收条件

- [ ] V-1 红→绿：替换 `decision_request.options` 的成熟刷新，加固前测试通过、加固后被拒写。
- [ ] V-2 红→绿：改动已呈递 `goal/scope/acceptance` 的 `draft→confirmed`，加固后被拒；显式绑定旧 Revision 且该 Revision 存在时放行。
- [ ] V-3 E-2/E-4 两个应放行场景有正例，证明保护没有过头。
- [ ] V-4 引擎⑩：构造 `decided_at < created_at` 的验收包，⑩判 false 且 detail 指明比较对。
- [ ] V-5 引擎⑪：磁盘直写（绕过 `cwf-record`）的 `conditional_pass` 无 `feedback` → ⑪判 false；带 `feedback` → true。
- [ ] V-6 `cwf-validate.test.mjs` 补「conditional_pass 缺 feedback 被 schema 拒」的负例。
- [ ] V-7 引擎⑥新增 question 等值断言有正/负例各一。
- [ ] V-8 既有九项用例语义不变（原断言逐条保留）。
- [ ] V-9 `npm test` 全绿；契约 §5.3/§8.3 与变更史同步。

## 16. UAT 场景

### UAT-01 呈递替换攻击

- 验收目的：证明「人工答的那份」换不掉。
- 前置条件：隔离 worktree 内一个已写入 `design_package`（`awaiting_decision` 形态、带 `decision_request`）的 run。
- 操作步骤：① 复制呈递过的 payload，改 `options[0].name` 后加 `decision.chosen` 写入；② 改 `decision.question` 一句字重写；③ 原样重写并只加 `decision`。
- 预期结果：①② 拒写并指明被改字段；③ 通过；随后引擎⑥对③判 true。
- 建议人工关注：拒绝信息是否足以让人知道该回到哪份内容。

### UAT-02 时间序与条件通过复核

- 操作步骤：① 把验收包 `decided_at` 改成早于引用记录 `created_at`，跑 `cwf-evidence-verify`；② 删掉一条 `conditional_pass` 的 `feedback` 后直接落盘再跑引擎。
- 预期结果：①② 均 exit 1，新增判定的 detail 可读；其余九项不受影响。

## 17. 风险

- 🟡 保护过头会挡住正常纠错（E-2、E-4）。缓解：V-3 显式要求「应放行」的正例。
- 🟡 引擎从九项变十一项，任何按项数硬编码的消费方需同步。缓解：实施前全仓检索 `checks.length`/`九项` 字面量并一并更新文案。
- 🟡 时间序在跨机器时钟偏差下可能误报。缓解：R-3 限定为链内相对顺序，且在 detail 中打印两个时间戳便于人工判断。
- 🟡 与片 1 同改测试文件的冲突。缓解：本片只新增用例段落，不改夹具取值。

## 18. 已知限制

- 正式任务号待授权补建（GitHub）；本会话不写 `registry.json`/`BOARD.md`。
- 引擎仍为人工/脚本触发；本片不解决「忘记跑」的问题（片 3）。
- 时间序比较的是记录内时间戳，不能证明记录未被整体倒填（那需要外部可签发时间源，超出本片范围）。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-19 | 初版基线（含 3 项人工裁定 + 1 项施工裁定） | 待松哥确认 |
