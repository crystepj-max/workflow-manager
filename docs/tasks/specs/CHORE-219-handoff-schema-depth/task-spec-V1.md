# 本地任务规格 V1 · handoff 交接包 schema 深度加固：版本号格式与内容文本下限

| 元数据 | 值 |
|---|---|
| 任务标识 | `CHORE-219`（待发号，见 §18） |
| 需求基线版本 | V1 |
| 对应 Issue | 待建（拟挂 GitHub，引用 #123） |
| 需求来源 | GitHub #123 余项（2026-09-19 独立开工会话盘点复核） |
| 优先级 | P2 |
| 体量 | M |
| 分类 | enhancement |
| 前置依赖 | 无 |
| 施工环境组 | 本任务标识（独立） |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-19 |
| 当前状态 | 待确认 |

## 1. 需求背景

#123 是 #103 / PR #115 收口时按「范围外加固类建议另建 issue」登记的遗留票（契约变更史 v0.1.8 行可查）。它登记的两项里，第一项「九项校验机器化」已随 PR #132 交付；**第二项「schema 深度加固余项」就是本票**。

交接包记录是建设流程的证据底物。当前 schema 只约束「有没有这个字段」和「是不是非空白串」，不约束「像不像一个版本号」「有没有说出内容」。后果是空壳证据可以顺利落盘，要到人工复核或引擎校验时才暴露，而引擎校验本身仍是人工触发。

## 2. 用户问题

一份 `rationale: 'r'`、`baseline_revision: 'latest'` 的记录，机器全部判为合法；要回答「这条基线冻结的是第几版」「这个 gap 的建议到底说了什么」，事后无从判断。

## 3. 目标

交付后，`cwf-record write` 与 `cwf-record check` 在落盘/校验阶段就拒掉「版本号不成版本、内容字段是空壳」的记录，且这类拒绝有测试固定住。

## 4. 非目标

- 不改 `acceptance_package.assembled` 的必填引用结构（CHORE-110 题域，见 §17 协调）。
- 不做跨字段/跨记录时间序（JSON Schema 无法表达，转片 2 引擎侧）。
- 不改九项校验引擎的判定逻辑与条目语义。
- 不追溯改写已归档记录；不为了让旧记录通过而放宽约束。

## 5. 修改前

| 项 | 实测现状 |
|---|---|
| `baseline_revision` | `handoff.schema.json:201` 裸 `{type:"string"}`，无 pattern；归档实际取值 `V1`/`V2`/`V3`，示例取值 `v1` |
| 内容字段 | 21 个裸 `string`（`gaps.element/suggestion`、`clarification_decisions.topic/decision`、`design.summary`、`decision.question/rationale`、`dev.summary/notes/changes[].area/.description/self_check[].check`、`findings[].finding`、`test.environment`、`integration_checkpoint.notes`、`integration.checkpoint`） |
| `minLength` | 全 schema 计数 **0**；`format` 计数 **0**；`pattern` 仅 2 处（`nonEmptyText` 的 `\S`、`isoDateTime` 的 ISO 串） |
| 校验器能力 | `scripts/cwf-validate.mjs` 支持 `minLength`/`pattern`（L63-76），**不支持 `format`** → 约束必须写成 pattern/minLength 才会生效 |
| 版本戳 | `record_version` 是 `const: "v0.1.8"`；`cwf-record.mjs:88` 从该 const 取值盖新记录 |

## 6. 修改后

- `baseline_revision` 只接受版本号形态；`latest`、`1`、`V1.0-beta` 被拒；`V1`、`v1`、`V1.2` 通过。
- 内容性文本字段有下限：正文类 ≥8 字符，要素/标题类 ≥4 字符。单字符占位被拒。
- `record_version` 升 `v0.1.9`，7 份示例的 `record_version` 同步前移，HEAD 绑定不前移（契约 §8.4 明文：patch 级修订不前移示例链 HEAD）。
- 契约 §8.3 相应条目补一句约束口径，变更史新增 v0.1.9 行。

## 7. 功能范围

1. `definitions` 新增两个受约束定义（版本号、正文下限），不复用 `nonEmptyText`——后者服务标识/绑定字段（`run_id`、`produced_by`、`verified_head`），加下限会误伤。
2. `baseline_revision` 换用版本号定义。
3. 内容字段按正文/要素两档挂下限。
4. `record_version` const 与 7 份示例前移。
5. 契约 §8.3 + 变更史。
6. 现有 3 个测试文件的单字符占位夹具改为可用长度。
7. 每条新约束一个「修复前先红」负例。

## 8. 不修改范围

`nonEmptyText`、`isoDateTime`、`portableRunIdentity` 的既有语义；任何 enum/const 字段；七类记录的字段增删；引擎脚本；runbook 流程。

## 9. 业务规则

- R-1 下限按 JS `.length` 计（与校验器一致），中文一字计 1。
- R-2 要素类下限取 **4**：归档实测最短真实 `clarification_decisions.topic` 为「文件布局」（恰 4 字），取 5 会否掉真实记录。
- R-3 版本号 pattern 必须同时容纳 `V1`（归档形态）与 `v1`（示例形态），大小写不敏感。
- R-4 约束只作用在**新写入与新校验**；`cmdArchive` 已把 schema 随 run 冻结归档，历史 run 用自己的冻结副本校验，升 `record_version` 不影响归档记录可校验性。

## 10. 用户操作路径

Controller 写 `requirements_baseline` → `cwf-record` 校验 → 若 `baseline_revision:"latest"` 立即打印失败行并非 0 退出 → 修正为 `V3` 后重写通过。人工侧无需额外动作。

## 11. 异常和边界场景

