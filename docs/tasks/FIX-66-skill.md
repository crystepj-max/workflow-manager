# FIX-66 · 生成 skill 描述句号重复修复

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `FIX-66`（历史编号 `LOC-034`） |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-14 内置工作流技能包入公共池会话（同步四套内置模板技能到 `~/.agents/skills` 时发现） |
| 任务名称 | 生成 skill 描述句号重复修复 |
| 任务类型 | 缺陷修复（Diagnose 规模以下的单点修复） |
| 优先级 | P2 |
| 当前状态 | 交付中 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | FIX-66 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/FIX-66-skill/task-spec-V1.md` |
| 定义时间 | 2026-09-14T22:22:00+08:00 |
| 远端 issue | cnb#66 |

## 摘要（三要素速览）

### 任务目标

修正生成器在拼装 skill 描述时的句号重复缺陷：`scripts/generate.mjs` 的 `skillWrap()` 无条件在蓝图
`description` 之后追加「。」，而蓝图 description 多数已以「。」结尾，导致生成的 `SKILL.md`
frontmatter 出现「。。」；同时 `description` 为空时会留下孤立的「：」分隔符。

### 涉及范围

- `scripts/generate.mjs`：`skillWrap()` 描述拼接归一（剥离尾部句号、空描述不留分隔符）。
- 生成产物：`templates/*.json` 四套内置模板重生成 + `npm run install:builtin-skills:pool` 重装技能包。
- 不改蓝图、不改运行时脚本语义、不改返回状态机。

### 验收标准

1. `templates/*.json` 四套内置模板生成的 `SKILL.md` frontmatter `description` 中不含「。。」。
2. `description` 为空时描述形如 `<displayName>。当用户说『…』…`，不出现「：。」。
3. `npm test` 通过；`npm run validate` 通过（生成物一致性无漂移）。
4. 重装后公共池 `~/.agents/skills/wf-*/SKILL.md` 与重生成结果一致。

## 判定依据

- 触发场景：`node scripts/install-builtin-skills.mjs --pool` 后检查池内 `SKILL.md` frontmatter。
- 证据：池内四套技能包描述均出现「方案设计门。。当用户说」「完成类型。。当用户说」等。
- 定级 P2：纯生成物文案瑕疵，不影响技能触发词、runbook 与运行时行为；但影响 `/` 命令可读性。
