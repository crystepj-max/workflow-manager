# LOC-009 · Workspace 注册表落盘与模板策略解析收口

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-009` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-11 会话：开发计划表 v2（W1，#93 Runtime Integration 交付说明遗留缺口） |
| 任务名称 | Workspace 注册表落盘与模板策略解析收口 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无（建议与 W2 模板卡 LOC-010~013 同步推进） |
| 施工环境组 | LOC-009 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | 本卡三要素即基线；实施前如需细化，按 Vn→Vn+1 流程升版 |
| 定义时间 | 2026-09-11 |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标

收掉 `docs/design/delivery-93-runtime-integration.md` 列出的三项遗留：① workspace 注册表从临时 `work_root/.vwf-registry/state.json` 升级为正式持久化（随 #79 目录组织，产品 DSH 重启后 workspace / 未释放锁 / 事件可识别恢复）；② `host.js` 的 `mapTemplateId()` 启发式（按模板 id 猜 construction/optimize/diagnose/explore）改为接模板注册表；③ optimize 策略解析所需的 `input.resource_kind` 从模板/运行参数正式传入，不再缺省。

### 涉及范围

- 做：`scripts/workspace-isolation-host.mjs`（注册表持久化与 recovery scan）、`packages/dsh-visual-workflow/src/host.js`（mapTemplateId 替换、resource_kind 传参）、模板侧策略声明字段（如需落蓝图 meta，走字段新增 + 投影双向同步）。
- 不做：Container/Remote Provider；#14/#19 重做；workspace 内核算法变更（`scripts/workspace-isolation.mjs` 语义不动）；四套模板蓝图本身（归 LOC-010~013）。

### 验收标准

- [ ] 产品 DSH 重启后，allocate 过的 workspace 与未释放锁可被 recovery scan 识别，WAITING_HUMAN/PAUSED/BLOCKED Run 的工作区不被清理（E2E）
- [ ] 四类模板 → 隔离策略解析不再依赖 id 名字猜测（模板声明或注册表权威）
- [ ] optimize 按输入 resource_kind 解析 ISOLATED_WRITE（git/files）/ SANDBOX（document/config）E2E 通过
- [ ] 既有 `workspace-isolation` / `runtime-integration-e2e` 测试不改断言全绿；`npm test`、`npm run validate` 全绿

## 详细规格

权威契约：`docs/design/workspace-isolation.md`（#93 Core 实现契约）+ `docs/design/workspace-isolation/schema.json`；遗留缺口清单见 `docs/design/delivery-93-runtime-integration.md`「留给后续 Issue 的缺口」。注册表持久化是 `runTag.workspace_id 仅内存登记` 同族问题的收口。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-11 | 本地已定义 | 基线 V1 经用户会话指令确认（开发计划表 v2 落卡） |
