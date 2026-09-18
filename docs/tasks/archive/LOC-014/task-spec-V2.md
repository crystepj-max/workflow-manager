# 内置模板模型覆盖（Model Override）

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V2 |
| 对应 Issue | 无（本地轨道；GitHub 同步 pending，恢复后补建 issue 回填） |
| 优先级 | P2 |
| 前置依赖 | 无（V1 的 LOC-010 已取消，原门槛不适用） |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-13T13:20:00+08:00 |
| 当前状态 | 本地已定义 |

## 1. 需求背景

四套正式内置模板的 `bindings.models` 固定了 Provider/Model 组合（如 construction-full-feature 的 preflight/dev/uat/closeout → deepseek-official + deepseek-v4-flash，review/test → openai-codex + gpt-5.6-luna）。产品规格 §6 定义了 `Built-in Workflow + User Override → Effective Workflow → Run Snapshot` 链路：内置结构只读，但 Provider/Model 应允许用户持久化覆盖。运行中修订（#79 `model_overrides`）已落地，本卡补齐"持久化覆盖默认值"这最后一环（#82 收尾项）。

## 2. 用户问题

内置模板好用，但默认模型不合我意——我想保存自己偏好的 Provider/Model 作为该模板的默认，又不想为了改模型整份另存自定义（整份拷贝在内置模板升级后会 stale，且违背"内置结构只读"的语义）。

## 3. 目标

交付后用户获得：在内置模板结构保持只读的前提下，可按节点（或 `$default` 兜底）保存 Provider/Model 覆盖并随时清除恢复默认；模板库与 `wf_run` 所见即所跑；每次新 Run 的 Snapshot Rev 1 冻结覆盖后的有效绑定。

## 4. 非目标

- 结构编辑（节点/边/Role/Goal/Schema/Outcome Routing/Human Decision/回退规则/拓扑）——仍走"另存为自定义"；
- 运行中切换 Provider/Model——#79 `model_overrides` 快照修订已实现，不在本卡；
- 完整 UI/交互打磨——归 LOC-016，本卡只做最小可用入口；
- 静默 Backup Provider / Failover——规格 §6 明确 v0.1 不做。

## 5. 修改前

`findWorkflow`（host.js L327）查找顺序 = 用户目录整份覆盖（userDir）→ removed → 内置生成物；内置模板 save/delete 只读（L1464/L1482）；`model_overrides` 仅在续跑时作为运行中修订生效（L2586），无任何持久化"默认模型覆盖"机制；模板库对内置模板只展示内置绑定。

## 6. 修改后

`findWorkflow` 与 `workflowEntries` 对内置 id 合成模型覆盖层：模板库列表/详情显示覆盖后的有效绑定（编辑器加"已覆盖"最小标记）；`wf_run` 新启 Run 按有效工作流执行，Snapshot Rev 1 冻结有效绑定；模板库提供最小覆盖入口（改节点/默认 Provider/Model、保存、清除恢复默认）。

## 7. 功能范围

1. 覆盖层存储：`<dshHome>/visual-workflow/model-overrides/<templateId>.json`，一模板一文件，格式 `{ "<nodeId>" | "$default": { "provider": ..., "model": ... } }`（键语义与 #79 `model_overrides` 对齐）；
2. 合成：`findWorkflow` + `workflowEntries` 对内置 id 输出有效 DSL（深拷贝内置 DSL，仅替换 `bindings.models` 对应键）；
3. 最小 UI 覆盖入口（模板库内）：按节点或 `$default` 编辑 Provider/Model、保存写入覆盖层、清除（删文件）恢复默认；
4. 容错与优先级处理（见 §9/§11）；
5. 插件包测试 + 根目录 `npm test`、`npm run validate` 全绿。

## 8. 不修改范围

- `templates/*.json` 内置真源与 `.generated/` 生成物（只读不变）；
- userDir 整份覆盖（"另存自定义"）既有语义与 save/delete 只读规则（L1464/L1482）；
- #79 `model_overrides` 运行中修订路径与 `appendSnapshotRevision`；
- LOC-016 的完整覆盖交互打磨（本卡 UI 允许后续重做）。

## 9. 业务规则

