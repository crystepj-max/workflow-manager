# 需求分析摘要 · FIX-234（GitHub #234）

- 分析时间：2026-09-20T14:54:35Z
- 轨道判定：GitHub 可用 → **GitHub 轨道**；需求来源 = GitHub issue #234，发布去向 = 更新该 issue。
- 分析者：ZCode（requirements-analysis skill）

## 1. 分诊

- 分类：`bug`（沿用既有标签 bug；chore 标签保留作闸门段性质标注，分类标签以 bug 为准）。
- 冗余性：登记册无 #234 登记、无在途同名修复 → 非重复。
- 关联票：#233（同源 UAT 发现，形态误判 bug，已定义 FIX-233）；两票边界已在双方规格中互引。
- 阻塞关系：#213 前置；与 FIX-233 叠加导致「四套模板产品模式入口级验收」无法进行。优先级 P1。
- 体量：**M**（两片：默认值修复 / 闸门段，各自可独立 UAT；方案 A 下闸门段有实质施工量）。

## 2. 取证与根因修正

1. **「LOC-019 漏网」定性不成立**：`f410900`（2026-09-13）提交信息明确「验证角色（收敛审查/审核/测试/回归验证/评估）→ deepseek-v4-flash」，四套模板全量覆盖且映射表测试逐一断言。evaluate 不是漏网，是当时的有意选择。
2. **真实根因**：其后用户删除 v4-pro / v4-flash 配置（时间点不可考、亦无需考），配置漂移静默发生；仓库无任何「模板默认绑定 vs 当前可用模型」机器核对，直至 2026-09-20 真机起跑（`MODEL_NOT_CONFIGURED` → #74 探针 BLOCKED）才暴露。
3. **过期面实测（修正票面「仅 evaluate」）**：四套蓝图 `bindings.models` 全量枚举——6 个验证角色节点绑 `deepseek-v4-flash`（construction review/test；diagnose review/regression；explore evaluate；optimize evaluate）；其余 11 节点 `deepseek-flash` 真机有效。「新环境开箱即不可运行」成立且影响 4/4 套。
4. **事实源约束（闸门设计前提）**：`deepseek-official` 模型目录无磁盘配置文件（settings.yaml / storages / reverse-proxy 均非），权威源在产品 DSH 运行时 llm 服务（`listProviders/listModels`；vwf 宿主 `src/host.js:1159-1199` 运行前探针同口径判定 `MODEL_NOT_CONFIGURED`）。由此，纯仓库侧 CI 无法感知配置漂移，闸门只能双层。

## 3. 用户决策（2026-09-20）

| 决策 | 选择 | 备选与不选原因 |
|---|---|---|
| 闸门方案 | **A · 双层闸门**（仓库映射表测试 + release:verify 检查段：DSH 可达逐节点核对 / 不可达显式跳过） | B 仅仓库清单：第二事实源自身会漂移，本 bug 教训重演；C 仅运行时提示：不满足票面「可核对产物」，CI 不拦截 |
| 验证角色新默认 | **`deepseek-v4.1-flash`** | B 全部 `deepseek-flash`：验证/执行异模型两层设计与弱异源语义退化为无 |

## 4. 落档

- 规格：`docs/tasks/specs/FIX-234-template-default-model-gate/task-spec-V1.md`（V1，待确认）
- Definition Check：同目录 `definition-check.md`（全通过，未决产品事项 0）
- Issue：#234 正文更新为「任务基本信息（待确认）+ 三要素 + 根因修正 + 决策记录」，带 AI 免责声明，打 `sized-m`
- 待人工确认基线后：registry 登记（FIX-234 / GitHub #234）、打 `ready-for-agent`、Issue 状态改「已定义」、`validate:task-context` 门禁、本地提交（凭授权）
