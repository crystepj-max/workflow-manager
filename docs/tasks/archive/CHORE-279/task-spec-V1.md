# CHORE-279 · 任务规格 V1

> 父票：`CHORE-260`（github#260）· 机制 **M7** · 施工顺序第 6 步
> 需求基线版本：V1 ｜ 定义时间：2026-09-21T13:43:31Z

## 1. 目标

消除 M7：**跑测试不再改写仓库中任何 benchmark 产物**，同时保持入库的冻结基线（封条）不被改写。

一句话验收：跑完整测试后，`git status` 在 `scripts/benchmark/` 下为空（父票 AC-06）。

## 2. 现状（实测证据）

- 复现命令：`node --test scripts/test/loc-045-benchmark.test.mjs` → 跑前 `git status` 0 项，跑后 **51 项**。
- 51 项构成：`config/freeze-manifest.json` 1 项 + `reports/` 2 项 + `results/prepared/` 48 项。
- 变更字段：冻结清单的 `frozen_at` 与 4 个 `template_digests`、`script_digest`；占位记录的 `template_digest`、`script_digest`、`created_at`、`record_id`（随机 UUID）；报告的生成时间。
- 测试文件 8 个用例中，**第 4、5 个**为写入源。第 4 个用例已隔离 `resultsDir`，但因 `writeFreezeManifest` **无条件写** `benchRoot/config`，仍会污染仓库。
- `validate` 链（`validate.mjs` / `validate-task-spec-sync.mjs` / `validate-workspace.mjs`）**均不引用 benchmark**，故本票不影响闸门结果。

## 3. 方案（已由项目负责人选定做法一）

### 3.1 库侧：仅增加可指定输出位置，默认行为不变

| 函数 | 新增可指定项 | 默认值 | 语义 |
|---|---|---|---|
| `prepareExperiment` | `configRoot` | `benchRoot` | 冻结清单写入 `<configRoot>/config/`；**读取输入仍用 `benchRoot`**（夹具与模板来自实验目录） |
| `writeResearchReport` | `reportsDir` | `<benchRoot>/reports` | 报告写入 `<reportsDir>/` |

### 3.2 测试侧：全部写入指向临时目录

两个写入用例经 `configRoot` / `resultsDir` / `reportsDir` 注入 `mkdtempSync` 临时目录，并在用例末清理。

### 3.3 文档侧：写明封条语义

`scripts/benchmark/loc-045/README.md` 增补「冻结基线的不可变性」：① 不随模板演进回填；② 要新一轮实验须显式重新冻结并另存旧基线；③ 自动化测试不得改写，须把输出指向临时目录。

## 4. 明确不做

- **不改写任何入库产物**。封条保持 2026-09-16 原始内容（选定做法一的核心理由）。
- **不改命令行工具的默认输出位置与调用方式**：`loc-045-freeze/prepare/report.mjs` 无参调用行为与改动前完全一致。
- 不删除、不新增任何断言；不放宽任何检查。
- 不处理测试文件中既存的未使用变量 `benchTmp`（与本次改动无关）。

## 5. 验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| AC-01 | 目标测试全绿 | `node --test scripts/test/loc-045-benchmark.test.mjs` → 8/8 |
| AC-02 | 跑完整测试后 `scripts/benchmark/` 下工作区为空 | `git status --short -- scripts/benchmark` 中不含产物类路径 |
| AC-03 | 封条未被改写 | `config/freeze-manifest.json` 的 `frozen_at` 仍为 `2026-09-16T16:56:27.100Z`，`wf-explore` 指纹仍为 `e065d32f…` |
| AC-04 | 占位记录未被改写 | `results/prepared/baseline-B01-r1.json` 的 `created_at` 与 `record_id` 保持原值 |
| AC-05 | 命令行工具默认行为不变 | 三个相关 CLI 均为无参调用，默认值路径与改动前一致 |
| AC-06 | 失败清单与干净主干一致 | 对照工作区于 `origin/main` 跑同一命令，失败项逐条相同 |

## 6. 风险与残留

- 入库封条与当前模板**确实不一致**（模板在冻结后经 FIX-228 / FIX-234 变更）——这是做法一刻意保留的结果，已在 README 写明「不回溯」，避免后来者误读。若将来要真跑该实验，须按 README 指引显式重新冻结。
- 本票不引入新的「产物洁净度」自动校验；AC-02 为人工/CI 可复核项，不新增闸门断言（避免扩大范围）。

未决产品事项：0
