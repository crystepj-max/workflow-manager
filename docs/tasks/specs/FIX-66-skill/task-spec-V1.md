# FIX-66 · 生成 skill 描述句号重复修复 · 任务规格 V1

> 历史编号：`LOC-034`（本地号，已并入 `FIX-66`）
> 需求基线：V1 ｜ 来源：会话录入 ｜ 远端：CNB issue #66

## 1. 问题现象

`scripts/generate.mjs` 的 `skillWrap()` 在拼装 `SKILL.md` frontmatter 的 `description` 时，
无条件在蓝图 `description` 之后追加「。」。而 `templates/*.json` 四套内置模板的
`description` 本身已以「。」结尾，导致生成物出现「。。」。

同时，当蓝图 `description` 为空时，拼接逻辑仍会保留「：」分隔符，产出孤立的「：。」。

## 2. 实测证据

触发场景：`node scripts/install-builtin-skills.mjs --pool` 后检查池内 `SKILL.md` frontmatter。

- 四套内置模板技能包描述均出现「方案设计门。。当用户说」「完成类型。。当用户说」等重复句号。
- 影响面：`/` 命令菜单可读性。

## 3. 涉及范围

- `scripts/generate.mjs`：`skillWrap()` 描述拼接归一。
- 生成产物：`templates/*.json` 四套内置模板重生成 + `npm run install:builtin-skills:pool` 重装技能包。

明确不改：

- 不改蓝图 `templates/*.json`；
- 不改 `script.mjs` / `meta.json`，运行时语义零变化；
- 不改返回状态机。

## 4. 方案

1. 拼接前剥离 `description` 尾部句末标点（`。．.`）；
2. 归一后若为空，则省略「：」分隔符，描述段退化为 `displayName`。

## 5. 验收标准

1. 四套内置模板生成的 `SKILL.md` frontmatter `description` 中不含「。。」；
2. `description` 为空时描述形如 `<displayName>。当用户说『…』…`，不出现「：。」；
3. 无结尾句号分支正确补一个句号；
4. `npm test` 通过（无新增回归）；
5. 重装后公共池 `~/.agents/skills/wf-*/SKILL.md` 与重生成结果一致。

## 6. 定级

P2：纯生成物文案瑕疵，不影响技能触发词、runbook 与运行时行为；但影响 `/` 命令可读性。
