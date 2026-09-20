# TMP-chrisdem-260919e · 任务规格 V1

> 任务：construction-bootstrap 退役与引用改指 wf-construction-full-feature
> 来源：GitHub Issue #102 Slice 4「Formal Convergence」余项；开工指令 + 本会话两项人工裁定
> 施工分支 / Run：`dev-tmp-chrisdem-260919e-r1`（run_id `tmp-chrisdem-260919e-r1`，本地基线 `5dea84a`）
> **未决产品事项 = 0**（两项去向已由人工裁定落定，见 §12）

## 1. 需求背景

「建设 · 完整功能开发」在 v0.1 早期靠 `dsh/skills/construction-bootstrap/` 这份 **Bootstrap 执行 Profile** 跑起来：当时 #77/#72/#73/#78/#93/#79/#74/#81/#83 九项 Runtime 能力未落地，Profile 用 shim 顶上（见其 `shim-map.md`）。九项能力现已全部合入 main，正式内置模板 `wf-construction-full-feature` 与其生成 skill、`dsh/roles/*.md` 已承担同一职责。#102 Slice 4 的收敛要求因此剩最后一件事：**把已被取代的 Profile 正式退役，不留双事实源**。

## 2. 用户问题

产品经理侧的问题不是"少一个文件"，而是：**同一个交付入口存在两份权威叙述**——接手者无法判断该按 Bootstrap runbook 还是按正式模板走，Agent 也可能被同步脚本把旧 Profile 重新装回技能池。

## 3. 目标

退役 Bootstrap 执行 Profile 的仓库定义源，使所有现行引用指向正式模板与对应 skill；同时保证 runbook 里**仍然有效**的规则不因删除而丢失，且九项 shim 的收敛历史可追溯。

## 4. 非目标

- 不改建设蓝图的结构（节点、出边、额度、模型绑定）；
- 不改生成器或四套模板的触发词（见 §17 风险 R-2）；
- 不清理 `docs/tasks/**`、`docs/research/**`、`wayfinder/**` 里的历史提及；
- 不动 `docs/tasks/registry.json` 与 `docs/tasks/BOARD.md`（他人在途改动 + 发号源未定）；
- 不做推送、建 PR、合并、关闭 #102 等对外动作。

## 5. 修改前

- `dsh/skills/construction-bootstrap/{SKILL.md,runbook.md,shim-map.md}` 存在且从未被删除；
- runbook 是全仓唯一把 DSH 轨道命令按顺序串起来的文档；`$CWF_ASSETS` 只在其中定义，却被 `dsh/roles/closeout.md` 使用；
- 17 处现行文档/脚本引用该 Profile；
- `scripts/ai-task-deliver-m2-check.mjs` 断言该 skill 的 SKILL.md 与 runbook.md（经 `ai-task-deliver-m2.test.mjs` 进入 `npm test` / `npm run validate`）；
- `scripts/sync-ai-task-skill-set.mjs` 把该 skill 同步进 my-agent-skills，缺源即 `exit 1`。

## 6. 修改后

- Profile 目录与安装脚本删除；
- 新增 `docs/runbooks/construction-dsh/runbook.md`（DSH 轨道命令序列，与 `construction-external/` 对称）；
- 全部命令使用仓库内 `scripts/`，`$CWF_ASSETS` 不再是任何现行文档的依赖；
- 九项 shim 收敛记录写入 `construction-workflow-portable-contract.md` §9.6，文档头版本行 v0.1.8 → v0.1.9；
- 机械验收断言改指新 runbook；同步脚本不再携带该 Profile。

## 7. 功能范围

① 新建 DSH 轨道 runbook；② `$CWF_ASSETS` → `scripts/`；③ 契约 §9.6 回写 + 版本行；④ 现行引用改指；⑤ 两处脚本修脚；⑥ 删除目录与安装脚本；⑦ 立卡与规格。

## 8. 不修改范围

`templates/wf-construction-full-feature.json` 语义、`.generated/` 手改、历史任务记录、示例链 `produced_by` 历史值（契约 §8.4 钉扎规则）、插件侧代码。

