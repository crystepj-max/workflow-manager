# LOC-039｜声明协议版本与可执行的 Schema 能力：任务规格 V1

> V1 基线已于 2026-09-16 获人工确认（确认记录见 §12）；本轮只完成定义落档，不启动开发。无业务硬前置。

| 元数据 | 值 |
|---|---|
| 任务标识 | LOC-039 |
| 需求来源 | 本地文档 |
| 来源定位 | docs/research/workflow-review-requirements-2026-09-14/WR-016.md |
| 任务名称 | 声明协议版本与可执行的 Schema 能力 |
| 任务类型 | 完整功能开发 |
| 分类 | enhancement |
| 体量 | M |
| 优先级 | P1 |
| 当前状态 | 本地已定义 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-039 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | docs/tasks/specs/LOC-039-protocol-capabilities/task-spec-V1.md |
| 定义时间 | 2026-09-16T10:24:12Z |
| GitHub 同步 | pending |

## 1. 需求背景

来源：工程实践：契约优先与版本兼容；最小通用协议。运行测试 helper 仅落实 type/oneOf/properties/required/additionalProperties/items/enum/const；Portable 校验器支持更多关键字。当前四模板没有统一的协议版本标记，不能假称已有字段可复用。

原评审基线为 `8e38d74955c67f0f196c93eb880cfef7cce71cbd`；本轮实际检查 `775ac84e9c37e2278c2ee32a0f2bcb75cbbb8172`，main 另有 LOC-023 状态文档提交。评审建议、当前实现和本 V1 目标分别记录，不混用。

相关参考资料：

