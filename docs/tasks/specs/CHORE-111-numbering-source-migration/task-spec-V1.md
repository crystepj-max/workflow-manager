# 任务规格 V1 · CHORE-111 任务编号发号源从 CNB 迁移到 GitHub

| 项 | 值 |
|---|---|
| 任务标识 | `CHORE-111` |
| 远端 issue | cnb#111 |
| 规格版本 | V1 |
| 需求基线 | V1 |
| 编写日期 | 2026-09-19 |

---

## 1. 背景

2026-09-19 松哥决策：GitHub 账户已恢复，后续**以 GitHub 为主源**，CNB 转为**灾备镜像源**。镜像机制已落地并实测通过（`.github/workflows/mirror-cnb.yml`，PR #205，运行 `35418948093` success 13s）。

代码主源方向已定，但**任务编号的发号源**仍绑在 CNB：

- 编号格式 `<TYPE>-<远端 issue 号>`（`TYPE ∈ FEAT|FIX|CHORE`），号由远端服务端分配，本机不自增——这是防双机/多会话撞号的既有机制，**必须保留**。
- 但发号实现只认 CNB：`resolveRemoteSlug` 读 `git remote get-url cnb`；`remoteAllocate` 调 `cnb issues create-issue`。

结果：主源已是 GitHub，新增任务的号却仍由 CNB 签发，出现「主源与发号源分离」的口径不一致。

## 2. 目标

把发号源迁到 GitHub，使 `<TYPE>-<号>` 的号继续**由远端分配**（保留防撞号属性），并把与主源相关的门禁文案、收口提示、适配器白名单一并对齐到新口径。

**非目标**：不改历史任务号、不改历史 `remote` 字段、不迁移既有 issue 内容、不动 UI 交互工作、不动镜像 workflow。

## 3. 现状与改造点定位

| # | 文件 | 位置 | 现状 | 迁移后 |
|---|---|---|---|---|
| 1 | `scripts/local-task-registry.mjs` | L72–80 `resolveRemoteSlug` | 只 `git remote get-url cnb`，取不到返回 null | 支持 `origin`（GitHub）远端解析，取不到再回落 |
| 2 | 同上 | L91–113 `remoteAllocate` | 调 `cnb issues create-issue --repo <slug>`，正则取 `"number"` | 调 `gh issue create --repo <owner/repo>`，从返回 URL 尾段取号 |
| 3 | 同上 | L328–359 `allocate` | `taskId = <TYPE>-<number>`；`remote = cnb#<number>` | `remote = github#<number>`；降级路径不变 |
| 4 | 同上 | L25 / L30 注释 | 「号由 CNB 服务端分配」 | 改为 GitHub，并保留「禁止本机自增」原则 |
| 5 | `scripts/remote-issue-sync.mjs` | L112 / L139 | 写 `t.remote = cnb#<number>` | 改为 GitHub 通道 |
| 6 | `scripts/local-task-merge.mjs` | L410 | 收口提示串 `cnb issues update-issue …` | 改为 `gh issue close` 形态 |
| 7 | `scripts/validate-task-spec-sync.mjs` | L10 | 门禁文案「必须有远端（CNB）issue 号」 | 改为平台无关表述 |
| 8 | `scripts/ai-task-candidate-collect.mjs` | L13 | 注释「远端（CNB）候选」 | 平台无关表述 |
| 9 | `scripts/delivery-closeout-host.mjs` | L25 / L26 | `KNOWN_ADAPTERS` 含 `cnb`；`UNAVAILABLE_ADAPTERS=['github']` | 增 GitHub 适配器并移出不可用名单（与 CHORE-106 的 cnb 适配器并存） |

## 4. 方案

### 4.1 发号链路

```
allocate()
  ├─ resolveRemoteSlug(repo)    → 优先 origin（GitHub）→ 回落 cnb → 都无则本地序号
  ├─ remoteAllocate()           → gh issue create --repo <owner/repo> --title <name> --label <type>
  │                                从返回的 issue URL 取尾段数字作为号
  └─ 失败 → tmpId() 降级 TMP 号（禁止静默回落 CNB 发号）
```

### 4.2 编号格式

保持同构：`task_id = <TYPE>-<号>`，`remote = github#<号>`。

