# 需求分析摘要 · FIX-235（GitHub #235）

- 分析时间：2026-09-20T15:21:33Z
- 轨道判定：GitHub 可用 → **GitHub 轨道**；需求来源 = GitHub issue #235，发布去向 = 更新该 issue。
- 分析者：ZCode（requirements-analysis skill）

## 1. 分诊

- 分类：`bug`（沿用既有标签 bug + dsh-cordis）；`needs-info` 在落档「已定义」时移除（本会话已补齐其待判定 1/2/3 的全部事实）。
- 冗余性：登记册无 #235 登记、无在途同名修复 → 非重复。
- 关联票：#213（发布验收：Proof 要求与否的口径待其定）；#233（同一 UAT 运行发现，templateId 起跑修复在途——FIX-235 的 UAT 全链以其为前置条件）。
- 阻塞关系：LOC-041 / WR-018 真机未生效；#213 若要求独立 Proof 则全线卡住。优先级 P1。
- 体量：**S**（根因已在故障机实证、修复方向唯一、影响面单一、单会话可完成）。

## 2. 取证与待判定闭合

### 待判定 1：探测为何失败 → 探测代码判定条件不成立（非系统限制）

- `(deny default)` 参考配置在 darwin 25.5.0 上无法运行任何 canary：区内 `/bin/echo` SIGABRT(134)，无 stderr；根因是 dyld 闭包读取（`/usr/lib`、`/private/var/db/dyld`）被 deny → `insideAllowed` 恒 false → 恒 `unavailable`。
- 交替对照 3×3 复测排除偶发；识别并纠正了一处测量伪影（管道 head 吞退出码导致首轮误判「加 /usr/lib 可修复」）。
- 附带缺陷：区外证据实为 exec 拒绝（touch 未获 exec 放行），测错目标；profile 未 realpath，软链 cwd（/tmp → /private/tmp）会误判——均已实证。
- **sandbox-exec 本身可用且能真拒区外写入**：写入范围收紧型 profile 三判定全绿 → `enforced` 可达。

### 待判定 2：降级是否更显眼 → UI 零展示；用户拍板 backlog

- `client.js` 无任何隔离等级/非独立取证渲染；结构化原因在运行记录（`independent_proof_block_reason`）与 Run 产物文本。
- 用户决策：本票只修探测，界面展示登记独立 backlog（2026-09-20）。

### 待判定 3：降级口径 vs 换实现 → 消解

- `enforced` 在故障机实证可达，无需产品拍板降级口径，无需另立设计票。

## 3. 用户决策（2026-09-20）

| 决策 | 选择 | 备选与不选原因 |
|---|---|---|
| 待判定 2 处置 | **A · 只修探测**，UI 展示登记 backlog | B 连带 UI：体量升 M、扩张进 client bundle；修复后 unavailable 成真异常，展示需求弱化 |

## 4. 落档

- 规格：`docs/tasks/specs/FIX-235-node-isolation-probe-fix/task-spec-V1.md`（V1，待确认）
- Definition Check：同目录 `definition-check.md`（全通过，未决产品事项 0）
- Issue：#235 正文更新为「任务基本信息（待确认）+ 三要素 + 根因实证 + 待判定闭合」，带 AI 免责声明，打 `sized-s`
- 待人工确认基线后：registry 登记（FIX-235 / GitHub #235）、打 `ready-for-agent`、去 `needs-info`、Issue 状态改「已定义」、`validate:task-context` 门禁、本地提交（凭授权）