- [WR-016 原始需求](../../../research/workflow-review-requirements-2026-09-14/WR-016.md)
- [系统评审](../../../research/workflow-review-requirements-2026-09-14/evidence/workflow-design-review-2026-09-14.md)
- [本轮现状核验与边界](../../p1-definition-evidence-2026-09-15.md)
- [scripts/validate-core.cjs](../../../../scripts/validate-core.cjs)
- [scripts/generate.mjs](../../../../scripts/generate.mjs)
- [scripts/projection-core.cjs](../../../../scripts/projection-core.cjs)
- [scripts/cwf-validate.mjs](../../../../scripts/cwf-validate.mjs)
- [docs/design/blueprint-schema.md](../../../design/blueprint-schema.md)
- [JSON Schema 2020-12 Validation](https://json-schema.org/draft/2020-12/json-schema-validation)

## 2. 用户问题

作者写了看似标准的 Schema，系统可能默默忽略约束；不同入口各自理解协议，兼容失败要到执行时才发现。

## 3. 目标

模板作者知道当前确实支持什么；未知约束和不兼容版本在代理启动前被拒绝，旧 Run 仍按冻结契约恢复。

可观察完成标准为 §15 的四项 AC 和 §16 四组操作场景，逐项提供真实结果；实现、机器验证与人工验收分别记录。

## 4. 非目标

不实现完整 JSON Schema 2020-12、不合并 Portable 与 Blueprint 两套领域 payload、不联网解析远程 $ref、不因 P0 尚未实现伪造字段。

## 5. 修改前

运行测试 helper 仅落实 type/oneOf/properties/required/additionalProperties/items/enum/const；Portable 校验器支持更多关键字。当前四模板没有统一的协议版本标记，不能假称已有字段可复用。

## 6. 修改后

模板作者知道当前确实支持什么；未知约束和不兼容版本在代理启动前被拒绝，旧 Run 仍按冻结契约恢复。 蓝图导入/编辑、编译校验、运行兼容与模板作者收到的诊断。

## 7. 功能范围

有限 Schema 能力矩阵、共享结构校验语义、Blueprint 协议标记与投影保留、最小运行信封、版本兼容和模板迁移。

关联模块：

- [scripts/validate-core.cjs](../../../../scripts/validate-core.cjs)
- [scripts/generate.mjs](../../../../scripts/generate.mjs)
- [scripts/projection-core.cjs](../../../../scripts/projection-core.cjs)
- [scripts/cwf-validate.mjs](../../../../scripts/cwf-validate.mjs)
- [docs/design/blueprint-schema.md](../../../design/blueprint-schema.md)

影响对象：蓝图导入/编辑、编译校验、运行兼容与模板作者收到的诊断。 优先级 P1：在错误放行类 P0 后补齐可靠协作、维护与运行保障；无硬前置者不必等待全部 P0。

## 8. 不修改范围

不实现完整 JSON Schema 2020-12、不合并 Portable 与 Blueprint 两套领域 payload、不联网解析远程 $ref、不因 P0 尚未实现伪造字段。 不修改其他任务的基线和验收结论，不迁移用户凭据，不安装全局角色副本。

## 9. 业务规则

1. 新增可选 protocol={version:"1.0",required_capabilities:[]} 标记；缺失按 legacy-unversioned 兼容读取并明确标识，新内置模板迁移到 1.0。未知主版本、未实现的必需 capability 在 agent 调用前拒绝；minor 仅在声明能力均满足时接受。
2. Blueprint 1.0 执行关键字精确集合：type、enum、const、properties、required、additionalProperties、items、minItems、maxItems、minLength、maxLength、minimum、maximum、pattern、oneOf、anyOf、allOf、not、if、then、else。type 支持标准七类型及类型数组，数字仅有限值；items 仅单 schema。未列出的执行关键字（含 $ref、format、uniqueItems、unevaluatedProperties）拒绝。
3. 允许注释关键字 title、description、$comment、examples、default、$schema，不把注释当校验；$schema 仅标识有限子集所参照方言，不能借此宣称全标准。正则按 JavaScript Unicode 模式，字符串长度按 Unicode code point；oneOf 恰好一个，anyOf 至少一个，if/then/else 按匹配分支执行。
4. 静态阶段验证 Schema 本身及声明能力，运行阶段对实例使用同一语义；每个执行关键字都需合法/非法对照。Portable 保留其现有 $ref 等契约与校验入口，能力矩阵逐体系列明，不因 Blueprint 收紧而破坏旧 Portable 包。
5. 信封最小包含协议版本、Run/节点、宿主调用标识、冻结模板/脚本摘要、实际模型标识、输入/输出引用及决定引用。领域输出置 payload，缺当前可观测信息显式 null/unavailable，未有持久 attempt 时不得把调用标识冒充 LOC-029 attempt。
6. 启动冻结协议与能力快照；旧 Run 恢复原脚本/协议，不注入最新模板文本。旧无版本模板沿旧入口可读，新编辑保存须通过相应显式能力检查。

输入输出和归属：本条拥有 protocol 标记、Schema 子集矩阵与 envelope 外壳；LOC-024/029/032 后续分别提供真实输入、attempt 和动作引用。projection-core 及生成器透传版本，四模板声明实际用到的能力，不预先声明未实现能力。

## 10. 用户操作路径

1. 执行者读取任务卡与本规格，确认 V1 已获批准；记录当前分支/HEAD 并核对相对本轮检查基线的变化。
2. 使用本任务独立环境，按已有单任务工作流开工；没有业务硬前置。
3. 按 §7–9 实现本条完整能力，以 §16 的固定场景验证成功和失败路径。
4. 呈递逐项 AC、实际证据、候选版本与限制，到人工验收关口等待；不代签或自行进入发布。

## 11. 异常和边界场景

- **逐关键字对照**：建立每个声明执行关键字至少一组合法和非法数据及边界组合。 处理结果必须为：两入口对相同约束语义一致，非法实例在进入消费者前被拒绝，并有字段路径。
- **不支持即提前阻断**：准备拼错关键字、format、远程 $ref、协议 2.0、缺 capability 及合法 description。 处理结果必须为：不支持项调用为零并可定位，注释字段不误阻断。
- **各契约独立**：使用四内置模板、一个项目模板及既有 Portable 样例。 处理结果必须为：protocol 不丢失，Blueprint 不默默套 Portable 能力，Portable 现有 $ref 样例仍有效。
- **冻结恢复与信封**：以旧脚本创建暂停 Run；升级模板协议后恢复。 处理结果必须为：旧 Run 使用原快照，来源可追溯；不可观测字段明确 unavailable，不伪造历史 attempt。

共同恢复规则：证据不足写 BLOCKED/UNVERIFIED 并保留失败输入、恢复位置；同一原因重试不改变基线，不因无人值守降低验收。旧 Run 使用冻结快照；范围外变化另行记录，不静默迁移历史。

## 12. 已确认的关键决策及原因

以下决策已于 2026-09-16 获用户（本会话）确认；确认依据为用户在需求确认会话中的明确选择，不是提案代签。

| 决策主题 | 已确认方案 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| D-LOC-039：V1 产品规则及范围 | 接受明确有限的 1.0 子集、未知执行关键字提前拒绝、旧 Run 冻结兼容；不宣称完整 JSON Schema 支持。 | 作者写了看似标准的 Schema，系统可能默默忽略约束；不同入口各自理解协议，兼容失败要到执行时才发现。 | 用户（本会话） | 2026-09-16 |
| D-BATCH：环境与施工许可 | 独立环境组 LOC-039；确认后允许无人值守施工至人工验收关口，候选并发 1；本轮只落档定义，不启动开发 | 可隔离施工，保留真实人工关口；与现行仓库规则（唯一开发实例 9527、按 Run 命名空间隔离）一致 | 用户（本会话） | 2026-09-16（P1 批共享确认，一次适用 LOC-034–043） |

未决产品事项：0。没有留给施工中临时决定的产品分支。确认对象原文见 [本批确认单](../../p1-definition-confirmation-2026-09-15.md)。

## 13. 功能切片关系

- 本切片：模板作者知道当前确实支持什么；未知约束和不兼容版本在代理启动前被拒绝，旧 Run 仍按冻结契约恢复。
- 体量 M；规则、实现和验证围绕同一用户能力，§16 可独立 UAT，不按内部接口层拆成无法单独验收的任务。
- 兄弟条目负责其他领域能力；共改 host/generate/templates 只构成合并冲突风险，不据此新增业务依赖。

## 14. 前置依赖说明

```text
前置依赖：无
```

无。可以在当前输出结构上添加协议外壳与校验，缺少后续元数据用明确不可用值；不依赖所有 P0 功能上线。

关联接口已列于 §9，关联不等于硬依赖。

环境安排（D-BATCH 已确认，2026-09-16）：独立工作区和环境组 `LOC-039`，开发分支默认 `codex/loc-039-protocol-capabilities`。不加入 P0 已批准的环境组，也不复用其待验收候选。对于跨组依赖，由执行者先从登记册核对真实合入 commit，再验证 `git merge-base --is-ancestor <前置合入commit> HEAD`；缺证据一律受阻。当前单任务独立环境规划器不自动核验这类跨组依赖，不能仅凭其返回 create 就放行。

启动前读取当前仓库 AGENTS.md、单任务 runbook 和环境登记；Node.js 24，首次缺依赖时 npm install。建设 Run 的 DSH 资源按当前环境分配器实际记录使用；本批按 D-BATCH 确认采用当前 runbook 的共享宿主/独立 Run 命名空间，与现行 AGENTS 的唯一开发实例 9527 约定一致。此前不操作 DSH；不复制旧任务 Home、不重启其他 Run 的 DSH。每任务 namespace/cache 与资源记录独立；开发 DSH 固定端口共享且同时只有一个活跃插件。执行前检查槽位；其他任务活跃时等待或受阻，不调用会抢占重启的 start。候选默认并发 1，凭据只引用已配置 Profile，不自动复制。

当前批量工具只接纳无依赖任务；本任务确认后可作为独立候选，仍需执行时重新做资格/环境检查。 本轮不创建 Run 或开发环境。

## 15. 验收条件

- [ ] AC-01：对全部声明支持关键字提供至少一个合法和一个非法值，静态/运行时结论一致。
- [ ] AC-02：未知关键字、未来主版本、缺少必需能力均在代理调用前拒绝并给出路径；注释字段不误阻断。
- [ ] AC-03：四模板生成、投影往返及 Portable 样例分别按其真实契约验证，不把不同 Schema 体系误当同一协议。
- [ ] AC-04：旧 Run 恢复仍用原快照；新增协议字段可追溯生产者和消费方，领域 payload 没有被统一成大而全结构。

对源条目歧义的收敛以 §9 明文规则为 V1 提案，须经 §12 确认。交付必须逐条填写 AC 实际结果与证据，不得用一个总 PASS 替代。

## 16. UAT 场景

### UAT-01 逐关键字对照

- 对应：AC-01。
- 验收目的：检查逐关键字对照的用户可见行为。
- 前置条件：建立每个声明执行关键字至少一组合法和非法数据及边界组合。
- 操作步骤：通过编译入口检查 schema，再在实际运行校验入口提交两类实例。
- 预期结果：两入口对相同约束语义一致，非法实例在进入消费者前被拒绝，并有字段路径。
- 凭证：保存本次输入、命令或操作、实际输出与关联 Run/候选标识；将预期和实际逐项比较，不只截取最终状态。
- 人工关注：结果可读、原因准确、未执行层没有被标为通过。

### UAT-02 不支持即提前阻断

- 对应：AC-02。
- 验收目的：检查不支持即提前阻断的用户可见行为。
- 前置条件：准备拼错关键字、format、远程 $ref、协议 2.0、缺 capability 及合法 description。
- 操作步骤：分别导入/编译/启动并统计代理调用。
- 预期结果：不支持项调用为零并可定位，注释字段不误阻断。
- 凭证：保存本次输入、命令或操作、实际输出与关联 Run/候选标识；将预期和实际逐项比较，不只截取最终状态。
- 人工关注：结果可读、原因准确、未执行层没有被标为通过。

### UAT-03 各契约独立

- 对应：AC-03。
- 验收目的：检查各契约独立的用户可见行为。
- 前置条件：使用四内置模板、一个项目模板及既有 Portable 样例。
- 操作步骤：生成、投影往返、分别按正确体系校验。
- 预期结果：protocol 不丢失，Blueprint 不默默套 Portable 能力，Portable 现有 $ref 样例仍有效。
- 凭证：保存本次输入、命令或操作、实际输出与关联 Run/候选标识；将预期和实际逐项比较，不只截取最终状态。
- 人工关注：结果可读、原因准确、未执行层没有被标为通过。

### UAT-04 冻结恢复与信封

- 对应：AC-04。
- 验收目的：检查冻结恢复与信封的用户可见行为。
- 前置条件：以旧脚本创建暂停 Run；升级模板协议后恢复。
- 操作步骤：对比恢复脚本摘要与输入/输出信封。
- 预期结果：旧 Run 使用原快照，来源可追溯；不可观测字段明确 unavailable，不伪造历史 attempt。
- 凭证：保存本次输入、命令或操作、实际输出与关联 Run/候选标识；将预期和实际逐项比较，不只截取最终状态。
- 人工关注：结果可读、原因准确、未执行层没有被标为通过。

验证安排：先建立能捕捉实际故障的相关检查，再修改范围内实现。蓝图/生成规则变化运行 `npm run generate` 和 `npm run validate`；其他改动运行相邻模块必要测试。仅文档变化检查事实、链接与生成一致性。发布所需 `npm run release:verify`、产品 DSH 重启与真实 E2E 按原项目关口执行，机器通过不等于发布或人工验收。

## 17. 风险

原先被忽略的拼写错误/关键字会导致新建或保存失败；错误需包含 Schema 路径和不支持的能力，避免静默改变含义。

并行变更触及共享文件时合并后重跑直接相关检查；如改变已确认用户行为，先提出差异版，保留其他既有批准，不自行扩写基线。

## 18. 已知限制

不实现完整 JSON Schema 2020-12、不合并 Portable 与 Blueprint 两套领域 payload、不联网解析远程 $ref、不因 P0 尚未实现伪造字段。 本轮仅完成定义落档，未实现本条、未运行本条目标 UAT。GitHub 访问 403，正式载具为本地卡片与登记册；CNB 只承载 Git 同步，不作为任务定义状态来源。定义材料已入库 main（提交 ece5bf6）；本轮确认后的落档改动待后续授权提交。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 候选 | 2026-09-15 | 从 WR-016 收敛范围、边界、依赖、四项 AC 与四组 UAT，等待批准 | 未确认 |
| V1 | 2026-09-16 | 基线与 D-BATCH 施工许可获人工确认；未决清零，卡片/登记册同步为本地已定义 | 用户（本会话） |
