# LOC-025｜阻止互相矛盾的裁决进入下一质量关口

| 元数据 | 值 |
|---|---|
| 任务标识 | LOC-025 |
| 需求基线版本 | V1 |
| 来源需求 | WR-002 |
| 对应 Issue | 无；本地轨道，GitHub 同步 pending |
| 优先级 | P0 |
| 分类 | bug |
| 体量 | S |
| 前置依赖 | 无 |
| 施工环境组 | LOC-025 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-14T10:05:31Z |
| 准备时间 | 2026-09-14T09:32:27.648693+00:00 |
| 当前状态 | 本地已定义 |
| 源码核验 HEAD | 49ad73a1079bdd556dc18bab081f0bf1aaa54429 |

> 当前“无人值守许可=允许”表示已获本次确认的施工许可；许可仅覆盖已确认范围内施工与验证，不涵盖代签验收、扩大范围或未经授权的对外动作。

## 1. 需求背景

建设 review 的 route/verdict、test 的 route/result 各自合法但可互相矛盾。contradictory-verdict-and-head 复现中，REQUEST_CHANGES 配 APPROVE、FAILED 配 PASS 仍进入 UAT。结构正确不能代表业务判定正确。

来源为[系统评审存档](../../../../docs/research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-2026-09-14.md)。评审证据为源码查阅、195 项相关自动检查与 7 个替身环境复现；不代表真实模型故障频率或产品人工验收。新增规则与数值是本条建议基线，不是已有批准记录。

- [templates/wf-construction-full-feature.json](../../../../templates/wf-construction-full-feature.json:95)
- [templates/wf-construction-full-feature.json](../../../../templates/wf-construction-full-feature.json:150)
- [scripts/generate.mjs](../../../../scripts/generate.mjs:505)

本轮重新核验：contradictory-verdict-and-head：两种矛盾均可进入 WAITING_HUMAN；源码未变。 当前 HEAD 与评审基线之间只更新了既有任务记录，运行代码、模板和角色无差异。`.out-of-scope/` 不存在，未发现本条被正式拒绝的本地记录；GitHub 不可用，未宣称完成远端历史检索。

## 2. 用户问题

建设 review 的 route/verdict、test 的 route/result 各自合法但可互相矛盾。contradictory-verdict-and-head 复现中，REQUEST_CHANGES 配 APPROVE、FAILED 配 PASS 仍进入 UAT。结构正确不能代表业务判定正确。

## 3. 目标

每份专业结论只有一种可解释的路由，失败或矛盾结果不能被当成通过。

## 4. 非目标

只解决裁决一致性及所需角色文案；成果版本核对归 WR-003，通用 Schema 能力声明归 WR-016。

## 5. 修改前

contradictory-verdict-and-head：两种矛盾均可进入 WAITING_HUMAN；源码未变。

## 6. 修改后

每份专业结论只有一种可解释的路由，失败或矛盾结果不能被当成通过。 成功、拒绝、等待、恢复分别有可追溯原因；保持本条未覆盖能力的现有边界。

## 7. 功能范围

建设审核、测试、UAT 的放行行为，以及角色输出与错误提示。

- [templates/wf-construction-full-feature.json](../../../../templates/wf-construction-full-feature.json)
- [scripts/generate.mjs](../../../../scripts/generate.mjs)
- [scripts/validate-core.cjs](../../../../scripts/validate-core.cjs)
- [dsh/roles/review.md](../../../../dsh/roles/review.md)
- [dsh/roles/test.md](../../../../dsh/roles/test.md)

## 8. 不修改范围

只解决裁决一致性及所需角色文案；成果版本核对归 WR-003，通用 Schema 能力声明归 WR-016。

不改 P1/P2 需求、不实施兄弟任务、不修改用户全局技能与 Agent Policy、不清理历史任务现场。实现若需改变已确认的范围/验收，回定义处理变化部分，不能为了测试通过降低标准。

## 9. 业务规则

