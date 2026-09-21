# 节点隔离探测在真实 macOS 恒判 unavailable（参考配置无法运行 canary），独立 Proof 全线拒签

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | #235 |
| 优先级 | P1 |
| 前置依赖 | 无（UAT 全链场景以 FIX-233 落地为 UAT 前置条件，非任务依赖） |
| 无人值守许可 | 允许（实现 + 单测；UAT-01 真机验证属 #213 发布链场景） |
| 定义时间 | 2026-09-20T15:34:01Z |
| 当前状态 | 已定义（人工确认基线 V1，2026-09-20） |
| 分类 / 体量 | bug ｜ sized-s |

## 1. 需求背景

2026-09-20 产品模式跑 `wf-explore`（Run `explore-74-probe-text`），全链路 `节点隔离保证等级 = unavailable`，`canIssueIndependentProof`（`scripts/node-isolation.mjs:236`）据此拒发全部正式独立 Proof，5 份专家报告、综合分析与评估裁决均标注「非独立取证」。LOC-041 / WR-018 的节点隔离机制在真机上未实际生效。该结果直接牵动 #213（若发布验收要求独立 Proof 则全线卡住）。

**根因（本会话在故障机上实证，修正票面「原因未定」）**：探测 `probeIsolationCapability`（`scripts/node-isolation.mjs:167`）的参考配置在当前 macOS（darwin 25.5.0 实测）上**无法运行自己的 canary 进程**，属「探测代码判定条件不成立」，**不是**系统限制 sandbox-exec：

1. 参考配置用 `(deny default)`，而当前 macOS 任何进程启动需读 dyld 闭包（`/usr/lib`、`/private/var/db/dyld` 等），全部被 deny → 区内 `/bin/echo` SIGABRT(134)，`insideAllowed` 恒 false → 恒判 `unavailable`。该参考配置在真机上从未通过；CI 仅覆盖 `forced` 注入模式（`scripts/test/node-isolation.test.mjs:168`），真实 darwin 路径从不执行，故一直未暴露。
2. 附带缺陷一：区外判定用 `/usr/bin/touch`，但 profile 只放行 `/bin/echo` 的 exec——`touch` 死在 exec 而非 file-write，拿到的是「exec 拒绝」证据，**测的不是写入拒绝**。
3. 附带缺陷二：profile 直接拼接 `process.cwd()` 字符串，未 realpath。seatbelt 按**解析后路径**匹配（`/tmp` → `/private/tmp`），软链 cwd 下会误判。
4. sandbox-exec 本身可用且能真拒区外写入：以写入范围收紧型 profile 在本机实测三项判定全绿（见 §7），`enforced` **可达**——票面待判定 3「接受降级口径还是换实现」因此消解，无需产品拍板。

**界面可见性核实（票面待判定 2）**：`client.js` 对隔离等级/非独立取证零渲染；拒签原因仅结构化落盘于运行记录（`independent_proof_block_reason`，`host.js:2737`）与 Run 产物文本（STATE.md 等）。用户已拍板：本票只修探测，界面展示登记 backlog。

## 2. 用户问题

一句话：隔离机制在真机上是「永远不可用」的摆设，所有结论被迫降级为非独立取证，而机器其实有能力做到 enforced。

## 3. 目标

`probeIsolationCapability` 在真实 macOS 上输出可信的 `enforced`（边界被真实验证的三项证据），独立 Proof 恢复可签发；`unavailable` 只在真异常时出现，且原因结构化留痕。

## 4. 非目标

- 不做界面展示（隔离等级 badge / 「非独立取证」警示）——已拍板登记 backlog。
- 不做降级口径或换隔离实现（待判定 3 已消解）。
- 不改 LOC-041 执行面逻辑（`prepareNodeContext` / `enforceWrite` / `classifyPath` / `canIssueIndependentProof` 等一律不动）。
- 不改非 macOS 平台行为（非 darwin → unavailable 不变）。
- 不在 CI 增加真实 darwin 探测（UAT 承担）。

## 5. 修改前

真机探测恒 unavailable：区内 canary 起不来（SIGABRT）、区外证据测错目标；Proof 全线拒签；界面无任何可见性；CI 测试只测 forced 模式。

## 6. 修改后

本机实测探测输出 `enforced`（三证据齐全）；具备 `independent_proof` 能力的节点（review / test）Proof 可签发；探测失败时 `unavailable` + 结构化 reason；其余行为不变。

## 7. 功能范围

- 重写 `probeIsolationCapability` 的参考 profile 为**写入范围收紧型**（本机已实证等价形态三项全过）：
  ```text
  (version 1)
  (allow default)
  (deny file-write* (require-not (subpath "<realpath(inside)>")))
  ```
- 判定证据改为三项：区内进程可跑（`/bin/echo`）、区内写入成功（`touch` 区内）、区外写入被拒（`touch` 区外，exec 放行、拒绝来自 file-write 本身）。
- 探测目录先 `realpath` 再嵌入 profile（防软链误判）。
- 语义保持：三项全过 → `enforced`；任一失败 → `unavailable` + 结构化 reason；`force_guarantee` 测试注入不变。
- 测试：既有 forced 用例保持；新增 profile 构造逻辑单测（结构断言：allow default、require-not、realpath 嵌入）。

## 8. 不修改范围

- `.generated/`、模板、编辑器 UI、`host.js` 探测缓存机制（`isolationProbePromise`，重启产品 DSH 后自然生效）、`node-isolation-host.mjs` 包装层协议、探针之外的 LOC-041 逻辑、两套历史模板。

## 9. 业务规则

