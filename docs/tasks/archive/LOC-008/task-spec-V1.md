# 任务规格 V1 — LOC-008 Formal Records 运行时集成与证据链落地

- 任务标识：LOC-008（slug: formal-records）
- 基线：V1（2026-09-10）
- 确认依据：用户会话指令「2026-09-11 v0.1 规格差距分析会话：开发计划表 v2（W1）」落卡；任务卡注明「本卡三要素即基线」，本文件为卡内三要素的规格化快照，供合并门禁版本一致性校验。

## 任务目标（Goal）

把已完成的 #78 Formal Records 内核（`scripts/formal-records.mjs`：追加式 Store、覆盖判定、依赖失效、Portable 映射）接入运行时：节点产物自动形成 Record + Revision + 依赖链；verifyBranch 节点（审核/测试）强制签发绑定真实 HEAD 与 Record Revision 的 Proof；多格式产物入库从"写 legacy runs 记录的 formalRecords 字段"升级为走正式 Store。

## 涉及范围（Scope）

做：

1. `packages/dsh-visual-workflow/src/host.js` 新增 records commit/list/get RPC 与持久化（随 #79 logical-runs 目录组织，与运行摘要互相引用）；编译脚本节点收尾处提交 Formal Record 的单一通道（经宿主 RPC，具体形态实施时定——实施裁决：wf_run 完成时宿主侧集中收集）。
2. verifyBranch 节点 Proof 记录 `verified_head` + 所依赖 Record Revision，可经 #78 `coverageStatus` 判 covering/stale。
3. `vwf.artifacts.ingest` 升级走正式 Store（保留旧行为兼容：legacy formalRecords 字段保留，双写）。

不做：

- 探索 targeted 重算编排（归 LOC-013）；Integration Gate 自动编排（归 LOC-017）；UI 呈现（归 LOC-016）。
- `formal-records.mjs` 内核语义变更；`docs/design/formal-records.md` 契约正文修改。

## 验收标准（Acceptance）

1. 产生 Implementation I2 后，依赖 I1 的 RV1/T1 被 `coverageStatus` 判为 `not_covering_current`（旧 Proof 保留不删，标记 stale）。
2. verifyBranch 节点签发的 Proof 记录 workspace / verified_head / Record Revision 绑定；另一 HEAD 的 Proof 不为当前 Revision 背书（E2E 反例）。
3. 节点产物 Record 在产品 DSH 重启后仍可按 logical_run_id 查询（持久化生效）。
4. 既有 `formal-records` / `runtime-host` / `runtime-logical-run` 测试不改断言全绿；`npm test`、`npm run validate` 全绿。

## 实施裁决记录（交付时补充）

- 单一通道落点：编译脚本在 vm 沙箱内仅 5 hooks 无 RPC，Record 提交收敛为宿主侧 wf_run 完成时统一收集提交（review 两轮确认为卡内「具体形态实施时定」授权范围）。
- Proof 绑定：`body_value` 含 node / verified_branch / verified_head / workspace。
- 持久化：一 logical_run_id 一文件（`<records_dir>/<encoded id>.json`），tmp+rename 原子写，重启可冷读。
