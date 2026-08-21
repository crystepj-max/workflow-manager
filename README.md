# workflow-manager

开发工作流 2.0 · DSH / vwf 统一引擎与模板同步。

## 单一事实源架构

```
templates/<id>.json（蓝图，唯一事实源）
   │  生成器 scripts/generate.mjs（T-IMP-04）
   ▼
.generated/<id>/{script.mjs, vwf-dsl.json, SKILL.md, meta.json}（生成物，gitignore，禁止手改）
   │
   ├─ vwf 入口：packages/dsh-visual-workflow（host.js 双根加载：.generated/ + ~/.dsh/visual-workflow/templates/）
   └─ DSH 入口：生成 skill（触发词 = displayName + id）
```

- **蓝图契约**：`docs/design/blueprint-schema.md`（字段全集 / 校验规则 / 编译语义 / 运行时语义 / 异源规则）。
- **人工只编辑蓝图**：生成物不可手改，改动蓝图后重跑 `npm run generate`（validate 会校验一致性）。
- **新增/修改模板**：vwf 图形保存即落盘 + 同步生成 skill（save 即闭环）；会话内对话式创作见 v2（T-07）。

## 常用命令

```bash
npm run generate   # 遍历 templates/*.json → .generated/<id>/
npm run validate   # 蓝图校验 + 包测试 + 重生成一致性比对
npm test           # 引擎层测试（校验内核/生成器/运行时排练厅场景套件）
```

## 目录

| 路径 | 说明 |
|---|---|
| `templates/` | 蓝图（唯一事实源） |
| `.generated/` | 生成物（gitignore，勿手改） |
| `scripts/` | 单一编译器 / 校验内核 / 运行时排练厅与测试 |
| `packages/dsh-visual-workflow/` | vwf 图形入口插件（Cordis 动态插件） |
| `dsh/` | DSH 侧角色、技能真源 |
| `docs/design/` | 契约与设计文档 |
| `docs/research/` | wayfinder 研究产物 |

## 开发指引

1. 新增工作流：在 `templates/` 写蓝图（按契约）→ `npm run generate` → 用生成 skill 或 vwf 验证。
2. 修改工作流：只改蓝图，重生成；`npm run validate` 保证一致。
3. 实现顺序与任务拆分：`docs/design/v1-task-plan.md`；决策记录：`wayfinder/MAP.md`。