- V1 保留现有字段以降低迁移风险，增加明确映射：review 的 APPROVE/APPROVE、RETURN_DEV/REQUEST_CHANGES、BLOCKED/COMMENT_ONLY；test 的 PASS/PASSED、RETURN_DEV/FAILED、BLOCKED/BLOCKED。其他组合均为契约错误，不作专业通过判断。COMMENT_ONLY 在此表示无法形成可放行裁决，普通非阻断建议仍随 APPROVE 报告。
- 在路由和 UAT 组装之前执行同一确定性检查；错误携带字段及允许组合。未来去掉重复字段是另行兼容迁移，本条不要求删除。
- 诊断与优化维持现有单裁决字段；探索的完成类型一致性由 WR-010 负责。

**接手者可直接采用的实现边界：**在结构合法之后、route 选择之前调用确定性组合校验；将允许组合及错误路径注册到当前校验器，而非要求模型自己检查。只迁移新生成建设脚本，旧快照行为有明确版本标识。

**接口与数据约定：**建设 review 采用原建议的三对组合：APPROVE/APPROVE、RETURN_DEV/REQUEST_CHANGES、BLOCKED/COMMENT_ONLY；test 为 PASS/PASSED、RETURN_DEV/FAILED、BLOCKED/BLOCKED。仅有非阻断建议且完成审查的 review 仍出 APPROVE；COMMENT_ONLY 不作为质量通过。此含义属于本条待确认的产品规则，不伪装为既有全局语义。

本条拥有建设 review/test 的裁决组合表及路由前语义校验；提供结构化 CONTRACT_INCONSISTENT 错误供 WR-011 分类。

**兼容方式：**新运行使用本条新规则；已启动运行保持其冻结快照。无法补证的旧历史明确 legacy/unverified，不改写成已验证完成。若其他 P0 已合入，复用其公共接口并运行集成检查；没有硬依赖的条目允许通过既有接口完成自身切片，不能自行等待整个需求包。

## 10. 用户操作路径

1. 从本地任务卡读取本规格 V1 与已有批准，执行正式 preflight；独立任务由现有建设入口分配隔离工作区，成员沿用指定组。
2. 在隔离开发环境运行本条样例并观察本条改变的行为。
3. 用户看到实际成果、错误/等待说明和逐项证据；开发与独立审核/测试分别记录。
4. 提交 UAT 卡，保留人工 ACCEPT/REJECT/CONDITIONAL_PASS；本次定义不启动该交付阶段。

## 11. 异常和边界场景

本条各 AC 中的非法输入、失败、版本变化及恢复即必测反例；具体顺序见 §16。输入不满足时不猜测成功，不自动扩大资源/授权；无法执行的真实宿主层明确未验证。读写失败时保留已知事实和恢复定位，不把证据缺失包装为成功。

COMMENT_ONLY 兼容含义须在模板内写明，避免把非阻断建议升级为失败。P0 表示应先于继续宣称自动质量门可靠交付。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 / 当前状态 | 原因 | 依据 |
|---|---|---|---|
| 本轮对象 | 已确认：逐个定义现有 10 个 P0，包含本条 | 用户明确指定 P0 范围 | 2026-09-14 本会话请求 |
| 优先级 | 已确认：P0 | 沿用用户选定优先级 | 同上 |
| 需求基线 V1 | 已确认：按 V1 的具体规则、验收及环境关联 | 用户已确认本 V1 基线 | 本次确认记录 |
| 无人值守许可 | 已确认：允许按确认基线施工至人工验收关口 | 满足现有单任务开工门禁；不授权代签 | 本次确认记录 |

未决产品事项：0。技术路径已明确，没有“施工时再决定”的开放产品选项；内部命名和模块组织由执行者在上述边界内决定。

## 13. 功能切片关系

建设模板两组裁决表和放行校验，错误可用现成夹具稳定复现。 体量为 S，技术路径见 §9，未留下 L 型前置设计迷雾。

原评审编号 WR-002 保留为溯源标识，正式任务为 LOC-025。相关需求只有接口关系；各条独立 UAT 与收口。共享文件改动使用隔离工作区，整合前核对最新已合入行为。

## 14. 前置依赖说明

前置依赖：无

施工环境组：LOC-025；施工环境角色：独立。