## 9. 业务规则

1. **不静默删除规则**：删除前每一块现行有效规则必须能指出权威落点；指不出的必须呈递选项。
2. **不留双事实源**：语义权威只有一处（M2 文档 / 契约 / 约定文档），runbook 只写"怎么做"，引用不改写语义。
3. **历史不重写**：过往任务的记录与"该任务明确不做的项"清单保持原样，只追加当下事实与指针。
4. **对外动作另需授权**：推送 / PR / 合并 / 关闭 issue 不在本任务自主范围内。

## 10. 用户操作路径

产品经理侧无新增操作界面。接手者路径变为：`CONTEXT.md` / `docs/design/workflow-capability-index.md` → 建设入口 = 蓝图 `wf-construction-full-feature` + 生成 skill → 要跑一次交付，命令序列看 `docs/runbooks/construction-dsh/runbook.md`。

## 11. 异常和边界场景

| 场景 | 处置 |
|---|---|
| 干净检出（无 `.generated/`、无 `node_modules`） | `.generated/` 已 gitignore，需先 `npm run generate`；断言载体不得放在生成物里（否则 `npm test` 在干净检出处失败）——本任务把断言落在 `docs/` |
| 旧 Run 仍在 `.agent-runs/` | 其 `run.json` 记录与 `plugin_namespace` 不受影响；回收仍按 `cwf-env-recycle.mjs` 执行 |
| 有人照旧说「用建设工作流跑 issue」 | 触发词已不在（§17 R-2），需改用「完整功能开发」或直接点名模板；如实呈递，不静默 |
| 同步脚本被再次运行 | 不再携带 `construction-bootstrap`，不会把旧 Profile 装回技能池 |
| 契约示例链 `produced_by: "dsh:construction-bootstrap"` | 保留为历史示例值（契约 §8.4 钉扎），不视为断链 |

## 12. 已确认的关键决策及原因

| 决策 | 取值 | 确认人 / 时间 | 原因 |
|---|---|---|---|
| D-1 runbook 操作序列去处 | 新建 `docs/runbooks/construction-dsh/runbook.md` | 松哥（crystepj-max），2026-09-19 本会话 | 与既有 Codex/Cursor 版对称；落点现成；不把命令混进被机械断言的设计文档，也不动生成器 |
| D-2 `$CWF_ASSETS` 口径 | 统一改写为仓库内 `scripts/` | 松哥（crystepj-max），2026-09-19 本会话 | 安装态 assets 是 Bootstrap 分发机制的产物；为正式 skill 另建 assets 打包属功能开发，超出退役范围 |
| D-3 shim 收敛记录落点 | 契约 §9.6（并按 §9.3 追加版本历史行） | 沿用 shim-map 自身「退役纪律 1」+ 契约 §9.3 | 该 Profile 的退役纪律本就规定"先改契约版本历史，再删 shim" |
| D-4 立卡口径 | `TMP-chrisdem-260919e` 草稿号，不写 registry / BOARD | 沿用同检出当日既成做法（b/c/d 已被占）；CHORE-111 迁移仍「待确认」 | 发号规则未生效，且 registry 上有他人未提交改动，`allocate` 会覆盖其工作 |
| D-5 引用改指的归属原则（人工纠正后补） | **按引用内容的归属分别改指**：环境/工作区纪律 → 约定文档决策六；DSH 轨道命令序列 → `docs/runbooks/construction-dsh/runbook.md`；交付入口 → 正式模板与生成 skill。不得一律改指 `wf-construction-full-feature` | 松哥（crystepj-max），2026-09-19 本会话纠正 | 现存引用不是同一种东西：`dsh/roles/dev.md:54` 讲的是单实例 9527 / 命名空间前缀 / 单激活，属环境纪律，其权威是决策六（:95 取代 #185 每 Run 独占 Home、:73 GC 退役、:97/:148 为依据）；把环境规则挂到模板上会造成新的错位权威 |

## 13. 功能切片关系

