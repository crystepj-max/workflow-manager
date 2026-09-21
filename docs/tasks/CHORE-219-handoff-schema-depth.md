# CHORE-219 · 本地任务卡

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `CHORE-219`（前草稿号 `TMP-chrisdem-260919h`） |
| 远端 issue | GitHub #219（编号由 GitHub 远端发号，引用 #123） |
| 需求来源 | GitHub #123 余项（2026-09-19 独立开工会话盘点复核） |
| 来源定位 | https://github.com/crystepj-max/workflow-manager/issues/123 第 2 条遗留事项 |
| 任务名称 | handoff 交接包 schema 深度加固：版本号格式与内容文本下限 |
| 任务类型 | 维护性 / 契约口径（编号类型 CHORE） |
| 优先级 | P2 |
| 当前状态 | 待确认 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | CHORE-219 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `docs/tasks/specs/CHORE-219-handoff-schema-depth/task-spec-V1.md`（入库） |
| 定义时间 | 待人工确认 |
| GitHub 同步 | synced#219 |

> 说明（不进机器解析字段）：`无人值守许可 = 允许` 的依据是四项产品口径已由松哥 2026-09-19 裁定（规格 §12），施工阶段无需再向人求决。
>
> **草稿号沿革**：`tmpId()` 只按登记册已有号避让，看不见并行会话尚未登记的同日草稿，本卡最初取到 `260919d` 后与并行会话的 `260919d-custom-role-freeze` 撞号，遂整体迁至 h/i/j 高字母段。迁入 h 之前，本卡曾以 `TMP-chrisdem-260919a` 一次性写入 `registry.json`，该条目（`remote: pending`）会让 `validate:task-context` 报「缺少远端 issue 号」，**已核对身份后单条撤回**（未影响他人任何条目，登记册相对 HEAD 无丢失项）。正式号于 2026-09-19 经松哥授权在 GitHub 补建（Auto 权限模式下 `gh issue create` 两次被分类器拦截，切手动批准后成功），卡面与登记册已按同一条目对齐。

## 摘要（三要素速览）

### 任务目标

让 `handoff.schema.json` 能挡住空壳证据：版本号字段有格式、内容性文本有下限，使 `cwf-record` 在落盘前就拒掉「不成版本、没说出内容」的记录。

### 涉及范围

- 做：`baseline_revision` 版本格式；21 个内容字段按正文≥8 / 要素≥4 挂下限；`record_version` 升 v0.1.9 并同步 7 份示例（不前移示例链 HEAD）；契约 §8.3 与变更史；3 个测试文件的单字符占位夹具改为可用长度；每条约束一个负例先行。
- 不做：`acceptance_package.assembled` 必填引用结构（CHORE-110 题域）；跨字段时间序（schema 无法表达，转片 2）；引擎判定逻辑；`nonEmptyText`/`isoDateTime` 语义；历史归档记录。

### 验收标准

V-1~V-9（规格 §15）：非法版本号与空壳文本「加固前先红、加固后被拒」；`V1`/`v1`/`V1.2` 与真实长度通过；4/3 字符边界；契约 §8.4 ajv-cli 对 7 示例全绿；`npm test` 全绿；`record_version` 前移而示例 HEAD 不前移；与 CHORE-110 字段归属互写。

## 关键证据（2026-09-19 实测）

| 项 | 实测结果 |
|---|---|
| `baseline_revision` | schema `:201` 裸 `{type:"string"}`；归档取值 `{V1,V2,V3}`，示例取值 `v1` |
| 约束密度 | 全 schema `minLength` 计数 0、`format` 计数 0、`pattern` 计数 2 |
| 裸 string 字段 | 遍历 `properties` 得 21 个内容性裸 string（规格 §5 列举） |
| 校验器能力 | `scripts/cwf-validate.mjs:63-76` 支持 `minLength`/`pattern`，**不支持 `format`** → 约束会真生效，版本号只能写 pattern |
| 真实记录误伤面 | `.agent-runs/` 259 条内容字段样本最短 35 字符（`summary`/`notes`/`environment`）→ 轻下限**零误伤** |
| 夹具误伤面 | `cwf-validate`/`cwf-record`/`cwf-evidence-verify` 三测试文件存在 `summary:'s'`、`rationale:'r'`、`element:'e'` 等单字符占位 → 本片主要工作量在此 |
| 版本戳耦合 | `record_version` 为 `const:"v0.1.8"`，`cwf-record.mjs:88` 据此盖新记录；归档经 `cmdArchive` 连带冻结 schema 副本，升版不影响历史记录可校验性 |
| 测试基线 | 相关四测试文件 60 用例当前全绿（2026-09-19） |

## 关联

- GitHub #123 第 2 条遗留事项；契约变更史 v0.1.8「范围外加固类建议另建 issue」
- 兄弟切片：`FIX-220`（呈递保护+引擎断言）、`FEAT-221`（写时整链自动校验）
- 🔴 同文件协调：CHORE-110（`handoff.schema.json` L590-607 `assembled`），字段归属见两侧规格 §17 / §4
- 范围复核：本卡只承接 #123 票内余项；呈递保护（PR #125）与写时校验（机器化延伸）已分别立为下列两张兄弟卡，不并入本卡范围

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-19 | 定义中 | 独立开工会话复核查重复测后立票；四项产品口径经裁定收敛 |
| 2026-09-19 | 待确认 | 规格 V1 + Definition Check 全通过，未决产品事项 0 |