- `enforced` 判定必须基于「边界被真实验证」的证据：区外拒绝必须来自 file-write 本身，不得以 exec 拒绝冒充。
- 拒签语义不变：非 `enforced` → 不签发正式独立 Proof。
- 探测失败必须结构化留痕（`evidence.reason`），不得静默。
- 写入范围收紧型 profile 是运行时执行适配的参考形态：只承诺「拒绝工作区外写入」，不承诺全锁死（`(deny default)` 路线在当前 macOS 不可行，已实证）。

## 10. 用户操作路径

主路径：产品 DSH 重启后（探测缓存刷新），发起含 review / test 节点的工作流 → 运行记录中隔离等级 = enforced → 正式独立 Proof 正常签发，报告不再带「非独立取证」。

## 11. 异常和边界场景

- CI / Linux：非 darwin → `unavailable`（既有分支，不变）。
- 未来 macOS 移除 `sandbox-exec`：`which` 失败 → `unavailable`（既有分支，不变）。
- darwin 下区内进程、区内写入、区外拒绝任一项失败：`unavailable` + reason，不得硬撑 enforced。
- 软链 cwd（如 /tmp 下）：realpath 兜底。
- `force_guarantee`：测试注入语义不变。
- 探测缓存：host 进程内缓存（`isolationProbePromise`）——修复落地后须完整重启产品 DSH 才生效（AGENTS.md 发布流程内动作）。
- 探测通过 ≠ 运行期防护启用：本票只修「能力判定」；节点执行是否套用 sandbox-exec 属 LOC-041 执行面，不在本票。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| 票面待判定 2（降级更显眼） | A · 只修探测；界面展示登记独立 backlog | 修复后 unavailable 成真异常；拒签原因已结构化落盘；不把本票扩张进 client bundle | crystepj-max | 2026-09-20 |
| 票面待判定 3（降级口径 vs 换实现） | 消解：无需产品拍板 | 本机实证 `enforced` 可达（写入范围收紧型 profile 三判定全绿） | 取证结论（ZCode） | 2026-09-20 |
| 修复取向 | 写入范围收紧型 profile（allow default + deny file-write* require-not） | 唯一经实证可行的方向；同时修正证据口径（写入拒绝而非 exec 拒绝） | Agent（实证驱动，无产品分歧） | 2026-09-20 |
| 无人值守许可 | 允许（实现 + 单测） | 验收可机器判定；真机 UAT 属发布链场景 | Agent（默认值，随基线呈递） | 2026-09-20 |

未决产品事项：0。

## 13. 功能切片关系

单切片任务（体量 S：路径已实证、影响面单一、单会话可完成）。

## 14. 前置依赖说明

```text
前置依赖：无
```

（UAT-01 的全链场景以 FIX-233 落地为 UAT 前置条件：#233 不修则 templateId 起跑走不到 Proof 环节。）

## 15. 验收条件

- [ ] AC-01 新参考 profile 构造逻辑单测通过（结构断言：`(allow default)`、`(deny file-write* (require-not (subpath <realpath>)))`、区内/区外路径均 realpath 嵌入）。
- [ ] AC-02 语义回归：非 darwin → unavailable；`force_guarantee` 两向注入行为不变；既有 `node-isolation.test.mjs` 全绿。
- [ ] AC-03 本机真实探测输出 `enforced`，evidence 含三项齐全（inside process / inside write / outside write denied）——UAT-01 承担，不进 CI。
- [ ] AC-04 Proof 链路恢复：`enforced` 下具备 `independent_proof` 能力的节点判定 ok；`canIssueIndependentProof` 既有语义用例保持通过。
- [ ] AC-05 `npm run validate` 与 `npm test` 全绿，无新增失败项。
- [ ] AC-06 UAT-01：产品 DSH 完整重启后，新 Run 隔离等级 = enforced，正式独立 Proof 签发。

## 16. UAT 场景

### UAT-01 真机 enforced 与 Proof 恢复

- 验收目的：确认真实产品 DSH 上探测输出 enforced 且 Proof 恢复签发。
- 前置条件：
  1. FIX-233 已落地（templateId 起跑可用）；
  2. 按 AGENTS.md 完整重启产品 DSH（3080）——探测缓存须刷新。
- 操作步骤：
  1. 单独触发探测（`node scripts/node-isolation-host.mjs probe`）核对 `enforced` 与三项 evidence；
  2. 跑一次 `wf_run --templateId wf-explore`（或含 review/test 节点的任一内置模板）走完 Proof 环节。
- 预期结果：
  1. 探测 = enforced，三项证据齐全；
  2. 新 Run 隔离等级 = enforced，正式独立 Proof 签发，报告不再标注「非独立取证」。
- 建议人工关注：若未来 macOS 升级后再遇 unavailable，evidence.reason 应能直接指出断在哪一项。

## 17. 风险

- macOS 未来再收紧 seatbelt（如移除 sandbox-exec）：探测将回到 unavailable 且如实留痕，届时降级口径议题重新打开——本票不预设结论。
- `require-not` 属 seatbelt 稳定过滤语法，但 macOS 大版本升级后应重跑 UAT-01 复核（登记为发布链例行项即可）。
- 探测结果有进程内缓存：验证时忘记重启产品 DSH 会出现「修了但依旧 unavailable」的假象（AGENTS.md 流程已覆盖，UAT 前置条件已显式列出）。

## 18. 已知限制

- 界面不展示隔离等级/非独立取证（backlog，用户已拍板）。
- 探测在 host 进程生命周期内只查一次并缓存，不周期重探。
- 探测通过只代表「sandbox-exec 具备拒绝区外写入的能力」，不等于节点执行已实际套用沙箱（LOC-041 执行面）。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-20 | 初版基线（故障机实证根因 + 三判定修复方案 + 待判定 2/3 处置）；人工确认 2026-09-20 | crystepj-max |