- E-1 恰好等于下限：4 字 topic 通过，3 字被拒（边界用须有测试）。
- E-2 `gaps` 为空数组时不受影响（confirmed 态本就 `maxItems:0`）。
- E-3 `acceptance_mapping.acceptance_item` 与基线 `acceptance` 条目在引擎⑧里做**全等比较**，两处下限必须一致，否则出现「基线合法、映射被拒」的假故障。
- E-4 直接改磁盘 JSON 绕过 `cwf-record`：仍被 `cwf-record check` 与引擎拒绝（本票不新增防护，说明既有链路即可）。
- E-5 其他会话并发编辑 `handoff.schema.json`（CHORE-110）：见 §17。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| 加固强度 | 轻下限：正文≥8 / 要素≥4；`^V?\d+(\.\d+)*$` | 真实记录零误伤、只打测试夹具；严下限会牵动历史样本与示例链重写 | 松哥 | 2026-09-19 |
| 时间序是否进本票 | 不进（转片 2 引擎） | schema 与本仓校验器无法表达跨字段比较 | 松哥（认可拆片结论） | 2026-09-19 |
| 与 CHORE-110 先后 | 本票先改，两侧规格写死字段归属 | 110 的 DT-01 仍未决、未开工，等待会阻塞本票 | 松哥 | 2026-09-19 |
| 发号路线 | 在 GitHub 建 issue 拿正式号 | 2026-09-19 已定「GitHub 为主源、CNB 为灾备」 | 松哥 | 2026-09-19 |

## 13. 功能切片关系

- 本切片（片 1）：纯 schema + 示例 + 夹具 + 契约文本，可独立 UAT。
- 兄弟切片：片 2 呈递保护与引擎断言（`cwf-record.mjs`/引擎，不动 schema）；片 3 写时整链自动校验（依赖片 1+2）。
- 拆分原则：最小可独立 UAT 的完整功能切片。片 1 与片 2 代码面不重叠，仅测试文件可能同文件不同段。

## 14. 前置依赖说明

```text
前置依赖：无
```

## 15. 验收条件

- [ ] V-1 负例先行：`baseline_revision` 取 `latest`、`1`、`V1.0-beta` 各一条，加固前用例通过（红）、加固后被拒（绿）。
- [ ] V-2 负例先行：`decision.rationale:'r'`、`gaps.element:'e'`、`dev.summary:'s'` 加固后被拒。
- [ ] V-3 正例：`V1`/`v1`/`V1.2` 与真实长度文本全部通过。
- [ ] V-4 边界：4 字符 topic 通过、3 字符被拒。
- [ ] V-5 契约 §8.4 的 ajv-cli 命令对 7 份示例全绿。
- [ ] V-6 `npm test` 与 `node --test scripts/test/cwf-*.test.mjs scripts/test/schema-protocol.test.mjs` 全绿。
- [ ] V-7 `record_version` 已升 v0.1.9，示例链 HEAD 绑定未被前移。
- [ ] V-8 契约 §8.3 与变更史同步；不动 `nonEmptyText` 语义（有断言固定）。
- [ ] V-9 与 CHORE-110 的字段归属清单在两侧规格互相可见。

## 16. UAT 场景

### UAT-01 空壳记录被挡在落盘之前

- 验收目的：证明加固真的作用到写入路径，不只是改了一份 JSON 文件。
- 前置条件：一个可写的 run 目录（`.scratch` 隔离 worktree 内 `cwf-run-init`）。
- 操作步骤：① 用 `baseline_revision:"latest"` 的 payload 执行 `cwf-record write`；② 换成 `"V1"` 再执行；③ 用单字符 `rationale` 写 design_package；④ 换真实文本再写。
- 预期结果：①③ 非 0 退出并打印可定位的失败字段；②④ 通过并落盘；①③ 不产生记录文件、不更新 `index.json`。
- 建议人工关注：报错信息是否让人一眼知道该改哪个字段。

### UAT-02 真实记录与示例链不误伤

- 操作步骤：① 对 7 份示例跑 ajv-cli；② 跑本仓 `cwf-validate`；③ 抽一条归档真实 `requirements_baseline` 用当前 schema `check`。
- 预期结果：全绿；示例 `record_version` 为 v0.1.9 而 HEAD 绑定仍为原钉扎值。

## 17. 风险

- 🔴 **同文件并发**：CHORE-110 与本票同改 `handoff.schema.json`。缓解：本票只动 `definitions` + `baseline_revision` + 内容字段；110 只动 `acceptancePackagePayload.assembled`（L590-607）。两侧规格互写归属，后合入方 rebase；开工前重新读取该文件确认行段未被他方前移。
- 🟡 下限过窄会挡住未来的简短合法写法（如 `notes:"无"`）。缓解：以归档实测最短值为下限锚点（R-2），并在规格留下调通道。
- 🟡 `record_version` 前移会让任何「用当前 schema 显式校验旧记录」的入口报版本不符。已知入口：`docs/runbooks/acceptance-construction-epic.md:55-56`。缓解：该 runbook 改用 run 侧冻结副本，或本票同步更新其字面路径。
- 🟡 夹具改动量被低估的风险：3 个测试文件里至少 20 处单字符占位。

## 18. 已知限制

- 任务标识仍是草稿临时号：登记册里同日已有他方 `260919a/b/c` 草稿且本会话不代写 `registry.json`/`BOARD.md`（并发写风险）；GitHub 建 issue 在当前权限模式被分类器拦截，正式号待授权后补。
- 本仓校验器不支持 `format`，所以版本号只能用 pattern 近似，无法表达 semver 语义比较。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-19 | 初版基线（含 4 项人工裁定） | 待松哥确认 |
