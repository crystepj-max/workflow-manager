# LOC-009 任务规格（V1）

> 本文件为合并归档机械化的规格副本；权威来源 = 任务卡 `docs/tasks/LOC-009-workspace-registry-policy.md`（该卡声明「本卡三要素即基线」，此处按登记册 slug 约定路径落盘，内容逐字摘录自任务卡，未作任何增改）。

**版本**: V1

## 任务目标

收掉 `docs/design/delivery-93-runtime-integration.md` 列出的三项遗留：① workspace 注册表从临时 `work_root/.vwf-registry/state.json` 升级为正式持久化（随 #79 目录组织，产品 DSH 重启后 workspace / 未释放锁 / 事件可识别恢复）；② `host.js` 的 `mapTemplateId()` 启发式（按模板 id 猜 construction/optimize/diagnose/explore）改为接模板注册表；③ optimize 策略解析所需的 `input.resource_kind` 从模板/运行参数正式传入，不再缺省。

## 涉及范围

- 做：`scripts/workspace-isolation-host.mjs`（注册表持久化与 recovery scan）、`packages/dsh-visual-workflow/src/host.js`（mapTemplateId 替换、resource_kind 传参）、模板侧策略声明字段（如需落蓝图 meta，走字段新增 + 投影双向同步）。
- 不做：Container/Remote Provider；#14/#19 重做；workspace 内核算法变更（`scripts/workspace-isolation.mjs` 语义不动）；四套模板蓝图本身（归 LOC-010~013）。

## 验收标准

- [ ] 产品 DSH 重启后，allocate 过的 workspace 与未释放锁可被 recovery scan 识别，WAITING_HUMAN/PAUSED/BLOCKED Run 的工作区不被清理（E2E）
- [ ] 四类模板 → 隔离策略解析不再依赖 id 名字猜测（模板声明或注册表权威）
- [ ] optimize 按输入 resource_kind 解析 ISOLATED_WRITE（git/files）/ SANDBOX（document/config）E2E 通过
- [ ] 既有 `workspace-isolation` / `runtime-integration-e2e` 测试不改断言全绿；`npm test`、`npm run validate` 全绿

## 权威契约

`docs/design/workspace-isolation.md`（#93 Core 实现契约）+ `docs/design/workspace-isolation/schema.json`；遗留缺口清单见 `docs/design/delivery-93-runtime-integration.md`「留给后续 Issue 的缺口」。
