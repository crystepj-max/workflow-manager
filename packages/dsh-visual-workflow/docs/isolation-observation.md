# 隔离等级观测（WFM-81 / #283）

隔离等级取自宿主已有 `probeIsolationGuarantee`，不根据节点输出、界面状态或当前机器环境倒推历史运行。独立 Proof 资格取自已有 `canIssueProof`，沿用 `canIssueIndependentProof` 的判定。

| 位置 | 字段与含义 |
| --- | --- |
| `logical-runs`、`vwf.logicalRuns.get` | `isolation_guarantee`：`enforced` / `unavailable` / `unknown`；`isolation_probe` 保存 `backend`、`evidence` 与 `recorded_at` |
| 逻辑运行的 `node_isolation` | 按节点保存等级、探针摘要、`independent_proof_eligible` 与 `independent_proof_block_reason`；资格查询不可得时为 `null`，不会推测为允许 |
| 逻辑运行的 `isolation_history` | 追加每次准备隔离路由时的观测；包含路由签发失败的准备，不表示引擎段已创建或节点已执行 |
| `runs`、`vwf.state` | 真实执行段保存该段使用的等级与探针摘要；恢复段重新取宿主已有探针结果 |
| `node_attempts` 与正式 attempt body | 仅在真实执行记录上保存当时节点的隔离观测，不用当前等级回填历史节点 |
| 正式 `node_result` / Proof 的 `provenance` | 保留宿主提交时的同一份节点观测；业务结果正文不变 |
| Proof body | 原有段末扫描字段保留；逐次提交路径补同一份观测，签发规则不变 |

`recorded_at` 是把宿主 Probe 结果记录到本次准备的时间。宿主原有 Probe 缓存仍然适用；该时间不宣称重新执行了一次操作系统探针。

`unavailable` 仍在隔离节点路由签发处阻断。此时逻辑运行保存失败和探针事实，`segments` 与 `node_attempts` 为空，`runs/` 不创建假引擎记录。`vwf.runs.list` 通过只读逻辑运行投影给出 `execution_not_started: true`，供看板和详情呈现“执行未启动”“隔离不可用 · 非独立取证”。该行的 `id` 为 `logical:<logical_run_id>`，`vwf.state` 不会把它当成真实引擎段。

旧记录缺字段时显示“隔离等级未知”，资格为未知。读取和重启回载不会批量改写旧文件，也不会用本机当前的 `enforced` 为历史记录背书。

## 验证入口

```bash
TMPDIR=/private/tmp node --test packages/dsh-visual-workflow/tests/isolation-observation-runtime.test.mjs
TMPDIR=/private/tmp node --test --test-name-pattern='WFM-81' packages/dsh-visual-workflow/tests/client.smoke.mjs
```

运行用例使用明确模拟的 Probe 与引擎边界，并驱动真实 Records Store；界面用例使用 jsdom。它们覆盖字段映射、失败事实、重启与旧记录兼容，不构成产品 DSH 的真实隔离、工作流 E2E 或人工验收证据。
