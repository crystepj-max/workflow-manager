# FIX-254 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-254` |
| 远端 issue | github#254 |
| 需求来源 | 会话录入：排查 PR #218 CI 红时定位到 runner 缺提交者身份 |
| 来源定位 | 2026-09-20 排查 PR #218 为何 CI 仍红，用临时诊断提交取回完整失败清单，根因为 `Author identity unknown`；2026-09-21 复核主干确认无人处理 |
| 任务名称 | CI 闸门可信化：为 validate 工作流补 git 提交身份，修复收口链用例在 Linux runner 上永不通过 |
| 任务类型 | 缺陷修复（编号类型 FIX） |
| 优先级 | P1 |
| 定义时间 | 2026-09-21T02:19:00Z |
| 当前状态 | 已合并 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | 待定 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FIX-254-ci-git-identity/task-spec-V1.md` |
| GitHub 同步 | synced#254 |

> 取值约束：`无人值守许可` 只写枚举原值，`GitHub 同步` 只写 `pending` / `synced#N` / `not-applicable`。

## 摘要

未决产品事项：0

### 问题

`validate` 闸门在 CI 上长期红，其中 **7 个收口链用例**（`local-task-merge` 系列）在 Linux runner 上**永不通过**，且与任何业务改动无关。

根因链（已定位到行）：

1. 这些用例会经**产品代码**执行真实 `git commit`：`scripts/local-task-merge.mjs:358`。
2. 产品代码执行 git 时**不覆盖子进程 env**（`scripts/local-task-merge.mjs:50`：`execFileSync('git', args, { cwd, encoding: 'utf-8' })`），因此提交身份**只能来自运行环境**。
3. GitHub Ubuntu runner **不配置** git 提交身份；而 macOS 会由 username/hostname 自动推导。→ 同一套测试在本机绿、在 CI 红。
4. 报错为 `Error: Command failed: git commit -F /tmp/loc-merge-*.txt` + `Author identity unknown` / `*** Please tell me who you are.`。

**为什么以前没被识别**：CI 的失败输出被 `scripts/validate.mjs` 截断为最后 4 行（该截断已由 PR #248 修复），此前只能看到一句无信息的参数片段，导致归因一度被写成「M5 用例依赖真实挂钟、高负载下假超时」——该归因**已被实测推翻**。

### 处理

在 `validate` 工作流中、`actions/setup-node` 之后补一步，写入 CI 机器人身份：

```yaml
- name: 配置 git 提交身份（供收口链用例做真实 commit）
  run: |
    git config --global user.name "github-actions[bot]"
    git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
```

**为什么选这一处而不是改测试**：提交身份在真实收口场景中由操作者机器的 git 配置提供，属**产品代码的合理前提**；要让 CI 与真实环境一致，应在环境侧补齐。测试侧自行注入需改动约 18 个创建临时仓库的测试文件，改动面远大于收益，另案评估。

### 实测结果（详见 `specs/FIX-254-ci-git-identity/definition-check.md`）

同一工作区、同一跑法（`node --test scripts/test/*.test.mjs`），仅切换全局 git 身份来源：

| 场景 | 失败数 |
|---|---|
| A · 模拟 runner（无身份 + `useConfigOnly`） | **9**（7 项收口链 + 1 项未生成产物的 drift + 1 项 darwin 探针） |
| B · 提供身份（模型工作流补配置后） | **1**（仅 darwin 探针） |

即：**7 项收口链失败全部消失**。

剩余那 1 项 `FIX-235 真机探针` 带有 `{ skip: process.platform !== 'darwin' }` 守卫，**在 CI 的 Linux 上会被跳过、不可能失败**；它在 macOS 本地失败属既有本机问题，与本票无关（`node-isolation.test.mjs` 单跑即可复现，未改动任何相关代码）。

### CI 实机双臂对照（决定性证据）

上述为本地模拟。为取得**真实 runner** 上的证据，在一次 CI 运行内跑两臂（同 runner、同提交、同命令 `node scripts/validate.mjs`，仅切换身份来源）：

| 臂 | 环境 | 引擎层失败用例数 |
|---|---|---|
| 臂 1 | 有身份（＝本票修复后） | **8** |
| 臂 2 | 无身份（`GIT_CONFIG_GLOBAL=/dev/null` + `user.useConfigOnly=true`，＝修复前） | **15** |

→ **CI 上失败数由 15 降为 8，7 项收口链用例真实转绿。**

### 剩余 8 项：既存、与本票无关

臂 1 与臂 2 共有的 8 项失败（即本票**未**修复、且**非**本票引入的部分）：

| # | 用例 | 现象 |
|---|---|---|
| 1 | `M4 机械验收脚本通过` | 断言失败 |
| 2 | `start：按固定端口启动（不是 --port 0）…` | `无法核验端口 19527 占用情况；已停止，避免误判` |
| 3 | `start：.agent-runs 下唯一 Run 可推断命名空间…` | dev-plugin 启动路径 |
| 4 | `gh 不可达时降级 TMP 并告警（验收 2）` | 依赖「`gh` 不可达」前提，CI 上 `gh` 存在 |
| 5–8 | `V-3` / `V-4` / `V-5` / `V-8` | 工作区治理断言 |

**因此本票只完成「身份」这一环；`validate` 在 CI 上仍不会全绿**，需另行立票处理上述 8 项。

### 附带发现：CI 曾出现一次间歇性卡死（25 分钟未结束）

本票首次推送后，`validate` 步骤跑满 25 分钟仍未结束（对照：其他分支每次约 31–42 秒结束），已手动取消。后续两次诊断运行均**正常结束**（未复现），逐文件走管道也全部 0–4 秒完成。

定位到的高危写法：`scripts/validate.mjs` 用 `execFileSync(…, { stdio: 'pipe', shell: true })` 收集引擎层输出——该写法**要等管道 EOF 才返回**，一旦测试套件留下仍持有 stdout 的常驻子进程（如 dev-plugin 启动用例未回收的服务进程），就会**永久阻塞且不报错**。疑与本表中第 2/3 项（端口 19527 核验失败）相关。

此项**本票不修**（属 `validate.mjs` 的健壮性缺口，需独立立票加超时），但必须记录：它会让 CI 在红灯之外多出一种「挂死」形态。

### 范围与边界

- 改动限于 `.github/workflows/validate.yml` 新增 1 个步骤，**不改任何测试、不改产品代码、不改蓝图与生成结果**。
- 未纳入本票：① 测试侧自给身份（约 18 个文件的测试卫生改造）；② 把 `validate` 提升为必需状态检查（依赖本票先落地）；③ macOS 本地 `FIX-235 真机探针` 失败（既有、CI 上被跳过）。

## 收口（2026-09-22 账实对正）

- 交付物：`a4dfaf1`（`validate.yml` 全局 git 身份两步，含「产品代码不覆盖子进程 env，身份只能来自环境」的口径注释），经 **PR #256** 合入，合并提交 `8260bc4`（2026-09-21T03:25:02Z）。
- 生效证据：main 运行 `35628382807` 报 `✅ 引擎层测试全绿` + 两个包 `✅ 全绿` + `✅ validate 通过`；本票点名的 7 个收口链用例不再失败。
- 本次改动性质：登记册此前停在「本地已定义 / merge=无」，与主线事实不符；现按 git 与 CI 实测对正，未新增任何代码改动。
