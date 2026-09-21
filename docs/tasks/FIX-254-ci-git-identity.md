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
| 当前状态 | 本地已定义 |
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

### 范围与边界

- 改动限于 `.github/workflows/validate.yml` 新增 1 个步骤，**不改任何测试、不改产品代码、不改蓝图与生成结果**。
- 未纳入本票：① 测试侧自给身份（约 18 个文件的测试卫生改造）；② 把 `validate` 提升为必需状态检查（依赖本票先落地）；③ macOS 本地 `FIX-235 真机探针` 失败（既有、CI 上被跳过）。
