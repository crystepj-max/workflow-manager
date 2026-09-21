# Definition Check · FIX-254 CI 提交身份（validate 闸门可信化）

## 检查元数据

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-254` |
| 远端 issue | github#254 |
| 检查对象 | 让 7 个收口链用例在 Linux runner 上不再因缺 git 提交身份而失败 |
| 检查时间 | 2026-09-21 |
| 结论位置 | 本文末「结论」节 |

## 9.1 目标与范围

- [x] 目标限定为：消除「本机绿 / CI 红」的环境性差异，使 `validate` 引擎层在 CI 上真实转绿
- [x] 只改 CI 工作流；不改测试、不改产品代码、不改蓝图与生成结果
- [x] 明确排除测试侧自给身份（约 18 个测试文件，改动面过大，另案评估）
- [x] 明确排除把 `validate` 提升为必需状态检查（依赖本票先落地）
- [x] 明确排除 macOS 本地 `FIX-235 真机探针` 失败（既有、且在 Linux 上被 skip 守卫跳过）

## 9.2 现状证据

- [x] 失败可复现：临时诊断提交取回完整清单，7 项均为 `local-task-merge` 系列，报错逐字为 `Command failed: git commit -F /tmp/loc-merge-*.txt` + `Author identity unknown`
- [x] 根因定位到行（第 1 环）：`scripts/local-task-merge.mjs:358` 经产品代码执行真实 `git commit`
- [x] 根因定位到行（第 2 环）：`scripts/local-task-merge.mjs:50` `execFileSync('git', args, { cwd, encoding: 'utf-8' })` **不传 `env`**，子进程继承 `process.env`
- [x] 根因定位到行（第 3 环）：`scripts/test/local-task-merge.test.mjs:11-19` 测试自带 `GIT_ENV`（含 `GIT_AUTHOR_*` 与 `GIT_CONFIG_GLOBAL=/dev/null`），但**只作用于测试自己的 `g()` 辅助函数**，覆盖不到产品代码发起的提交 → 故测试自身有身份、产品代码没有
- [x] 平台差异已实测：macOS 无配置时会由 username/hostname 自动推导（`Committer: Chris <chris@...local>`），Linux 直接报错 → 解释了「本机绿 / CI 红」
- [x] 无测试改写 `process.env` 的 `GIT_*`（全仓检索为空）→ 环境侧补配置不会被测试侧覆盖
- [x] 主干现状已核实：`origin/main:.github/workflows/validate.yml` 中 `user.name` 命中数为 **0**，问题原样存在
- [x] 无重复劳动：`chore/ci-failure-diagnostics` 分支已并入主干（即 PR #248，修的是输出截断），无在途 PR、无已立票处理本问题

## 9.3 验收标准

- [x] AC-01 身份缺失可复现 CI 红：A 场景实测 9 项失败，其中 `local-task-merge` 系列 **7 项**（余 2 项为模拟环境副产物，见 9.4）
- [x] AC-02 提供身份后该 7 项全部消失：B 场景实测 `local-task-merge` 系列 **0 失败**
- [x] AC-03 工作流语法与步骤位置：用 YAML 解析器实测可解析，步骤顺序为 checkout → setup-node → **身份配置** → install → generate → validate
- [x] AC-04 改动面可机器断言：`git diff --name-only origin/main` 仅含 `.github/workflows/validate.yml` 与本票文档（基准产物噪音已 `git checkout` 还原，未入库）
- [x] AC-05 不引入其它回归：正常环境下全量引擎层 849 项 / 1 失败，该 1 项与本票无关（见 9.5）
- [x] AC-06 **CI 实机双臂对照**：同 runner、同提交、同命令 `node scripts/validate.mjs`，仅切换身份来源——臂 1（有身份）引擎层失败 **8** 项，臂 2（无身份）**15** 项 → 真实 runner 上确认 7 项收口链用例转绿

## 9.4 对照实验（本票核心判据）

同一工作区、同一命令 `node --test scripts/test/*.test.mjs`，仅切换身份来源：

| 场景 | 环境 | 结果 |
|---|---|---|
| A · 模拟 runner | `HOME=<空> GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true` | 849 项 / 失败 **9**（7 项收口链 + 1 项 drift 未生成 + 1 项 darwin 探针） |
| B · 补配置后 | 同 A，仅 `GIT_CONFIG_GLOBAL` 指向含 `[user]` 的配置文件 | 849 项 / 失败 **1**（仅 darwin 探针） |

- [x] 差异归因明确：A→B 消失的 8 项中，7 项为收口链（本票目标），1 项 drift 为未执行 `npm run generate` 导致，补 generate 后即消失
- [x] 剩余 1 项已定性：`FIX-235 真机探针` 带 `{ skip: process.platform !== 'darwin' }`，**Linux 上跳过、不可能在 CI 失败**；其 macOS 本地失败单跑 `node-isolation.test.mjs` 即可复现，与本票改动无关

## 9.5 风险与残留

- [x] 身份使用 CI 机器人账号（`github-actions[bot]`），不冒充真人；仅用于测试临时仓库内的提交，不写回本仓库
- [x] 用 `git config --global` 写入 runner 的 `$HOME/.gitconfig`，job 内一次性环境，无持久副作用
- [x] 残留风险如实登记：本改动只修 CI，若在无 git 身份的其他容器中执行测试仍会复现同类失败——根治需测试侧自给身份（非目标，另案）
- [x] macOS 本地 `FIX-235 真机探针` 失败仍存在，属既有问题，本票不处理

### 9.5.1 本票未覆盖的 CI 剩余 8 项失败（既存、非本票引入）

臂 1 与臂 2 共有的 8 项，即两臂对照中被排除在本票成效之外的部分：

- [x] `M4 机械验收脚本通过`
- [x] `start：按固定端口启动（不是 --port 0）…`（报 `无法核验端口 19527 占用情况`）
- [x] `start：.agent-runs 下唯一 Run 可推断命名空间…`
- [x] `gh 不可达时降级 TMP 并告警（验收 2）`（该用例以「`gh` 不可达」为前提，CI 上 `gh` 存在）
- [x] `V-3` / `V-4` / `V-5` / `V-8`（工作区治理断言）
- [x] 明确判定：以上 8 项在臂 2（修复前）同样失败，**非本票引入**；本票不修，需另行立票
- [x] 因此**本票不使 `validate` 在 CI 上全绿**，只完成「身份」一环——结论中不得声称 CI 已转绿

### 9.5.2 附带发现：`validate.mjs` 的管道卡死风险（本票不修）

- [x] 现象已记录：本票首次推送后 `validate` 步骤运行 **25 分钟**未结束（对照其他分支约 31–42 秒），手动取消
- [x] 未复现：随后两次诊断运行均正常结束；逐文件走管道全部 0–4 秒完成 → 属**间歇性**
- [x] 高危写法已定位：`scripts/validate.mjs` 用 `execFileSync(…, { stdio: 'pipe', shell: true })`，该写法需等管道 EOF 才返回；测试套件若留下仍持有 stdout 的常驻子进程即永久阻塞
- [x] 疑因已记录：与 9.5.1 第 2/3 项（dev-plugin 端口 19527 核验失败）相关，但未证实因果
- [x] 处置：本票不修（属 `validate.mjs` 健壮性缺口），在卡面如实登记并建议独立立票加超时

## 结论

**通过。** 根因定位到行、A/B 对照实验给出量化差异、改动面仅 1 个 CI 步骤且语法经解析器验证；剩余失败项均已定性为与本票无关（其中 CI 上会被跳过）。闸门可信化的前置条件已具备。
