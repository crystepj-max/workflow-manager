# Shim 边界与收敛映射（#105 Bootstrap → #82 正式 Built-in）

Bootstrap 期间，契约中依赖正式 Runtime 的能力一律以显式 shim 实现，**不得伪装已支持**（#105 Bootstrap 行为纪律）。本表是收敛路径的唯一索引。

| 契约能力 | 依赖 Runtime issue | Bootstrap shim（本 Profile 实现） | 收敛时退役方式 |
|---|---|---|---|
| Business Outcome Routing（§6） | #77 | runbook 解释专业结果基元（§6.3/§6.4），路由判断由 controller 会话执行；cwf-record 的 schema 校验守住记录形态 | #77 落地后，基元映射为正式 Outcome field path + route + countRound；runbook 路由小节删除，改为引用正式机制 |
| 受控人工决策（§5） | #72 | 会话挂起呈递 + 用户指令恢复；decision_request / decision 以 JSON 记录落盘 | #72 落地后由正式 WAITING_HUMAN + Decision Record 承接；记录字段直接映射（`decision_request`/`decision` 命名已对齐） |
| 自动回退额度（§4.2） | #73 | cwf-record `rollback` 子命令在 run.json 显式记账，超限拒绝并提示升级 | #73 落地后边级 countRound 声明取代脚本记账；run.json 的 rollback_used 映射历史 |
| Formal Records / Provenance（§8） | #78 | 七类 JSON 记录 + cwf-validate 机械校验 + .agent-runs 本地保留 | #78 落地后记录迁移为正式 Record Revision/依赖链；v0.1.x 记录可重放映射（不丢历史） |
| Workspace/Resource Isolation（§7.2） | #93 | cwf-run-init 建 worktree/branch 纪律；run.json workspace_id | #93 Runtime 落地后隔离强制移交 Runtime；workspace_id 映射正式 workspace 标识 |
| Logical Run / Snapshot（§7.1） | #79 | run.json 的 portable run identity 十字段 | run_id → logical_run_id；其余字段映射 Snapshot；历史 Run 可追溯 |
| Preflight 探针 | #74 | 无（runbook 前置条件人工核对） | #74 落地后接入正式 Preflight |
| 正式内置角色 | #81 | controller 会话 + 独立子会话充当 review/test 证明者 | #81 落地后绑定正式 Role |
| Skill/Chat 正式调用入口 | #83 | 本 skill 触发词（construction-bootstrap） | #83 落地后迁入正式 Invocation |

## 退役纪律

1. 每收敛一项，先改契约 §9.3 版本历史（映射声明），再删 shim；
2. 最终形态：本 skill 成为 #82「建设」正式 Built-in 的运行包装，不留 construction-bootstrap 与正式建设两份可见业务模板（#105 Formal Convergence）；
3. 收敛期历史 Dogfood Run 的 .agent-runs 记录全部可追溯（run_id → logical_run_id 映射）。
