# R-04 · DSH skill 发现与触发词路由机制

> 调研票 R-04 产物。一手资料：
> - `@deepseek-ai/dsh-skill-filesystem/lib/index.js`（发现根与 frontmatter 解析）
> - `@deepseek-ai/dsh-skill/lib/index.js`（skill 名文法、可调用策略）
> - `@deepseek-ai/dsh-tool-skill/lib/index.js`（skill 工具面、目录语义）
> - 本仓库先例：`dsh/skills/requirements-analysis/SKILL.md`、`dsh/install-skill.sh`、`dsh/install-requirements-analysis.sh`、`dsh/README.md:211-258`

## 1. 发现根（skill-filesystem `roots()`）

默认扫描根（含 project 根自动推导）：

| 根 | 来源 | 说明 |
|---|---|---|
| `<projectRoot>/.dsh/skills` | project-dsh | **点开头**，项目根下 |
| `<projectRoot>/.agents/skills` | project-agents | 同上 |
| `customSkillDirs` | custom | 配置注入 |
| `~/.dsh/skills` | user-dsh | 用户级 |
| `~/.agents/skills` | user-agents | 用户级 |
| bundled | 随包 | 可信 |

**关键结论：仓库的 `dsh/skills/`（无点、二级目录）不是默认发现根**。现有 `requirements-analysis` 之所以在本会话可见，是因为它被 install-requirements-analysis.sh 装到了 `~/.agents/skills/`（README:229-232 明确「公共池真源 = 本仓库 dsh/，改仓库即改全局」）。dev-workflow-2-0 同理（install-skill.sh → `~/.agents/skills/dev-workflow-2-0/`）。

→ 对 FR-2 的含义：生成器把 skill 写进 `dsh/skills/<id>/SKILL.md` 后，**必须配套安装步骤**（仿 install-requirements-analysis.sh 装到 `~/.agents/skills/`，或把仓库根 `.dsh/skills/` 作为项目级发现根直接落地）才可被发现；仅写 `dsh/skills/` 不生效。

## 2. 发现与 frontmatter 格式

- 目录 bundle 形态：`<root>/<name>/SKILL.md`；也支持根下扁平 `.md`。
- frontmatter 必填 `name` + `description`（缺失即忽略并告警）；`name` 须匹配 **kebab-case 文法**（dsh-skill `isSkillName`，如 `requirements-analysis`）；可选 `disable-model-invocation` / `user-invocable`（布尔；旧键 `disableModelInvocation`/`modelInvocable` 被拒绝）。
- 本仓库先例 frontmatter（requirements-analysis）：`name: requirements-analysis` + `description: "…触发词…"`——**别名全在 description 里**（「做需求分析/拆需求/拆任务/出规格/评估需求体量…」）。

## 3. 匹配/触发语义

- 技能目录（catalog）按 `name` + `description` 发布；模型侧由会话系统提示词指示「用户点名 skill 或任务明显匹配其 description 时，用确切名字调用 skill 工具」。
- **无 harness 级别名机制**：匹配键是唯一的 `name`（kebab-case）；「中文名/英文名/别名路由到同一 templateId」只能靠 description 承载（模型语义匹配），或靠会话提示词中的显式映射。
- 用户可直接 `/name` 调用（user-invocable）。

## 4. 会话快照与热刷新

- 会话技能目录是**启动时快照**（README:256-258「新装技能需新会话方可 skill() 调用」）；但 dev-workflow-2-0 打包后「本会话技能目录热刷新后已验证可加载」（README:288-289，DSH 有 `dsh-client-hmr` 机制）——热刷新路径存在但非默认保证。

## 5. FR-6 可行性结论

- **可行，但有前置**：生成 skill 须落在发现根（安装步骤或 `.dsh/skills`），且 name 用 kebab-case 英文 id（如 `dev-workflow-3-0`），中文 displayName + 别名写入 description（沿用 requirements-analysis 先例）；触发路由 = 模型按 description 语义匹配，属「软路由」。
- **硬路由保证**：如果要求「开发工作流3.0」「dev3.0」等词**必达**同一 templateId（AC-6 措辞是「可路由到」），建议额外在 skill 正文/README 给主会话装配指引（如现有 dev-workflow-2-0 的 runbook 模式：SKILL.md 内含 args 装配契约），由 skill 内容保证路由确定性；harness 层面无别名配置可依赖。
- 命名冲突风险：生成 skill 名若与现有技能重名（`dev-workflow-2-0` 已存在！），目录扫描按 rank 合并——同 name 冲突时高 rank 优先（project-dsh > project-agents > custom > user），须在生成器里防重名（建议 id 唯一性校验）。
