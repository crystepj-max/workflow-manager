# Definition Check · FIX-228 Proof 依赖回退分支（host_bound + wf-diagnose 声明 inputs）

## 检查元数据

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-228` |
| 远端 issue | github#228 |
| 检查对象 | 修 `resolvedInputsFor()` 回退分支的两处缺陷，并给 `wf-diagnose` 的 Proof 节点补 inputs 声明 |
| 检查时间 | 2026-09-19 |
| 人工裁定 | 语义方案在 (i) `host_bound` 新标记 / (ii) 放宽 legacy 规则 / (iv) 标成 `declared` 之间取 **(i) + 补蓝图声明** |

## 9.1 目标与范围

- [x] 目标：消除 VWF 包测试 5 个稳定失败，并修掉真机上「wf-diagnose 集成闸门永远过不去」的功能缺陷
- [x] 范围含：`host.js` 回退分支、`revision-dependencies.mjs` 的 proof 覆盖判定、`templates/wf-diagnose.json` 的 inputs 声明、锁死旧事实的 LOC-024 断言
- [x] 范围不含：CHORE-112 的两簇夹具修复、`fake-services.mjs` 吞 stderr、`records-host` 整批作废的降级设计、M5 挂钟依赖
- [x] 明确不改 `dependency_source` 词表，也不给 `input_mode` 加枚举约束（现契约为自由文本）

## 9.2 现状证据

- [x] 根因定到提交：`git log -S "function resolvedInputsFor"`、`-S canIssueCoveringProof`、`-S "function dependencyCoverageFor"` 均只命中 `a29de3b`（WR-007 / LOC-034，9/17）
- [x] D1 机制有行级证据：`host.js:2679` 常量摘要 → `revision-dependencies.mjs:94-97` 钉不住 → `:109` 抛错 → `records-host.mjs:181` 锁内顺序处理 entries，一处抛错整批作废
- [x] D2 机制有行级证据：`revision-dependencies.mjs:243` 对 `type==='proof'` 且 `mode==='legacy'` 直接判 `INCOMPLETE`，经 `workspace-isolation.mjs:600` 表现为永久 `incomplete_dependencies`
- [x] 真机影响已核实到模板：`wf-diagnose` 的 `review`/`regression` 带 `verifyBranch: true` 且 `inputs` 为空；`wf-construction` 的 `review`/`test` 已声明 → 只有前者受影响
- [x] `tmp-exec:<seq>:<digest8>` 是设计内格式：见 `scripts/generate.mjs` 的 `versionRefOf` 与 LOC-024 注释「正式 Record 接入后由实际 Revision 替代」，故缺陷性质是"写死常量"而非"用错格式"
- [x] 同批可钉正式 Revision 的前提已核实：`records-host.mjs:188-199` 按 entries 顺序落库，`nodeRecordEntries` 先 push 上游 `node_result` 再 push `proof`
- [x] 词表影响面已穷举：真正判定 `mode` 的只有 `revision-dependencies.mjs` 4 处；`formal-records.mjs:439` 与 `docs/design/formal-records/schema.json:91` 对 `input_mode` 均为自由文本
- [x] 有一条断言把缺陷固化成期望：`scripts/test/node-input-handoff.test.mjs` 原断言 `declaredIds(diagnoseBp) === ['diagnose','fix']`，补 inputs 后即失败——已按新事实更新并加不变量

## 9.3 验收标准

- [x] 包套件全量转绿（串行）：`node --test --test-concurrency=1 tests/*.test.mjs tests/*.smoke.mjs` → `pass 384 fail 0`，覆盖 `W1/W3/W8/W10/W11` 与抖动项 `EB8`
- [x] 引擎层无新增失败（串行）：`node --test --test-concurrency=1 scripts/test/*.test.mjs` → `769/777`，剩余 8 项逐条等于 CHORE-112 已登记的 `AC-02/03/04` + 5 个 M5 用例
- [x] `npm run generate` 后 `—— ① 蓝图校验` 与 `②′ 生成指南漂移` 均通过（新 inputs 未破坏蓝图合法性与 runbook 一致性）
- [x] 新不变量可复现：任何 `verifyBranch` 节点必须声明非空 `inputs`，违反即测试失败
- [x] 标准不含「Release Ready」类结论：真机产品 DSH 重启与工作流 E2E 不在本票自动验证范围内（见 9.6）

## 9.4 依赖与前置

- [x] 依赖 CHORE-112 之处仅为测试计数解释（本分支基线未含其修复），两票改的是不相交文件，合并顺序无约束
- [x] 施工前提：在隔离 worktree 内进行，且包测试前必须 `npm run build`（否则 `dist-fresh` 用例会误报）

## 9.5 风险与可逆性

- [x] 🔴 语义放宽风险已界定：`host_bound` 让"宿主回填的正式 Record 依赖"可构成覆盖 Proof。已把它限制在「有正式依赖」这一条件下，且空依赖仍判 `INCOMPLETE`；未采用标成 `declared` 的写法，避免 `revision-dependencies.mjs:260` 所防的组合
- [x] 🟡 蓝图变更风险：新增 `inputs` 会让输入解析在缺引用时报 `INPUT_RESOLUTION_FAILED`；每条绑定都带 `default`，与 `diagnose`/`fix` 既有的前向引用写法同构，首轮与续跑段均不会硬失败
- [x] 可逆：单提交可 `revert`；`.generated/` 为 gitignore 产物，回退后重跑 `npm run generate` 即复原
- [x] 爆炸半径外溢已检查：`mode`/`input_mode` 无枚举契约需同步，`dependency_source` 未改词表

## 9.6 无人值守许可

- [x] 判定「不允许」：本票改的是 LOC-026 / LOC-034 的**验收语义**（什么算可覆盖 Proof），并含推分支、开 PR 等对外动作，须人工确认
- [x] 额外人工关口如实保留：按仓库双轨规矩，Release Ready 还需 `npm run release:verify` + 关闭开发 DSH + 完整重启产品 DSH + 真机工作流 E2E；本票自动验证只覆盖机器层，**不声称已完成产品模式验收**

## 9.7 与既有契约一致性

- [x] 维护 Current 基线：修的是已进入 main 的缺陷，不引入 Target 目标规格能力，不用旧实现否定目标规格
- [x] 不与权威资料冲突：`workflow-design-principles.md` 与 v0.1 目标规格未被引用为本票改动依据，也未被改动
- [x] 尊重 `templates/` 作为"当前已实现 Workflow"唯一事实来源：inputs 写进蓝图本体并重新生成，未手改 `.generated/`
- [x] 保留 LOC-024 原语义：`legacy` 仍表示"蓝图未声明输入"，新语义另立 `host_bound`，未让一个词同时表达两件事

## 9.8 未决事项

| 项 | 值 |
|---|---|
| 未决产品事项 | 0 |

说明：9.5/9.6 与各「已知残留」条目是已判定的后续独立事项（范围、判据、后果均已写明），需要的是排期与人工验收，不是口径澄清。

## 结论

根因、机制、影响面与词表爆炸半径均有行级证据；语义方案由人工裁定为 `host_bound` + 补蓝图声明，并已按该裁定实施、串行复现验证通过。判定为**可交付待验收**，人工关口保留在产品模式真机 E2E 与 PR 合并。
