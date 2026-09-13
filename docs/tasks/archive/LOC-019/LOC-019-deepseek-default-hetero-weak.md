# LOC-019 · 内置模板默认模型 DeepSeek 化

> 本卡为切片 1。切片 2（异源档位三态可配置）见 [`LOC-021-hetero-mode.md`](./LOC-021-hetero-mode.md)。

## 任务基本信息

| 字段 | 值 |
|---|---|
| 任务标识 | `LOC-019` |
| 需求来源 | 会话录入 |
| 来源定位 | 2026-09-13 LOC-014 产品 UAT 验证反馈（用户会话决策） |
| 任务名称 | 内置模板默认模型 DeepSeek 化 |
| 任务类型 | 完整功能开发 |
| 优先级 | P1 |
| 当前状态 | 等待验收 |
| 需求基线版本 | V1 |
| 前置依赖 | 无 |
| 施工环境组 | LOC-019 |
| 施工环境角色 | 独立 |
| 无人值守许可 | 允许 |
| 任务规格位置 | `.scratch/LOC-019-deepseek/task-spec-V1.md` |
| 定义时间 | 2026-09-13T19:40:00+08:00 |
| GitHub 同步 | pending |

## 摘要（三要素速览）

### 任务目标

四套正式内置模板的默认模型绑定全部 DeepSeek 化：provider 一律 `deepseek-official`，验证角色用 `deepseek-v4-flash`、其余节点用 `deepseek-flash`，开箱即可发起运行；并解除现存用户数据对内置改动的遮蔽。

### 涉及范围

- 做：
  1. `templates/*.json` 四套内置模板 `bindings.models` 按逐模板映射表调整（映射表见任务规格 §6）；
  2. 重新生成并使其进入实际加载路径（生成物本身不入库）；
  3. 交付步骤内执行一次性清理：删除与内置逐字节相同的同 id 整份副本；
  4. 模型覆盖文件不自动删除，diagnose 覆盖造成的运行阻塞以清单形式呈递用户处置；
  5. 生效链路核对 + 插件包与仓库校验全绿。
- 不做：异源档位字段与校验改造（归 LOC-021）；编辑器 UI 改造（归 LOC-021）；运行时异源日志口径（归 LOC-021）；非内置模板批量迁移；运行中模型修订路径（#79）。

### 验收标准

- [ ] 四套内置模板内置默认绑定与映射表逐节点一致（provider 全 `deepseek-official`）
- [ ] 重新生成后生成物内联模型与映射表一致
- [ ] 一次性清理已执行且留痕（删除/保留清单齐全；内容不同的副本未被删除）
- [ ] 模型覆盖文件未被自动删除；diagnose 覆盖导致的运行阻塞已显式列出并给出处置建议
- [ ] 完整功能开发 / 快速迭代 / 探索可直接发起运行；诊断模板在清除或修正冲突覆盖后可发起运行
- [ ] 非内置模板与内容不同的用户副本行为无变化
- [ ] 插件包测试 + `npm test`、`npm run validate`、`npm run release:verify` 全绿

## 详细规格

完整需求以本地任务规格为准（见上表「任务规格位置」）。实质变更走 Vn→Vn+1 流程，见 `references/baseline-change-v1-v2.md`。

## 变更记录

| 时间 | 状态 | 说明 |
|---|---|---|
| 2026-09-13 | 定义中 | 用户在 LOC-014 产品 UAT 反馈中提出并给出核心决策；建卡待需求分析定稿 |
| 2026-09-13 | 待确认 | 需求分析会话完成：纠正「现状为强档」的错误前提；落定 D1–D7 全部决策；拆分出切片 2（LOC-021）；Definition Check 全通过，未决产品事项 0；呈递基线确认 |
| 2026-09-13 | 本地已定义 | 松哥确认需求基线 V1（会话确认「确认」，19:49:36）；本地任务卡已入库、登记册已登记、规格版本一致（V1）；具备开工资格。GitHub 同步 pending |
| 2026-09-13 | 交付中 | Run loc-019-r1（分支 dev-loc-019-r1 @ f410900）；实施前检查通过，施工环境组 LOC-019 登记；四套模板默认绑定改造完成 + 新增回归测试 4 例；一次性清理执行并留痕 |
| 2026-09-13 | 执行受阻 | 独立审查 approve（0 阻断）；独立测试 verdict=fail，根因=requirements：实测冲突模型覆盖为 **2 份**（规格 §5 误记 1 份）——construction-full-feature 的现存覆盖（review→deepseek-flash）与新默认 dev=deepseek-flash 撞成完全相同模型，被异源硬规则拒绝，该模板当前无法发起运行；诊断模板同因被阻（规格 §11 已预期）。按 D4-b 覆盖未自动删除，需人工裁决处置方式后复测 |
| 2026-09-13 | 等待验收 | 松哥授权人工清除 2 份冲突覆盖（备份留痕 `.scratch/LOC-019-deepseek/user-data-cleanup/model-overrides/`，explore 覆盖保留）→ reverify 推进 attempt→2/3 复测；test_proof.a3 verdict=**pass**（8/8 验收项，按基线原文逐条映射）；evidence-verify **9/9 全绿**；checkpoint target 未前进、proofs still_valid；验收包 acceptance_package.a3 awaiting_decision。UAT 卡 `.agent-runs/loc-019-r1/uat-card.md`；UAT 前置：产品 DSH 会话工作目录指向工作树 |

## 实施记录（2026-09-13，Run loc-019-r1）

- **交付**：四套内置模板 `bindings.models` 全部 DeepSeek 化（验证角色 `deepseek-v4-flash`、其余 `deepseek-flash`）+ 新增回归测试 `scripts/test/builtin-template-model-defaults.test.mjs`（4 例）。分支 `dev-loc-019-r1` @ `f410900`，合并提交 `bd5dd3f`（tag `task/loc-019/v1`）。
- **一次性清理**：`~/.dsh/visual-workflow/templates/construction-full-feature.json`（与开工基线 0b5f101 内置逐字节相同）判定冗余删除，备份 `.scratch/LOC-019-deepseek/user-data-cleanup/`。
- **人工处置（松哥授权）**：清除 2 份冲突模型覆盖（construction-full-feature / diagnose，explore 保留），备份同目录 `model-overrides/`。根因：新默认 `dev=deepseek-flash` 与其现存覆盖撞成完全相同模型，被异源硬规则拒绝——规格 §5 原记 1 份，实为 2 份。
- **独立会话**：审查 approve（0 阻断）；测试 attempt 1 fail（requirements）→ 人工处置后 attempt 3 **pass（8/8）**；evidence-verify 9/9 ✅；验收三态 = **accept**（松哥，2026-09-13T22:23+08:00）。
- **UAT 环境**：主检出 `.generated/` 镜像更新为新绑定（备份 `uat-env-backup/main-generated-20260913/`），合并后 `npm run generate` 幂等且与 UAT 产物完全一致。
- **遗留（进 LOC-021 / 后续票）**：异源档位三态（关/弱/强）与编辑器控件；运行时异源日志按节点 id 硬编码（diagnose 不触发）；runbook §7.4 与 validate-workspace D-7 规则矛盾；validate-workspace 链接工作树扫描口径。
