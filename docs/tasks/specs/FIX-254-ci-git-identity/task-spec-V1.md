# CI 闸门可信化：为 validate 工作流补 git 提交身份

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | github#254（本地轨道 `FIX-254`） |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许（CI 配置改动，判据为可复现的 A/B 对照实验，无需产品 DSH 实测） |
| 定义时间 | 2026-09-21T02:19:00Z |
| 当前状态 | 本地已定义 |
| 分类 / 体量 | bug ｜ sized-xs（工作流新增 1 个步骤） |

## 1. 背景与问题

`validate` 闸门在 CI 上长期红。其中 **7 个收口链用例**（`local-task-merge` 系列）在 Linux runner 上永不通过，与业务改动无关。

| # | 事实 | 证据 |
|---|---|---|
| 1 | 用例会经产品代码执行真实 `git commit` | `scripts/local-task-merge.mjs:358` `git(['commit', '-F', msgFile], repo)` |
| 2 | 产品代码不覆盖子进程 env，身份只能来自环境 | `scripts/local-task-merge.mjs:50` `execFileSync('git', args, { cwd, encoding: 'utf-8' })` |
| 3 | Linux runner 不配置提交身份；macOS 会自动推导 | 报错 `Author identity unknown` / `*** Please tell me who you are.` |

后果：**同一套测试本机绿、CI 红**，`validate` 因而不可能被提升为「不通过不许合并」的必需状态检查——闸门实质不可信。

## 2. 目标与非目标

**目标**：让 `validate` 的引擎层在 CI 上真实转绿，消除「本机绿 / CI 红」的环境性差异。

**非目标**（明确排除）：

- 不改测试自给身份（涉及约 18 个创建临时仓库的测试文件，改动面过大，另案评估）。
- 不把 `validate` 提升为必需状态检查（依赖本票先落地，另行排期）。
- 不处理 macOS 本地 `FIX-235 真机探针` 失败（既有问题，且该用例在 Linux 上被 `skip` 守卫跳过）。
- 不改任何产品代码与蓝图。

## 3. 方案

在 `.github/workflows/validate.yml` 的 `actions/setup-node` 之后插入一个步骤，写入 CI 机器人身份：

```yaml
- name: 配置 git 提交身份（供收口链用例做真实 commit）
  run: |
    git config --global user.name "github-actions[bot]"
    git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
```

位置选择：放在 `checkout` / `setup-node` 之后、`install` / `generate` / `validate` 之前，使后续所有步骤都处于有身份的环境中。

**为什么在环境侧补而不是测试侧**：提交身份在真实收口场景中由操作者机器的 git 配置提供，属产品代码的合理前提；要让 CI 与真实环境一致，应在环境侧补齐，代价仅 1 个步骤。

## 4. 验收标准

| 编号 | 标准 | 判据 |
|---|---|---|
| AC-01 | 身份缺失可复现 CI 红 | `HOME=<空目录> GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true node --test scripts/test/*.test.mjs` → 7 项 `local-task-merge` 用例失败 |
| AC-02 | 提供身份后该 7 项全部消失 | 同上命令，仅把 `GIT_CONFIG_GLOBAL` 换成含 `[user]` 的配置文件 → `local-task-merge` 系列 0 失败 |
| AC-03 | 工作流语法有效且步骤位置正确 | YAML 可解析；步骤顺序为 checkout → setup-node → **身份配置** → install → generate → validate |
| AC-04 | 改动面可机器断言 | `git diff --name-only` 仅含 `.github/workflows/validate.yml` + 本票文档，不含 `templates/`、`scripts/`、生成物 |
| AC-05 | 不引入其它回归 | 正常环境下全量引擎层失败数不因本改动增加 |

## 5. 影响面

- 蓝图与生成结果：**零影响**（未触碰 `templates/`）。
- 产品行为：**零影响**（仅 CI 工作流）。
- 对工作流程的影响：引擎层在 CI 上重新可信，是后续把 `validate` 设为必需状态检查的前置。

未决产品事项：0
