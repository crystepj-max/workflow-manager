# 08 — 12 角色收口验收与文档同步

**What to build:** 把前 7 张工单的成果收口，确认系统呈现的内置角色体系完整、正确、可引用，并把正式角色清单同步进项目文档。

**Blocked by:** 02, 03, 04, 05, 06, 07

**Status:** ready-for-agent → **已完成（2026-08-30）**，1 项已知缺口

## 机械核对结果

逐条比对 issue 正文 10 条验收标准 + 本次补充，脚本核对：

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 内置角色精确 12 个，id 与顺序符合规格 | ✅ |
| 2 | 内置角色只读拦截存在（update / remove 双重判定） | ✅ |
| 3 | 未新增按节点名命名的重复场景角色 | ✅ |
| 4 | `evaluator`/`review`/`test`/`accept` 定义中均含职责边界段落 | ✅ |
| 5 | `evaluator` 不含任何具体评价枚举 | ✅ |
| 6 | `dispatcher` 保留文件、不在内置集合、仍被 4 个模板节点引用 | ✅ |
| 7 | `dev`/`test`/`review`/`accept`/`closeout` 五个 id 不变 | ✅ |
| 8 | 自定义角色修改不改变已启动 Run 的 Snapshot | ⚠️ **已知缺口** |
| 9 | 现有模板引用的 profile 全部可解析到角色文件 | ✅ |
| 10 | 机器 ID 稳定英文、中文名符合规格 | ✅ |
| 11 | 12 个角色定义文件均存在且非空 | ✅ |
| 12 | 未创建永久专家角色（Expert A/B/C/D） | ✅ |

**结果：PASS 11 / WARN 1 / FAIL 0。**

## 测试与生成

- 仓库级 `node --test "scripts/test/*.test.mjs"`：85 项全过
- 插件包 `host.test.mjs` + `runs-persistence.test.mjs`：84 项全过（1 项 skip）
- `npm run generate`：两个模板正常产出，13 份角色文件随模板打包（12 内置 + dispatcher）

**无法在本环境运行的**：`client.smoke.mjs`（缺 `jsdom`）、`static-bundle.test.mjs` / `dist-fresh.test.mjs`（`dist/` 未构建）。这两处属环境预存问题，非本次改动引入——已单独验证：把本次改动藏起来后它们同样失败。

## 文档同步

- README 与 v0.1 产品规格**原本就按 12 角色 / `dispatcher` 迁为 Custom Role 撰写**（规格先于实现），无需改动。
- `docs/research/mjs-semantics.md` 原句易被误读为当前状态，已加一行快照说明，标注其为历史 2.0 脚本的语义记录。
- 其余命中「六角色」的文档（`docs/开发工作流2.0需求规格.md`、`docs/开发工作流优化设计.md`、`docs/工作流状态机.md`、`docs/design/vwf-p0/requirements-analysis.md`）均为**刻意描述历史 2.0 体系的存档**，其「六角色」陈述对当时状态是准确的，不改写。

## 本次**不**验收（已拆出，等 #79）

- 「已启动 Run 的快照隔离」：修改自定义角色不会影响已经开始运行的 Run。该能力依赖 Run Snapshot 机制，当前不存在；现有实现方向与之相反（角色内容修改天然全局生效，见 host.js 角色库段注释）。随 #79 交付后回填验收。

## 遗留事项（交 #82）

- 探索模板的两个产物名 `exploration-plan.md` / `synthesis-report.md` 在契约一致性测试中被**临时豁免**（`scripts/test/runtime.test.mjs`），因为探索蓝图由 #82 交付、其 `output.files` 尚不存在。**待 #82 在探索蓝图中声明后，应删除该豁免。**