本任务无业务硬前置；与其他任务修改同文件只构成合并风险，不新增串行门禁。 当前仅登记环境安排，不创建虚假运行/环境记录，不执行 Git 分支与工作区分配。

## 15. 验收条件

- [ ] AC-01：列出的 6 个合法组合均走预期边；其余 route/verdict 或 route/result 组合全部被拒绝。
- [ ] AC-02：对复现中的两种矛盾分别测试，UAT、人工等待与收口调用数均为 0。
- [ ] AC-03：拒绝原因能区分“契约矛盾”与专业判断“需要修改”；不把矛盾结果存成有效通过证明。
- [ ] AC-04：角色、模板 Schema 和运行时校验对这 6 个组合表述一致；旧字段仍可读取。

这些勾选框代表未来实现验收，当前全部未执行；Definition Check 通过不自动勾选功能验收。

## 16. UAT 场景

### UAT-01 主路径与关键反例

- 验收目的：验证 §3 用户目标与 §15 全部 AC。
- 前置条件：对应候选源码在隔离 worktree；Node.js 24 与所需依赖可用；真实产品模式验证按既有发布规则使用安装产物。
- 操作步骤：分别注入 APPROVE/REQUEST_CHANGES 和 PASS/FAILED，观察后续调用数为 0；再枚举 6 个合法组合和剩余非法组合，核对实际路由。
- 预期结果：正常输入达成目标；非法/缺失/过期输入按 §9 和 AC 拒绝；结果状态、产物和原因一致。
- 人工关注：界面/报告能看懂通过或受阻原因，不把测试替身结果当成用户已经接受。

### UAT-02 恢复与兼容

- 前置条件：保存一个旧快照与一个新规则 Run 的中间状态；仅在隔离环境制造中断。
- 操作步骤：分别恢复旧快照、新运行，再执行一次同请求重放或同内容重读；核对输出与证据。
- 预期结果：旧快照不静默迁移；新运行不丢有效成果、不伪造历史证明；本条涉及的非法条件仍被拦截。
- 证据要求：输出日志/实际产物/状态快照与候选 HEAD；不能只附最终 PASS 字样。

**优先复用的检查入口：**

- [scripts/test/validate-outcome-routing.test.mjs](../../../../scripts/test/validate-outcome-routing.test.mjs)
- [scripts/test/runtime-outcome.test.mjs](../../../../scripts/test/runtime-outcome.test.mjs)
- [scripts/test/ai-task-deliver-m2.test.mjs](../../../../scripts/test/ai-task-deliver-m2.test.mjs)

修改蓝图/生成规则执行 `npm run generate`、`npm run validate`；按风险运行相邻测试。发布时再执行 `npm run release:verify` 与真实产品模式验收，不在定义阶段运行或宣称通过这些实施验收。

## 17. 风险

COMMENT_ONLY 兼容含义须在模板内写明，避免把非阻断建议升级为失败。P0 表示应先于继续宣称自动质量门可靠交付。

GitHub 目前返回 403，本条按本地轨道定义。平台调用/提交/推送/合并遵守实际仓库政策与已有授权；无人值守许可只覆盖已确认范围内施工与验证，不自动涵盖对外发布或代替人工验收。

## 18. 已知限制

- 本轮完成定义准备，不实施上述优化；已有评审复现证明现状缺口，不证明新方案已经通过。
- 基线与无人值守许可已由用户确认；Definition Check 已按确认结果更新。
- 开工脚本属于 M2：技能安装目录不包含该脚本，使用本项目绝对路径 `scripts/ai-task-preflight-check.mjs`；任务登记脚本使用所选技能 assets，已核验与仓库版本相同。
- 本地卡与登记册归入 `docs/tasks/`；详细规格位于受 Git 跟踪的 `docs/tasks/specs/`。另一工作区接手时必须携带同版本规格并核对确认后的摘要；不得因 `.scratch` 被忽略而开工时找不到基线。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-14T09:32:27.648693+00:00 | 由 WR-002 建议转为完整任务规格，补齐接口、UAT、环境、兼容与门禁；已确认基线 V1 | 已确认 |