历史任务的 `task_id` 与 `remote` **一律不动**——号是历史事实，重编会牵动卡片文件名、分支名、标签名与所有引用，成本远高于收益。

### 4.3 历史号段冲突（已裁定：A · 复用占位号对齐）

GitHub `#106` / `#108` / `#109` / `#110` 曾被 2026-08-30 误建的占位 issue 占用，其中 #109/#110 与本地 `FIX-109`（cnb#109）、`CHORE-110`（cnb#110）直接撞号。

经 `DT-01` 裁定采用 **A 方案**，已于 2026-09-19 执行完毕：

| GitHub 号 | 复用为 | 动作 |
|---|---|---|
| #108 | `FIX-108` 正式 issue | 重命名 + 重开 + label `bug` |
| #109 | `FIX-109` 正式 issue | 重命名 + 重开 + label `bug` |
| #110 | `CHORE-110` 正式 issue | 重命名 + 重开 + label `documentation` |

- `#106` 是真实 issue（有 parent #76 与实际正文）→ **不动**；`CHORE-106` 的远端锚点保留 `cnb#106`（该任务已收口）。
- **GitHub issue 编号不可回收**（删除后不复用），故复用是零断裂、零浪费的唯一路径。
- 新任务号自 GitHub 当前最大号 +1（约 #205 起）继续由服务端分配。

裁定明细与执行记录见 `decision-tickets/DT-01-numbering-collision.md`。

## 5. 交付范围

**做**：§3 表中 9 处改造 + 决策票裁定执行 + 新增单测 3 条。

**不做**：§2 非目标全部；不改 `registry.json` 既有任务业务字段；不动 `.github/workflows/mirror-cnb.yml`。

## 6. 验收标准

1. `allocate` 后新任务 `task_id = <TYPE>-<GitHub issue 号>`、`remote = github#<号>`，GitHub 上该 issue 存在且标题与任务名一致。
2. 模拟 `gh` 未登录/无网络时 `allocate` → 产出 `TMP-*` 号且 stderr 告警；**断言不出现 `cnb#` 形式的号**。
3. `git diff docs/tasks/registry.json` 中既有任务 `task_id` 与 `remote` 字段**零改动**。
4. `npm run validate:task-context` 与 `node scripts/validate-task-spec-sync.mjs` 全绿。
5. 新增单测覆盖：发号成功 / 不可达降级 / 历史字段不变；既有测试套件无新失败。

## 7. 实施要点

- 发号函数须保持**可注入**（参照 CHORE-106 的 `setCnbRunner` 模式），否则单测无法离线断言成功路径。
- `gh issue create` 的输出是 issue URL（形如 `https://github.com/<owner>/<repo>/issues/<N>`），取号用尾段数字，勿依赖 `--json`（该参数在 create 子命令上不可用）。
- 与 `FIX-109` 在 `local-task-merge.mjs` **同文件**改动（FIX-109 动 L237 与收尾回写落账，本票动 L410 提示串）→ 需排先后，避免同文件并行冲突。
- 与 `CHORE-110` 无文件重叠，可并行。

## 8. 风险与处置

| 风险 | 影响 | 处置 |
|---|---|---|
| 号段跳变导致新旧号不连续 | 阅读与检索困惑 | 在登记册保留 `remote` 字段作为平台锚点；文档说明切换日期与号段分界 |
| 误改历史任务字段 | 牵动卡名/分支名/引用 | 单测断言既有任务字段零改动（验收标准 3） |
| 双源并存期撞号 | 两边各发一个同号 | 迁移一次完成，切换后禁止再用 CNB 发号；`allocate` 断言不产出 `cnb#` |
| `gh` 未登录导致静默降级 | 误用 TMP 号当正式号 | 降级时 stderr 明确告警；`allocate` 输出标注 `remote = pending` |

## 9. 未决事项

**0 项。** `DT-01` 历史号段冲突处置口径已于 2026-09-19 裁定为 **A（复用占位号对齐）**，三个占位 issue 的重命名/重开/打标签动作已执行完毕，未决项清零。

本票已可转入「待确认」，待人工确认需求基线 V1 后落档为「本地已定义」并进入施工。
