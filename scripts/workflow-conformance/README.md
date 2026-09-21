# LOC-042 四模板消费方契约与端到端验收

开发者用固定样板复跑四模板，定位生产—交接—存储—消费链路问题，并区分自动检查与真实验收。

## 快速复跑（机器层）

```bash
# 仓库根目录，Node.js 24，npm install 后
node scripts/workflow-conformance/run.mjs
node --test scripts/test/workflow-conformance.test.mjs
```

写入 JSON 报告：

```bash
node scripts/workflow-conformance/run.mjs --json /tmp/loc-042-report.json
```

## 固定夹具

| 模板 | 目录 | 验收要点 |
|---|---|---|
| 建设 `wf-construction-full-feature` | `scripts/test/fixtures/conformance/construction/` | CLI `--version` 与 package.json 一致 |
| 优化 `wf-optimize` | `scripts/test/fixtures/conformance/optimize/` | 10 条事实逐字保留，压缩 ≥20% code point |
| 诊断 `wf-diagnose` | `scripts/test/fixtures/conformance/diagnose/` | buggy sum([2,3,5])=5；fixed 得 10/0/7 |
| 探索 `wf-explore` | `scripts/test/fixtures/conformance/explore/` | 6 份资料 + 研究问题 |

清单摘要：`scripts/test/fixtures/conformance/manifest.json`（开发后冻结）。

## 证据分层

| 层 | 状态来源 | 说明 |
|---|---|---|
| 自动契约 | `run.mjs` + `workflow-conformance.test.mjs` | 七探针、负例、消费链、夹具 |
| 真实安装 DSH E2E | 人工 | 按 `docs/runbooks/construction-dsh/runbook.md`；本任务不代部署 |
| 真实模型行为 | 人工 | 替身通过不等于线上质量 |
| 人工验收 | uat-card | 三态签收，Agent 不得代签 |

已知产品缺口登记：`scripts/workflow-conformance/lib/known-gaps.mjs`。探针观测到仍失败时标 `KNOWN_GAP`，不 skip 冒充 PASS。

## 发布入口

`npm run release:verify` 在项目测试阶段包含 `workflow-conformance` 机器层（见 `scripts/release-verify.mjs`）。

## 异机复跑

1. 复制仓库到临时路径（勿依赖作者 `$HOME` 或私有 DSH 状态）
2. `npm install`
3. `node scripts/workflow-conformance/run.mjs`
4. 查看报告 `layers` 字段；`known_gaps_observed` 列出仍失败的产品项（由对应 LOC 任务修复）