- 内置结构只读不变；覆盖仅作用于 `bindings.models` 的 provider/model 两个值；
- 键语义与 #79 对齐：节点 id 精确覆盖优先，`"$default"` 兜底未显式覆盖的节点，两者都没有 → 保持内置值；
- 合成单点：有效 DSL 由单一合成函数产出（findWorkflow 与 workflowEntries 复用），禁止两处独立实现导致语义漂移；
- 同 id 已存在 userDir 整份覆盖时，整份优先，模型覆盖层对该 id 忽略（列表可标注提示，最小实现允许只在测试中覆盖该分支）；
- 覆盖文件损坏或非法 JSON → 忽略该文件并留痕（log），不阻断模板加载；
- 覆盖中引用不存在节点 id 的键 → 合成时忽略该键；
- Provider/Model 值不做枚举校验——由运行前探针（#74）兜底，失败走既有 BLOCKED → `model_overrides` → Rev N 恢复链；
- 覆盖只影响新启动 Run 的 Snapshot Rev 1；已存在 Run 不受影响，运行中修订仍走 #79；
- 清除 = 删除对应覆盖文件，即恢复内置默认绑定；
- 覆盖机制四套内置模板（construction-full-feature / optimize / diagnose / explore）共用。

## 10. 用户操作路径

模板库 → 选内置模板 → 覆盖入口 → 修改某节点（或默认）的 Provider/Model → 保存 → 列表/详情显示覆盖后绑定（含"已覆盖"标记）→ `wf_run` 发起运行，探针与各节点按覆盖后模型执行 → 快照记录（`vwf.logicalRuns.get`）Rev 1 与所见一致；清除入口 → 恢复内置默认绑定。

## 11. 异常和边界场景

- 覆盖文件坏 JSON/非法结构：忽略并留痕，模板库与运行不受阻；
- 覆盖键指向不存在节点：合成时忽略该键；
- 同 id userDir 整份覆盖并存：整份优先，覆盖层忽略；
- 探针失败（模型不可用）：走 #74/#79 既有 BLOCKED 恢复链，不因覆盖引入新失败形态；
- 四套内置模板逐一验证覆盖可保存/清除/生效。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| D1 覆盖层持久化位置 | A：专用目录 `<dshHome>/visual-workflow/model-overrides/<id>.json` | 与现有 homeDirs 结构一致；覆盖与整份自定义拷贝彻底分离；内置升级不污染覆盖 | 松哥 | 2026-09-13T13:20+08:00 |
| D2 合成时机与可见性 | A：findWorkflow + workflowEntries 统一合成，所见即所跑 | 模板库/wf_run 一致，验收 1/3 条直接可测；完整交互归 LOC-016 | 松哥 | 2026-09-13T13:20+08:00 |
| D3-1 键格式 | 与 #79 `model_overrides` 对齐（节点 id + `$default` 兜底） | 同一套语义两处复用，心智负担最小 | 松哥 | 2026-09-13T13:20+08:00 |
| D3-2 与 userDir 整份覆盖并存 | 整份优先，模型覆盖层忽略 | 整份拷贝已是用户自定义资产，叠覆盖语义不清 | 松哥 | 2026-09-13T13:20+08:00 |
| 前置依赖改判 | LOC-010 → 无 | LOC-010 已取消（2026-09-12 口径），"建设正式化定稿"门槛不适用；四模板共用照做 | 松哥 | 2026-09-13T13:20+08:00 |
| 无人值守许可 | 允许 | 产品决策已全部落定，无施工中待选事项（V1 即允许，维持） | 松哥 | 2026-09-11（V1 落卡） |

未决产品事项：0。

## 13. 功能切片关系

- 本切片：内置模板模型覆盖（持久化覆盖默认值），单切片交付；
- 兄弟切片：无（完整覆盖 UI 打磨归 LOC-016，属另一任务，不构成本卡切片）；
- 拆分原则：规模可控、路径清晰、单会话可完成，不拆分。

## 14. 前置依赖说明

```text
前置依赖：无
```

（V1 记录的 LOC-010 已取消，经用户确认改判为无，见 §12。）

## 15. 验收条件

