---
id: T-02
title: 生成器编译策略
type: prototype
labels: [wayfinder:prototype]
status: closed
assignee: charting-session-2026-08-19
blocked-by: [R-02, R-03]
resolved: 2026-08-19（原型验证完成 + 用户决策 S1-S4 全部采纳推荐）
---

## Question

生成器（FR-2）如何从蓝图产出双入口？核心选择：DSH 侧是**复用 vwf 的 `compileDsl`**（已证实其产物可被普通 `workflow` 工具直接执行，host.js:581 回退路径），还是**独立 codegen**（按规格字面「编译蓝图→mjs 脚本」），还是混合？

## 已知约束

- 规格 FR-2：生成 vwf 注册（目录加载，废除 host.js:29-74 硬编码）+ DSH skill 包装（`dsh/skills/<id>/SKILL.md` + 薄 runner）；生成须**幂等、可重跑**；生成物受 NFR-1 约束（不可手改、gitignore）。
- R-02/R-03 产物给出 compileDsl 的能力边界与 workflow 工具契约——若 vwf 编译器已覆盖蓝图全部语义，DSH 侧只需 skill 包装 + args 装配，FR-2 体量显著缩小；若不够（如 entry/续跑、多任务隔离等 DSH 特有语义），需确定补丁层位置（生成器内特例 vs 编译器扩展 vs 蓝图扩展）。
- 幂等性保障手段（diff 比对重生成？哈希？）也在此票定。

## 产物

- 编译策略决策 + 理由（对照 R-02/R-03 事实）。
- 生成器结构草案（入口命令、目录遍历、产物布局、幂等机制、失败模式）。
- 原型：对一个最小蓝图跑通「蓝图 → 双入口 → workflow 工具可执行」链路。

## 备注

HITL：prototype 票，产出可运行的最小链路供评审。

## Resolution（2026-08-19）

**原型**：`.scratch/generator-prototype/`（generator.mjs + 2 蓝图 + out/ 四件套 + README；冒烟/幂等均通过）。
**决策（用户 S1-S4 全部采纳推荐）**：① **S1 单编译器**——复用 compileDsl 语义（移植为纯函数）+ 增强编译选项（route 折叠/超限归因/verified 闸门/异源警告/files 注入/noRole），避免双语义漂移；② **S2 生成物 gitignore 区** + 重生成（NFR-1 默认，与 T-04 决策一致）；③ **S3 幂等 = 重生成 diff 比对**（validate 集成，原型已验证 identical）；④ **S4 根 package.json `scripts.generate`** + CLI（FR-4 联动）。
**验证结论**：全量 2.0 蓝图编译通过（route 折叠识别 ✅）；引擎真实运行生成脚本 2 次（脚本编译/主循环/状态机/失败路径全按契约 ✅）；端到端 DONE 未达成 = 本会话子代理基础设施故障（对照实验确认，非脚本缺陷），恢复后复验；模型绑定编译期固化进脚本（运行时 args 不再传 models，skill runbook 已注明）；修掉 autoReschedule 死代码。
**产物契约**：`out/<id>/{script.mjs, vwf-dsl.json, SKILL.md, meta.json}`；vwf-dsl.json 可直接喂 validateDsl/compileDsl。
