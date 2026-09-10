# LOC-001 · 编辑器边判断条件适配业务结果路由

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-001` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-09 会话：询问编辑界面边判断条件是否仍只有成功/失败，若未扩展则结合已完成功能做 UI 交互适配改造 |
| 任务名称 | 编辑器边判断条件适配业务结果路由 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 等待验收 |
| 需求基线版本 | V2 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-001 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `.scratch/LOC-001-edge-outcome-ui/task-spec-V2.md` |
| 定义时间 | 2026-09-09（V2 升版不回拨） |
| GitHub 同步 | 待补 issue |

## 摘要（三要素速览）

### 任务目标

编辑界面的边判断条件如实支持引擎已实现的边定义（业务 outcome / technical / countRound，不只 成功/失败），与节点侧「业务结果路由（outcomePath）」模式联动，往返不损坏数据、画布标注与语义一致。

### 涉及范围

- 做：`packages/dsh-visual-workflow` 内——边类型纯函数与单测、边表单四态、节点判定方式新增「业务结果路由」态、画布标签与配色、i18n、dist 重建。
- 不做：HD 节点/边创作 UI、校验内核与引擎行为变更、枚举覆盖客户端实时检查、`subsequent_effect` 编辑。

### 验收标准

- [ ] 含 outcomePath 节点与 outcome 边的工作流在编辑器中如实回显，表单可查看/编辑 outcome 名与 countRound
- [ ] 类型切换后保存，`on` 与 `outcome` 不并存、废弃字段清理（往返不损坏）
- [ ] technical 边在表单与画布显示「技术重试/重试」，outcome 边标签显示 outcome 名，配色区分
- [ ] 旧模式 success/failure/when 与拖拽新建边（默认 success）行为不回归
- [ ] 旧模式节点误配 outcome 边时，保存校验报错且定位到该边字段
- [ ] zh/en 文案齐全；插件包测试、根目录 `npm test`、`npm run validate`、dist 一致性检查通过

## 详细规格

以 `.scratch/LOC-001-edge-outcome-ui/task-spec-V2.md` 为准（当前基线 V2；V1 规格保留在 `task-spec-V1.md` 供追溯）；决策与事实核查见同目录 `definition-check-V2.md`（V1 检查见 `definition-check.md`）。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-09 | 本地已定义 | 基线 V1 经用户会话指令确认（GitHub 不可用，走本地轨道） |
| 2026-09-09 | 等待验收 | 实施与自动检查完成；存在两处实施偏差与一项护栏调整待追认（见下） |
| 2026-09-10 | 待确认 | 实质需求变更 → 升 **基线 V2**：用户会话反馈 4 条（模式往返丢业务结果路径、`$.field` 门槛过高、路径与边的对应关系不可见、边 outcome 名应改为从节点取值中选）。V2 规格与 Definition Check 已落盘，等待人工确认基线；确认后进入 V2 施工 |
| 2026-09-10 | 本地已定义 | 用户会话确认基线 V2（**本版本属本地轨道，GitHub 恢复后需补建 issue**）；V2 规格 `task-spec-V2.md` + `definition-check-V2.md` 生效，进入 V2 施工 |
| 2026-09-10 | 本地已定义 | V2 功能验证通过（UAT-01~04）；按 UAT 反馈做 **V2 修订**（不升基线）：① 业务结果字段不再展示 `$.` 前缀，帮助文案改为解释该字段作用；② 取值行的取值/图标/操作改为同行不折行 |

## 实施记录（2026-09-09）

- 已实施：`packages/dsh-visual-workflow/src/client.js`（edgeKind/applyEdgeKind/edgeLabelText 顶层纯函数 + 四态边表单 + 业务结果路由节点态 + 画布标签配色 + updateEdge 互斥清理 + schemaField 共享渲染）、`locales/zh.json` `locales/en.json`（新增文案）、`tests/edge-model.test.mjs`（14 例单测 + validate-core 契约）、`tests/static-bundle.test.mjs`（体积闸门常量同步）、dist 重建。
- 自动检查：插件包 205/205 通过；根目录 `npm test` 365/0；`npm run validate` 通过（含 dist 一致性）。
- 体积闸门（用户拍板）：80KB 为**软上限**——超过仅警告不阻断（`scripts/build-bundle.mjs` 已改为 `console.warn` + 继续构建；测试中的字节数硬断言移除，只保留闭包体形态检查）。当前 client 压缩后 82,556 字节，超限 636B，警告可见。
- 实施偏差（规格 V1 微调）：① `edgeLabelWidth` 未作为独立纯函数导出，宽度估算内联在画布（`max(12, 字数×9)`）；② countRound 复选框旁不再内联字段级错误行（保存校验弹窗仍会列出该类问题）。
- 🟡 并行工作线提示：实施期间检测到另一会话对 `src/host.js`、`scripts/validate-core.cjs`、`scripts/projection-core.cjs`、`tests/helpers/load-host.mjs` 有未提交改动，本任务改动与其无文件交集；合并前建议双方确认基线。

## 真实环境验证（2026-09-09，独立开发 DSH）

方式：从 harness 源码树以 `DSH_HOME=~/.dsh-workflow-loc001` 启动独立开发 DSH 实例，新会话中经 cordis_define/cordis_run 动态装载 `vwf-dev-113627e77091`（host = 主工作树 src/host.js + 根常量/Buffer 垫片/注入式 loadDist，client = 主工作树 dist/dynamic/client.js；define 载荷经 md5 逐字节校验）。

实测结果（全部通过）：

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 节点表单第 4 态「业务结果路由（Business Outcome Routing）」出现，路由节点正确落入该态，outcomePath 回显 `$.route`，不显示成功表达式 | ✅ |
| 2 | 边表单四态：PASS 边识别为「业务 outcome」且名称回显 PASS；BLOCK 边 countRound 勾选状态正确回显；technical 自环识别为「技术重试」 | ✅ |
| 3 | 画布标签如实显示：PASS / Retry / BLOCK / Success（失败红、技术重试中性灰、业务与成功蓝） | ✅ |
| 4 | 保存闭环：含 outcomePath 节点 + outcome/technical/countRound 边的图保存成功，模板列表可见可再编辑 | ✅ |
| 5 | 反向拦截：普通节点边切为业务 outcome 后保存被「Workflow cannot be saved」拦截并列出内核边规则错误 | ✅ |

实测发现并当场修复：

- 🔴→✅ i18n 漏键：`routingOutcomePath` / `routingOutcomePathHelp` 未加入 zh/en，字段标签显示原始键名。已补齐并重建 dist（locales 由宿主从磁盘即时供给，无需重新定义动态包），刷新后标签正常。
- 🟡 环境发现：从 harness 源码树启动的 DSH 应用静态管线自带一份旧版 `dsh-visual-workflow/client.js`，与动态包在页面加载时竞争 UI 挂载——刷新页面会回落到静态旧版，需重新激活动态包推送。此为环境特性（共享开发实例同样存在），已由动态包 host 内的共存守卫处理；不属于本任务代码缺陷。

收尾：cordis_stop + cordis_undefine 已清理动态插件（vwf-1 及 pkg-1/2/3 全部移除），独立 DSH 实例进程已停止。

## 真实环境验证（2026-09-10 · LOC-001 基线 V2）

方式：同一独立开发实例（`DSH_HOME=~/.dsh-workflow-loc001`，http://127.0.0.1:55191/），经 `cordis_define`/`cordis_run` 装载薄加载器动态包 `vwf-1`；本轮共 8 个不可变 Package，当前运行 `pkg-8`（`vwf-dev-c2d734ef9afa-loader2`）。

| Package | 内容 |
|---|---|
| pkg-1 | 薄加载器首版（暴露 `Buffer is not defined`：内核经 `new Function` 全局作用域求值，闭包垫片送不到） |
| pkg-2 | 修复：Buffer 垫片安装为 **vm 全局**（归属本 Fiber，停止/更新时还原）+ 嵌套作用域探针 + 内核真实求值探针 |
| pkg-3 | 修复：保存/实时校验的 RPC 异常不再被静默吞掉（弹窗「校验服务不可用」/状态行可见） |
| pkg-4 | 修复：host 校验管道从 `at` 反解 `nodeId`/`edgeIndex`，「关闭弹窗后定位首个问题」真正生效（LOC-001 §5） |
| pkg-5 | 修复：切档不再丢 `output.schema` 与 `files`；「人工验收/无」两档在节点仍持有 `output` 时渲染 schema 输入框 |
| pkg-6 | **V2 全量**：友好参数名 + 取值 `+/-` 参数项 + 边存在性图标/一键补边 + 边 outcome 下拉 + 反向告警 + 删除保护 + 模式往返保留 |
| pkg-7 / pkg-8 | **V2 修订**（UAT 反馈）：去掉 `$.` 前缀展示；取值行改单行不折行；字段作用改为**可见文案**（原先只在 `?` tooltip 内，故用户看不到） |

实测结果：

| # | 项 | 结果 |
|---|---|---|
| 1 | 保存闭环（V1 遗留缺陷） | ✅ 保存成功、未保存标记消失 |
| 2 | 反向拦截（旧模式节点 + outcome/technical 边） | ✅ 弹窗列出真实边错误并**定位到该边字段**（修复前不定位、且多报一条与用户无关的 `output.schema 必填（对象）`） |
| 3 | V2 UAT-01~04（新建路由 / 往返不丢 / 边下拉与自检 / 删除保护） | ✅ 用户会话确认「功能验证通过」 |
| 4 | V2 修订两项（无 `$.` 前缀 + 可见作用说明；取值行同行） | ✅ 待用户复核界面 |
| 5 | 自动检查 | ✅ 插件包 235/235（含新增 `tests/routing-model.test.mjs` 9 例，其中含「UI 写出的形态内核必须接受 / 枚举缺边必须被点名」防漂移契约）；根 `npm run validate` 全绿；`check:dist` 一致 |
| 6 | 运行态核对（`vwfp_diag`） | ✅ `hostSrcLen=112266`（= 主树 src/host.js）、`clientReport.length=92637` 字符（92820 B，与 `dist/dynamic/client.js` 逐字节一致）、`bufferGlobalInstalled=true`、`nestedByteLength=2`、`kernelProbe.ok=true` |

可复用的复现手法（临时脚本已随收尾清理，按此可在数分钟内重建）：

1. **动态沙箱缺 Buffer**：`node:vm` 造 context（只给 `console`/`TextEncoder`，**不给 Buffer**）→ 在该 context 内 `new Function('module','exports', src)(module, module.exports)` 求值 `dist/validate-core.cjs` → 调 `validateBlueprint({nodes:[{id:'n',goal:'x'}]})` 即复现 `Buffer is not defined`（路径 `validateBlueprint → compileInputSizeViolation → escapedJsonBytes`）；把 TextEncoder 垫片挂成 context 全局后同一调用通过，且 `Buffer.byteLength(JSON.stringify(v))` 与真 Buffer 口径一致。
2. **弹窗文案与定位坐标**：用 `packages/dsh-visual-workflow/tests/helpers/load-host.mjs` 的 `loadHost()` 取 `vwf.validate` handler，喂目标 DSL，打印 `errors[].{at, fieldKey, nodeId, edgeIndex}`，并按客户端 `closeValidationDialog` 的判定（`nodeId || nodeIds?.length || edgeIndex !== undefined`）算「可定位」真值。
3. **蓝图三层校验**：`scripts/validate-core.cjs` 的 `validateBlueprint`（蓝图）+ `projectToVwf`/`projectToBlueprint`（DSL 往返）三层联跑，用于确认「编辑器写出的形态内核确实接受」。

## 交接（2026-09-10）

- 本任务**尚未验收/收尾**：验收、验收卡与合并/PR 由后续 agent 依 `/construction-bootstrap` 或仓库收尾流程执行。
- 🟡 **并行工作线（务必区分归属）**：本任务实施期间，同一工作树内还有另一条线在活动——`README.md` 被改写、新建 `docs/tasks/LOC-008`~`LOC-018` 共 11 张任务卡。**这些与 LOC-001 无关**。属本任务的改动仅限以下路径：
  - `packages/dsh-visual-workflow/src/client.js`（V1 schema 缺陷修复 + V2 全量 + 两处 UAT 修订）
  - `packages/dsh-visual-workflow/locales/zh.json`、`locales/en.json`（新增文案）
  - `packages/dsh-visual-workflow/tests/routing-model.test.mjs`（新增 9 例）
  - `docs/tasks/LOC-001-edge-outcome-ui.md`（本卡）
  - `docs/tasks/registry.json` + `docs/tasks/BOARD.md` 中 **仅 LOC-001 的条目**（这两个文件是多线共用的生成物，其余条目归各自的线）
- 动态开发态仍在运行（`vwf-1` / `pkg-8`）：收尾时应 `cordis_stop`（保留 Package 与授权，可一键恢复）；开发阶段整体结束或转产品验收时再 `cordis_undefine`。**动态开发态不是发布证据**，PR/Release 前须关开发 DSH、重启产品 DSH 并从真实安装路径验证正式 `dsh-visual-workflow` 组合包。
- 本轮临时调查脚手架（`.scratch/dev-bug-repro/`、`.scratch/routing-demo/`）**未删除成功**：harness 的 safe-delete 守卫改走系统 Trash 失败（`FSMoveObjectToTrashSync status -5000`，拒绝对外删除，fail-closed），已放弃绕过。两者均在 `.gitignore`（`.scratch/`）内，不影响构建/测试/运行与提交；可复用的证据已内联于上一节，故这两个目录可随时由人工删除（Finder 或普通终端 `rm -rf`）。
- 示例模板 `outcome-routing-demo` 在开发 Home 内（`~/.dsh-workflow-loc001/visual-workflow/templates/`，用户保存时同步生成了 `~/.dsh-workflow-loc001/skills/outcome-routing-demo/`），不属仓库资产；不想要可在「模板库」删除模板（连带删 skill）。