- [ ] 保存模型覆盖后 `wf_run` 按有效工作流执行（探针/节点均用覆盖后绑定），内置蓝图文件与 `.generated/` 产物不变
- [ ] 覆盖可清除并恢复默认绑定（删除覆盖文件后列表与运行回到内置值）
- [ ] 运行创建的 Snapshot Rev 1 冻结的是覆盖后的有效绑定（与 `vwf.logicalRuns.get` 快照记录一致）
- [ ] 模板库列表/详情对内置模板显示覆盖后绑定；存在 userDir 整份覆盖时整份优先且覆盖层忽略
- [ ] 坏覆盖文件不阻断模板加载与运行（忽略并留痕）
- [ ] 插件包测试 + 根目录 `npm test`、`npm run validate` 全绿

## 16. UAT 场景

### UAT-01 保存覆盖并运行生效

- 验收目的：覆盖持久化 + 合成生效 + 内置真源不变；
- 前置条件：DSH 已加载 vwf 插件；四套内置模板可见；
- 操作步骤：
  1. 模板库选 construction-full-feature → 覆盖入口 → 将 `review` 节点 Provider/Model 改为另一可用组合并保存；
  2. 核对模板库列表/详情显示覆盖后绑定；
  3. `wf_run` 以该模板发起一次最小运行（可至探针通过即停）；
  4. 检查 `templates/construction-full-feature.json` 与 `.generated/` 产物 git 状态。
- 预期结果：
  1. 覆盖文件出现在 `model-overrides/`，内容键格式正确；
  2. 列表/详情为覆盖后绑定；3. 探针/节点使用覆盖后模型；
  4. 内置真源与产物零改动。
- 建议人工关注：覆盖后绑定与 `vwf.logicalRuns.get` Rev 1 记录一致（对应 UAT-03）。

### UAT-02 清除恢复默认

- 验收目的：清除语义 = 删文件恢复内置默认；
- 前置条件：UAT-01 已保存覆盖；
- 操作步骤：模板库 → 清除覆盖 → 重查列表与覆盖文件目录。
- 预期结果：`model-overrides/construction-full-feature.json` 已删除；绑定回到内置默认。
- 建议人工关注：清除后无需重启即生效。

### UAT-03 快照一致性

- 验收目的：Rev 1 冻结有效绑定；
- 前置条件：UAT-01 的运行已完成创建；
- 操作步骤：取该运行 logical_run_id，查 `vwf.logicalRuns.get` / `logical-runs/<id>.json` 的 Rev 1 bindings。
- 预期结果：Rev 1 与覆盖后有效绑定一致，非内置原始值。
- 建议人工关注：后续 `model_overrides` 运行中修订（Rev N）不受影响。

### UAT-04 容错与优先级

- 验收目的：坏文件容错 + userDir 整份优先；
- 前置条件：可写 DSH Home；
- 操作步骤：
  1. 手工写入非法 JSON 到 `model-overrides/<id>.json` → 模板库/运行不受阻；
  2. 用某内置 id 在 userDir 存一份整份覆盖 → 保存该 id 模型覆盖 → 查看列表。
- 预期结果：1 正常加载（坏文件忽略留痕）；2 列表显示 userDir 整份内容，覆盖层未叠加。
- 建议人工关注：log 留痕可见。

## 17. 风险

- 合成点两处（findWorkflow/workflowEntries）不一致 → 以单一合成函数复用消解，测试覆盖两入口；
- 覆盖键格式与 #79 `model_overrides` 漂移 → 共享同一常量/文档注释锚定；
- 最小 UI 与 LOC-016 完整交互的边界 → 本卡 UI 按"允许重做"实现，不追求复用。

## 18. 已知限制

- 编辑器"已覆盖"标记为最小实现（完整交互归 LOC-016）；
- Provider/Model 无枚举校验，错误值由运行前探针兜底（BLOCKED 恢复链）；
- 覆盖层无版本历史/审计记录（如需再立任务）。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-11 | 初版基线（开发计划表 v2 落卡，三要素即基线，依赖 LOC-010） | 松哥 |
| V2 | 2026-09-13 | 需求分析会话细化：依赖改判无（LOC-010 取消）；落定 D1/D2/D3 四项决策；补全业务规则/边界/UAT/风险 | 松哥 |
