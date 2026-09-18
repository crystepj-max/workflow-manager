# CHORE-37 需求分析摘要 · 交付链口径残留收敛（closeout 角色的强删表述）

> 本文是定义阶段的证据留痕：记录「为什么改、改哪、谁拍板」。施工以同目录 `task-spec-V1.md` 为准。

## 1. 输入识别与轨道判定

| 项 | 判定 |
|---|---|
| 输入形式 | 会话录入 + 已有登记条目（registry `CHORE-37`，远端锚点 `cnb#37`，legacy `LOC-035`） |
| 需求来源 | 会话录入 |
| 来源定位 | LOC-023 有条件通过优化意见②（2026-09-15 松哥裁决）：交付链文本口径与已通过决策不一致，需收敛 |
| 发布去向 | **本地轨道**——GitHub 凭据不可用；CNB 侧已有 issue 锚点（cnb#37）但**未被交付流程接入**，按需求源与记录处理，**不构成 tracker 侧的「已定义」**；交付载具 = 本地任务卡 + 登记册 |
| GitHub 同步 | 保持 `pending` |

> 复述给读者：本版本的「已定义」资格来自本地任务卡与登记册，不是来自 CNB issue。CNB 只作编号发号与讨论留痕。

## 2. 分诊

| 项 | 判定 |
|---|---|
| 分类 | `enhancement`（规则收敛，非功能新增） |
| 状态 | `ready-for-agent`（待材料落齐） |
| 冗余性检查 | 已确认这是 LOC-023 之外**唯一**残留的错口径；其余 6 处已于 LOC-023 收敛通过（见 §3） |
| 历史拒绝 | 无 |

## 3. 调查事实（本次实测）

### 3.1 唯一真源的问题行

`dsh/roles/closeout.md:24`：

```text
- 删除用 `git worktree remove <路径>`；残留本任务未提交/未跟踪文件时，先确认归属再用 `--force`；
```

与已接受规则互斥：

- 决策 `0001` §6（2026-09-12 accepted）：两阶段收口，阶段一「删工作区、留分支」；
- 约定 `docs/design/workspace-directory-convention.md` §1.7.1 同口径；
- **LOC-023 规格 §9 R-4**（2026-09-14 确认，已合并）：四项前置同时满足才删；**禁止使用 `--force`**；删除失败只登记遗留、不阻塞合并。

### 3.2 全仓检索结论（排除依赖目录）

`--force` 在版本库内的分布（排除 node_modules）：

| 位置 | 表述性质 | 是否需改 |
|---|---|---|
| `dsh/roles/closeout.md:24` | 允许强删 | **是（唯一真源）** |
| `packages/dsh-visual-workflow/dist/roles/closeout.md:24` | 同错文本，但是**生成产物**（见 §3.3） | 否（改真源后重建） |
| `dsh/skills/construction-bootstrap/runbook.md:220` | 「不带 `--force`，脏则拒绝并只登记遗留」 | 否（已正确，作为对照基准） |
| `docs/design/ai-task-define-delivery/local-track-offline-mode.md:185` | 同上口径 | 否（已正确） |
| `docs/design/workspace-directory-convention.md:467` | 原则句「被拒时先查明原因，不直接升级到 `--force`」 | 否（已正确） |
| `scripts/local-task-merge.mjs:24 / 337 / 347 / 353` | 实现、头注释、遗留文案说明 | 否（实现正确） |
| `scripts/test/local-task-merge.test.mjs:199-200` | 断言保留 git 原话含 `--force` 是 R-4 禁止路径 | 否（反向断言，正确） |
| `docs/reports/workspace-convergence-scan-2026-09-12.md:199/240` | 历史归档报告 | 否（历史记录不改） |

### 3.3 dist 副本的性质（避免误改）

`packages/dsh-visual-workflow/dist/roles/closeout.md` 由 `packages/dsh-visual-workflow/scripts/build-bundle.mjs` 从 `dsh/roles/*.md` **整体拷贝**生成（脚本第 60/119/204-206 行），并被 `packages/dsh-visual-workflow/.gitignore` 的 `dist/` 规则忽略、**不入库**。当前与真源逐字一致。故：改真源 + 重建即可同步，**不得手改 dist**（手改会被下次构建覆盖，属无效改动）。

## 4. 渐进分析与决策

| 决策主题 | 选项 | 松哥裁定 | 依据 |
|---|---|---|---|
| 是否同步加机器闸门（在校验器里扫描「交付链出现允许强删」的表述） | A 只改文案 / B 文案 + 闸门 | **A 只改文案**（2026-09-16） | 收益集中在口径统一本身；闸门规则本身需要长期维护，本次不背这个负担 |

裁定后无剩余未决产品事项。

## 5. 体量判定

**S**。理由：路径清晰（唯一真源一句话 + 一次重建）；影响面单一（收口角色文案）；单会话可完成；无不确定性。不拆分切片。

## 6. 相邻任务关系

- 兄弟票：CHORE-36（优化意见①，已合并）、CHORE-38（优化意见③）；三者同源不同面，**无依赖、可并行**。
- 按松哥「依次执行」的裁定，本票先于 CHORE-38 走完。

## 7. 交付执行顺序（裁定 A3 · 依次）

先完成 CHORE-37 定义确认 → 施工 → 验收 → 收口；全部完成后再启动 CHORE-38 的定义材料，确保任一时刻只有一票处在活跃施工环境。
