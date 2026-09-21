# FIX-235｜节点隔离探测在真实 macOS 恒判 unavailable（参考配置无法运行 canary），独立 Proof 全线拒签

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | FIX-235（远端锚点：GitHub Issue #235） |
| 需求来源 | github-issue |
| 来源定位 | GitHub Issue #235 原始报告（2026-09-20，Run `explore-74-probe-text`） |
| 任务名称 | 节点隔离探测在真实 macOS 恒判 unavailable（参考配置无法运行 canary），独立 Proof 全线拒签 |
| 任务类型 | 完整功能开发 |
| 分类 | bug |
| 体量 | S |
| 优先级 | P1 |
| 当前状态 | 已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | FIX-235 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FIX-235-node-isolation-probe-fix/task-spec-V1.md` |
| 定义时间 | 2026-09-20T15:34:01Z |
| GitHub 同步 | synced#235 |

已登记进 `docs/tasks/registry.json`（`remote: GitHub #235`、`github_sync: #235`、`status: 已定义`），看板 `BOARD.md` 已重写。编号沿用 GitHub issue 号（FIX-<issue#>，同 FIX-225/226/233/234 先例），未走 CNB 发号。

## 摘要（三要素）

**目标：** `probeIsolationCapability` 在真实 macOS 上输出可信的 `enforced`（三项证据：区内进程可跑、区内写入成功、区外写入被真拒），独立 Proof 恢复可签发；`unavailable` 只在真异常时出现并结构化留痕。

**范围：** 做——参考 profile 重写为写入范围收紧型（`(allow default)` + `(deny file-write* (require-not (subpath <realpath>)))`，故障机已实证三判定全绿）；区外证据口径修正（写入拒绝，非 exec 拒绝）；探测目录 realpath；profile 构造单测。不做——界面展示（已拍板 backlog）、降级口径/换隔离实现（已消解）、LOC-041 执行面逻辑、非 macOS 分支行为、CI 增加真实 darwin 探测。

**验收标准：**

- [ ] AC-01：profile 构造单测（`(allow default)` / `(require-not ...)` / realpath 嵌入）。
- [ ] AC-02：语义回归——非 darwin → unavailable；`force_guarantee` 注入不变；既有隔离测试全绿。
- [ ] AC-03：本机真实探测 = enforced，evidence 三项齐全（UAT 承担，不进 CI）。
- [ ] AC-04：enforced 下 independent_proof 节点 Proof 判定 ok，`canIssueIndependentProof` 既有语义保持。
- [ ] AC-05：`npm run validate` 与 `npm test` 全绿。
- [ ] AC-06：UAT-01——产品 DSH 完整重启后新 Run 隔离等级 = enforced、正式 Proof 签发。

## 根因（故障机实证，2026-09-20）

**「探测代码判定条件不成立」，非系统限制 sandbox-exec：**

1. `(deny default)` 参考配置下，当前 macOS 任何进程启动需读 dyld 闭包（`/usr/lib`、`/private/var/db/dyld`）均被拒 → 区内 canary `/bin/echo` SIGABRT(134)、无输出 → `insideAllowed` 恒 false → 恒判 `unavailable`。交替对照 3×3 复测确认恒败（并纠正一处「加 /usr/lib 读权限可修复」的测量伪影——管道 head 吞了退出码）。
2. 附带缺陷①：区外判定用 `/usr/bin/touch` 但 profile 只放行 `/bin/echo` 的 exec——`touch` 死于 exec，拿到的是「exec 拒绝」而非「写入拒绝」证据。
3. 附带缺陷②：profile 直接拼 `process.cwd()` 字符串；seatbelt 按解析后路径匹配（`/tmp` → `/private/tmp` 实证），软链 cwd 会误判 → 必须 realpath。
4. `sandbox-exec` 本身可用且能真拒区外写入：写入范围收紧型 profile 本机实测三判定全绿 → **`enforced` 可达，票面待判定 3（降级口径 vs 换实现）消解**。
5. 测试盲区：`scripts/test/node-isolation.test.mjs:168` 仅覆盖 `forced` 注入，真实 darwin 路径 CI 从不执行——机制上线以来未被任何测试验证过。

**界面可见性（待判定 2）：** `client.js` 对隔离等级零渲染；结构化原因在运行记录（`independent_proof_block_reason`）与产物文本。用户拍板：本票只修探测，界面展示登记独立 backlog。

## 已拍板的产品口径

- ✅ 待判定 2 = **A · 只修探测**，界面展示登记 backlog。确认人 crystepj-max，2026-09-20。
- ✅ 待判定 3 = 消解（enforced 实证可达）。取证结论，2026-09-20。

## 关联

- UAT 全链以 FIX-233 落地为 UAT 前置条件（#233 不修则 templateId 起跑走不到 Proof 环节）。
- #213：若发布验收要求独立 Proof，本票是其可达成的前置。

## 详细规格

完整需求以本地任务规格为准（见上表「任务规格位置」，含 §11 边界场景、§15 验收条件、§16 UAT）。实质变更走 Vn→Vn+1 流程。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-20T15:21:33Z | 待确认 | 需求分析完成：故障机实证根因（`(deny default)` 无法运行 canary + 证据口径错位 + 软链陷阱）+ 修复方案实证（写入范围收紧型三判定全绿）+ 待判定 2/3 处置（用户拍板 A / 取证消解）；规格 V1 + Definition Check 落盘（未决产品事项 0）；issue 正文更新，打 `sized-s` |
| 2026-09-20T15:34:01Z | 已定义 | 用户确认基线 V1。登记册登记（`remote: GitHub #235`、`github_sync: #235`）、看板重写、issue 正文状态改「已定义」并写入定义时间、打 `ready-for-agent`、去 `needs-info`；随 FIX-234 定义产物一并入库提交并提 PR（经用户授权） |
| 2026-09-20T16:12:00Z | 已定义 | 门禁字段规范化（值均不变）：基线→纯 V1；无人值守许可→纯「允许」，原注释「实现 + 单测可无人值守；UAT-01 真机验证属 #213 发布链场景（随 V1 基线一并确认）」于本行留痕，范围界定不变；优先级→纯「P1」，原注释「随 V1 基线一并确认」由 definition-check.md 与本行留痕；前置依赖→纯「无」（UAT 前置说明由规格 §14 前置依赖说明承载），适配门禁机械判据 （夜间批次评估修复 fix-preflight-null-baseline-r1） |
