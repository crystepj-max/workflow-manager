# FIX-228 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-228` |
| 远端 issue | github#228 |
| 需求来源 | CI 长期红排查（簇 3 根因） |
| 来源定位 | CHORE-112 排查的第三簇；根因由 `a29de3b`（WR-007 / LOC-034）引入 |
| 任务名称 | Proof 依赖回退分支写死假摘要致整批记录丢失，宿主回填依赖被误判 INCOMPLETE |
| 任务类型 | 缺陷修复（编号类型 FIX） |
| 当前状态 | 定义中（本轮修复已实施，待验收） |
| 需求基线版本 | V1 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 不允许 |
| 任务规格位置 | 未建独立规格：修复判据即 LOC-026 / LOC-034 既有契约与本票所列用例 |
| GitHub 同步 | synced#228 |

> 边界声明：本票是**维护 Current 基线**（修复已进入 main 的实现缺陷），不是实现 Target 目标规格。

## 问题（两处独立缺陷，同一函数）

都在 `packages/dsh-visual-workflow/src/host.js` 的 `resolvedInputsFor()` 段末回退分支：

**D1 · 写死假摘要。** 回填项带 `version_ref: 'tmp-exec:1:00000000'`。`tmp-exec:<seq>:<digest8>` 本身是 LOC-024 设计内的临时执行引用格式（见 `scripts/generate.mjs` 的 `versionRefOf`），但宿主把摘要**写成了常量**。`scripts/revision-dependencies.mjs:94-97` 要按摘要在 Store 里钉 Revision，永远钉不住 → `:109` 抛「无法钉住版本引用」；而 `scripts/records-host.mjs:181` 的整批 commit 在一个锁内顺序处理 entries，**一处抛错整批作废**——连本可正常落库的 `node_result` 一起丢。

后果面：`records-runtime` W3 落盘 0 条（期望 4）、LOC-026 W10/W11 读不到 Proof（`null.code`）、集成闸门 W1/W8 走不通。

**D2 · 回填依赖被当成未声明。** 该分支明明构建了真实依赖项，却仍返回 `mode: 'legacy'`。`revision-dependencies.mjs:243` 对 `type === 'proof'` 只要 `mode === 'legacy'` 就判 `INCOMPLETE` → `workspace-isolation.mjs:600` 永久 `incomplete_dependencies` → **闸门一律不放行**。

🔴 这不只是测试问题：`templates/wf-diagnose.json` 的 `review`/`regression` 是签发 Proof 的节点（`verifyBranch: true`）但**从未声明 `inputs`**，必然落进这条回退分支 → 该模板真机的集成闸门永远过不去、Proof 永远不被承认。（`wf-construction-full-feature` 的 `review`/`test` 已声明 inputs，故不受影响。）

## 处置（人工裁定：方案 i + C）

1. **删掉写死的 `version_ref`**，回填项只留 `producer`。`records-host.mjs:188-199` 按 entries 顺序在同一批内落库，上游 `node_result` 先于 `proof`，因此 `resolveProducerRef:104` 能把依赖钉到上游的**正式 Record Revision**，无需在宿主里再复制一份 `digest8`。
2. **新增输入模式取值 `host_bound`**（宿主段末回填，非节点声明），并在 `revision-dependencies.mjs` 的 proof 判定里写明其规则：有正式依赖即覆盖、无依赖仍不覆盖。选它而不是把回填项标成 `declared`——那等于声称"节点声明过输入"而实际没有，`revision-dependencies.mjs:260` 专门防的就是这个组合。
3. **给 `wf-diagnose` 的 `review`/`regression` 补 `inputs` 声明**（照 `wf-construction` 的写法绑定 `diagnose`/`fix`/`review` 已有字段与产物文件，每条带 `default` 以免首轮或新段直接失败），让真模板走正式路径，回退只留给历史蓝图。
4. **更新 `node-input-handoff` 的 LOC-024 断言**：它原先把 `wf-diagnose` 的声明集硬钉在 `['diagnose','fix']`，等于把缺陷固化成期望——这正是缺陷能藏住的直接原因。改为新事实，并补一条不变量：**任何 `verifyBranch` 节点必须声明 `inputs`**。

词表影响面已核实：真正判定 `mode` 取值的只有 `scripts/revision-dependencies.mjs`（4 处）；`formal-records.mjs:439` 与 `docs/design/formal-records/schema.json` 的 `input_mode` 都是自由文本，无枚举需同步。`dependency_source` 未扩词表：`host_bound` + 有依赖时它取 `resolved_inputs`，属实（依赖项确实在 `resolved_inputs.items` 里）。

## 实测结果

| 检查（均在隔离 worktree、串行） | 基线 `origin/main` `67f5c75` | 本票修复后 |
|---|---|---|
| `tests/*.test.mjs tests/*.smoke.mjs`（dsh-visual-workflow 全量） | 5 失败（`W1/W3/W8/W10/W11`，另有 `EB8` 负载抖动） | **384/384 全绿** |
| `scripts/test/*.test.mjs`（引擎层） | 8 失败（属 CHORE-112 范围，本分支未含）+ 1 因本票 C 暴露的 LOC-024 断言 | **769/777**，剩余 8 项恰为 CHORE-112 范围，无新增失败 |
| 蓝图校验与生成指南漂移 | — | wf-diagnose 结构合法（5 节点 / 18 边），`npm run generate` 后漂移检查通过 |

## 已知残留（不在本票内修）

- 🟡 `tests/helpers/fake-services.mjs:104-110` 只取 `{stdout, exitCode}`，丢弃宿主子进程 stderr → CI 永远只显示 `exit 1`。本次难查的直接原因。
- 🟡 `records-runtime` W3 与 W12 的逐节点记录断言此前靠空数组 `every` **假绿**；D1 修好后才开始真正生效，后续收紧时注意这点。
- 🟡 `records-host.mjs:181` 单条依赖解析失败即毁掉整段记录，缺"降级但如实标注"的中间态。
- 🟡 M5 用例依赖真实挂钟、高负载下假超时（登记在 CHORE-112）。

## 关联

- 前序：CHORE-112（同一次 CI 长期红排查的第一批）
- 证据与复现：`specs/FIX-228-proof-dependency-backfill/definition-check.md`
- 契约出处：LOC-024（显式交接输入）、LOC-026（Proof 绑定真实候选）、LOC-034（依赖与证明失效）