单片。切片间顺序为取证 → 裁定 → 迁移/回写 → 改指 → 删除 → 校验；删除必须晚于"内容已有新家"。

## 14. 前置依赖说明

九项 Runtime issue（#77 #72 #73 #78 #93 #79 #74 #81 #83）均 `CLOSED / COMPLETED`，逐项 main 落地证据见契约 §9.6。#102 的 Slice 1–3 已随 formal convergence 完成，本切片是 Slice 4 的收口余项。

## 15. 验收条件

即任务卡 AC-01 ～ AC-07。全部为仓内可机械核对项，无「收口后观测」项（本任务不涉合并后行为）。

## 16. UAT 场景

| # | 场景 | 执行时机 | 步骤 | 期望 |
|---|---|---|---|---|
| U-1 | 定义源已消失 | 裁决前可观测 | `ls dsh/skills/` 与 `ls dsh/` | 无 `construction-bootstrap`、无 `install-construction-bootstrap.sh` |
| U-2 | 无现行断链 | 裁决前可观测 | 全仓 grep `construction-bootstrap` 并排除 `docs/tasks`/`docs/research`/`wayfinder` | 命中仅剩：契约 §9.6 与示例链历史值、退役说明文字、卡片与规格本身 |
| U-3 | 规则仍可找到 | 裁决前可观测 | 在新 runbook 查 9527 / 命名空间前缀 / 单激活 / 回收门禁 / 三态 / 裁决前重跑 | 六项逐条命中，且语义文档（M2 §6、契约 §8.3）未被 runbook 改写 |
| U-4 | 历史不丢 | 裁决前可观测 | 读契约 §9.6 九行 | 每行含 issue、原 shim、正式机制落点、main 证据 hash；hash 可 `git merge-base --is-ancestor` 核对 |
| U-5 | 机械闸门 | 裁决前可观测 | `node scripts/validate-guide-drift.mjs`；`node scripts/ai-task-deliver-m2-check.mjs`；`node --test scripts/test/ai-task-deliver-m2.test.mjs` | 全部通过 |
| U-6 | 无新增测试失败 | 裁决前可观测 | 同环境（无 `node_modules`/`dist`）下比较本分支与 base 提交的 `node --test scripts/test/*.test.mjs` 失败集 | 失败集相同（base 亦 22 项，属既有环境性失败，含 #191 与 M5 挂钟敏感簇） |
| U-7 | 复活路径已封 | 裁决前可观测 | `grep -n construction-bootstrap scripts/sync-ai-task-skill-set.mjs` | 仅剩注释性说明，无 pairs/资产清单条目 |

## 17. 风险

- **R-1（低）**：断言载体从 skill 改到 runbook，若将来 runbook 更名，M2 机械验收需同步——已在脚本注释里写明退役出处。
- **R-2（中，用户可感知）**：旧触发词（「建设工作流」「construction」「用建设工作流跑 issue」）不再有任何入口承接。改触发词要动蓝图 `description`，属已发布产物变更并牵动 `release:verify` 与产品验收，本任务未做，留人工决定。
- **R-3（低）**：安装态脱离本仓时无 `cwf-*.mjs` 兜底（D-2 的已知代价）。
- **R-4（低）**：契约升 v0.1.9 可能让人误读为语义变更——已在版本行与 §9.6 双处写明"不改语义、未触发冻结解除条件"。

## 18. 已知限制

- 正式号未发放：本卡为 TMP 草稿号，未进 registry / BOARD（D-4）。
- 本任务未完成 PR 与合并：分支 `dev-tmp-chrisdem-260919e-r1` 只到"待人工验收"，收口（合并、回写 #102、关闭 issue）须另行授权。
- 未做真机 DSH 验收：本任务是文档与入口收敛，不涉运行时行为；开发 DSH 单实例上另有激活任务 `loc-016-r1`，未抢占。

## 19. 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| V1 | 2026-09-19 | 初版：由开工指令 + D-1/D-2 两项人工裁定构成基线，随实施一并入库 |
