# Formal Records / Revision / Provenance

> 状态：#78 实现契约  
> 权威实现：`scripts/formal-records.mjs`  
> Schema：`docs/design/formal-records/schema.json`  
> 产品语义：`workflow-manager-v0.1-final-product-spec.md` §2.7 / §7；原则 R3–R5

本文件定义跨四套正式工作流的 **Formal Record** 内核。框架只承载 record / revision / dependency / provenance，**不硬编码** Requirement、Review 等业务名。建设工作流 Portable 七类交接包（`docs/design/construction-workflow-portable-contract.md` §8）是本模型的兼容前身；本内核落地后，Revision / 依赖链 / 证明失效以本契约为权威，七类记录经 `mapPortableHandoff` 映射，不丢历史。

本票不实现 Logical Run / Snapshot Runtime（#79）、Human Decision 挂起（#72）、多格式 Artifact（#69）、模板消费（#82）或 Bootstrap shim 退役（#105）。

## 1. 三类语义（kind）

| kind | 对应原则中的分类 | 例子（业务名不属于内核） |
|---|---|---|
| `input_baseline` | 输入 / 基准 | 需求基线、评价契约、诊断结论、Guidance 输入 |
| `result` | 成果 | 方案、实现交接、综合分析、修复产物 |
| `proof_decision` | 证明 / 决策 | 审核、测试、评估、Human Decision、人工验收 |

## 2. 记录形状

每条记录在诞生时冻结，之后只可读。同一 `record_id` 的新内容产生新的 `record_revision`（从 1 起的正整数），旧 Revision 内容不变。

```text
record_id + record_revision
kind
body.media_type ∈ { application/json, text/markdown, text/plain }
body.value            ← 不透明载体；覆盖判定不得读取
dependencies[]        ← { record_id, record_revision }；覆盖判定的唯一依据
based_on?             ← 主前驱，若出现则必须是 dependencies 中的一项
provenance            ← 诞生时拷贝，含 snapshot_revision / provider / model /
                        node / attempt / node_business_outcome 等
created_at
```

`based_on` 是主前驱标注；**机器失效与覆盖判定只读 `dependencies`。** 禁止把 Markdown / 自由文本解析成依赖。

Node Business Outcome 与 Formal Record 分离：Outcome 留在 Node Result 上；写入 Record 时只把当时的 Outcome **拷贝**进 `provenance.node_business_outcome`。Runtime 控制状态（含 `WAITING_HUMAN + MAX_ROUNDS_REACHED`）不得回写已形成的 Outcome 或 Record。

## 3. 覆盖判定

给定 Proof `P` 与目标 `record_id`（其当前 Revision 为 `T`）：

| 结果 | 条件 |
|---|---|
| `covering` | `P.dependencies` 含 `{ record_id, record_revision: T }` |
| `not_covering_current` | `P.dependencies` 含同一 `record_id` 但 Revision ≠ `T`（旧 Proof 保留，标记 stale） |
| `unrelated` | `P.dependencies` 不含该 `record_id` |

只认**直接**依赖，不走传递闭包，避免 Fan-out 兄弟被机械失效。

`dependsOnStaleInputs(record)`：任一项依赖的当前 Revision 已前进，则该记录的输入集合不再覆盖当前世界（用于 Synthesis / Evaluation 等成果，不只是 Proof）。

典型链：`R1 → D1 → I1 → RV1 → T1`。产生 `I2` 后，RV1/T1 仍是 I1 的历史证明，对 I2 为 `not_covering_current`。

Fan-out：专家 A1、B1 保留；仅依赖 `{A1,B1}` 的 Synthesis / Evaluation 在 A→A2 后 `dependsOnStaleInputs=true`；未依赖 A 的兄弟不失效。

## 4. Node Result

Node Result 可以产生 **0..n** 条 Formal Record（验收要求「可产生一个或多个」，能力存在即可）。每条 Record 拷贝同一份诞生时 Outcome。节点业务 Output Schema 继续活在 Node Result / `body.value` 里，不迁入信封。

## 5. Decision 与 Guidance

- **Decision Record**：`kind=proof_decision`，`body.value.decision` 含 question / options / chosen / rationale / decided_by / decided_at。追加式；不得改写已存在 Revision。
- **Guidance**：`kind=input_baseline` 的输入记录，依赖当时 Baseline。`changes_baseline=false` 时不产生新 Baseline Revision；`true` 时必须同时追加新的 Baseline Revision，且新 Baseline 的 `dependencies` 含旧 Baseline 与该 Guidance。

## 6. Portable 映射

`portable:{run_id}:{record_type}` 作为稳定 `record_id`。同 Run 再次映射同一 `record_type`（含 draft→confirmed 刷新）追加新 Revision，并把上一 Revision 列入 `dependencies`。

| Portable `record_type` | kind | 直接前驱 |
|---|---|---|
| `requirements_baseline` | `input_baseline` | （无；刷新时含自身上一 Revision） |
| `design_package` | `result` | `requirements_baseline` |
| `dev_handoff` | `result` | `design_package` |
| `review_proof` | `proof_decision` | `dev_handoff` |
| `test_proof` | `proof_decision` | `dev_handoff` |
| `acceptance_package` | `proof_decision` | 上述五类 |
| `closeout_summary` | `result` | `acceptance_package` |

映射后 `provenance.portable` 保留源 `record_type` / `record_version` / `run_id` / `attempt` / `created_at`，历史 Dogfood Run 可追溯。不删除 construction-bootstrap shim。

## 7. 模块边界

| 路径 | 职责 |
|---|---|
| `scripts/formal-records.mjs` | 追加式 Store、覆盖判定、Node Result 展开、Decision/Guidance 助手、Portable 映射、schema 校验 |
| `scripts/test/formal-records.test.mjs` | #78 验收的可执行证据 |
| 本文件 + schema.json | 对外契约（供 #69 / #79 / #82 消费） |

不接入 `scripts/generate.mjs`、`packages/dsh-visual-workflow`、建设 Portable Contract 正文。Store 默认内存；Runtime 落盘归 #79。
