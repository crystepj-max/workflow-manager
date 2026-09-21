# LOC-045 工作流复杂度基准实验

与 `docs/tasks/specs/LOC-045-workflow-complexity-benchmark/benchmark-plan-V1.md` 配套的**隔离**实验配置与夹具。不修改生产 `templates/` 或 `dsh/roles/`。

## 状态语义

| 状态 | 含义 |
|---|---|
| `PREPARED` | 夹具、冻结摘要、占位 trial 记录就绪；**无真实模型执行**，不得宣称收益 |
| `PARTIAL` | 部分真实样本或等待人工 |
| `COMPLETE_RESEARCH` | 满足规格的真实执行与证据要求 |

## 冻结基线的不可变性

`config/freeze-manifest.json` 连同 `results/prepared/`、`reports/` 是 LOC-045 的**基线快照**，冻结于清单中 `frozen_at` / `repo_head` 所示时点。

- 它们**不随 `templates/` 演进回填**：冻结之后发生的模板变更不会反映到这里——这是「冻结」的应有语义，不是缺陷。
- 要开始新一轮实验，请**显式重新冻结**（`node scripts/benchmark/loc-045/bin/loc-045-freeze.mjs`）；需保留旧基线时先另存副本。
- **自动化测试不得改写**这些文件：测试路径须把输出指向临时目录（见 `scripts/test/loc-045-benchmark.test.mjs`，经 `configRoot` / `resultsDir` / `reportsDir` 注入）。

## 命令（仓库根目录）

```bash
node scripts/benchmark/loc-045/bin/loc-045-freeze.mjs
node scripts/benchmark/loc-045/bin/loc-045-prepare.mjs
node scripts/benchmark/loc-045/bin/loc-045-plan.mjs
node scripts/benchmark/loc-045/bin/loc-045-verify-fixtures.mjs
node scripts/benchmark/loc-045/bin/loc-045-report.mjs
```

## 实验规模

- 基准（A）：12 任务 × 3 次 = 36 逻辑运行
- C1（建设机械 preflight）：B01–B03 × 3 = 9
- C2（X02 定向补充）：1 × 3 = 3
- 上限合计 48 逻辑运行

## 目录

- `tasks/` — 12 项固定夹具与 `verify.mjs` 验收核对
- `config/` — 实验与冻结配置
- `lib/` — 冻结、记录、度量、报告库
- `results/prepared/` — NOT_EXECUTED 占位记录（真实实验前）
- `reports/` — 研究报告（JSON + Markdown）

真实模型实验须在 DSH 隔离环境与已批准 token 额度下执行；本目录仅提供可复跑准备与记录格式。
