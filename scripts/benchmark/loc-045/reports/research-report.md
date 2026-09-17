# LOC-045 工作流复杂度基准研究报告

**实验状态**：`PREPARED`（仅实验准备；夹具/配置/占位记录就绪，无真实模型执行）

生成时间：2026-09-16T16:56:54.366Z

## 验收条件映射

- **AC-01**：结构就绪 — 12 项夹具与验收判据已就绪；3×重复原始记录为 NOT_EXECUTED 占位，未执行真实模型
- **AC-02**：待真实执行 — 候选对照需真实执行后比较质量/证据/调用/耗时/人工/费用
- **AC-03**：结构就绪 — 建议框架已生成；真实结论待样本完成后复核
- **AC-04**：结构就绪 — 实验配置隔离于 scripts/benchmark/loc-045/；生产 templates/ 未被覆盖

## 候选建议（框架）

- {"task_id":"B01","decision":"INSUFFICIENT_EVIDENCE","reason":"缺少完整三次可比重复（真实样本未执行或未完成）"}
- {"task_id":"B02","decision":"INSUFFICIENT_EVIDENCE","reason":"缺少完整三次可比重复（真实样本未执行或未完成）"}
- {"task_id":"B03","decision":"INSUFFICIENT_EVIDENCE","reason":"缺少完整三次可比重复（真实样本未执行或未完成）"}
- {"arm":"c1","label":"C1 机械资格检查（建设 B01–B03）","applicable_tasks":["B01","B02","B03"],"uncovered":["O01","O02","O03","D01","D02","D03","X01","X02","X03"],"savings_summary":{"applicable":false,"rate":null,"reason":"baseline_calls_zero"},"decision":"PENDING_REAL_EXECUTION","note":"仅实验准备：无真实模型样本，不得宣称收益"}
- {"task_id":"X02","decision":"INSUFFICIENT_EVIDENCE","reason":"缺少完整三次可比重复（真实样本未执行或未完成）"}
- {"arm":"c2","label":"C2 定向补充（探索 X02）","applicable_tasks":["X02"],"uncovered":["B01","B02","B03","O01","O02","O03","D01","D02","D03","X01","X03"],"savings_summary":{"applicable":false,"rate":null,"reason":"baseline_calls_zero"},"decision":"PENDING_REAL_EXECUTION","note":"仅实验准备：无真实模型样本，不得宣称收益"}

## 复跑命令

`node scripts/benchmark/loc-045/bin/loc-045-freeze.mjs`
`node scripts/benchmark/loc-045/bin/loc-045-prepare.mjs`
`node scripts/benchmark/loc-045/bin/loc-045-report.mjs`

---

*本报告不将降低关口或降低质量当作收益；无真实模型样本时不得宣称调用节省。*
