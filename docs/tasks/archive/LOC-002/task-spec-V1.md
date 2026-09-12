# 任务卡解析与状态词汇收敛

| 元数据 | 值 |
|---|---|
| 需求基线版本 | V1 |
| 对应 Issue | （GitHub 恢复后补建，回填；本地轨道 GitHub 同步 = pending） |
| 优先级 | P1 |
| 前置依赖 | 无 |
| 无人值守许可 | 允许 |
| 定义时间 | 2026-09-09T15:23:30Z |
| 当前状态 | 待确认（本地轨道） |

## 1. 需求背景

架构评审（本会话，候选 2）发现「任务卡 / 任务规格」的 Markdown 解析知识散落在三个脚本中各抄一份，且版本解析已实际漂移。df32b17（本地轨道合入 main）后，这套解析契约从在途草稿变为正式能力的地基——漂移风险随之转正：改一个字段名要同步 4 处，漏一处即静默不一致。

## 2. 用户问题

同一份任务卡 / 本地任务规格文件，三个脚本各解析一遍且规则不一：可能出现「实施前检查通过、合并环节失败」（或反之）这类用户不知情的不一致。

## 3. 目标

解析与词汇知识各只有一处定义（locality）：任务卡表格解析、规格版本解析收敛为一个 module；本地轨道状态词汇唯一来源为 `local-task-registry`。漂移从此被直测抓住；对现有使用零破坏。

## 4. 非目标

- preflight 结构化 interface 改造（架构评审候选 3，另行立项）
- `git()` / `get()` 等 CLI 基础设施琐碎副本收敛（另行观察项）
- execution-plan `assess()` 硬编码 `--run-baseline V1` 问题（属候选 3 范围）
- 登记册 CLI `--slug` 参数未生效的缺陷（另行观察项）
- 不改任何任务卡 / 规格模板文档的格式与字段

## 5. 修改前

- `field()` 三份逐字重复：`ai-task-preflight-check.mjs:39`、`ai-task-execution-plan.mjs:53`、`local-task-merge.mjs:43`，净调用点 20 处。
- 规格版本解析两份且已漂移：preflight 6 级 fallback（需求基线版本字段 → `**版本**：` → `版本：` → 标题行 → `task-spec-VN` → 文件名）；merge `specVersionOf` 仅 3 级（缺中间三级）。
- 状态词汇字面量重抄：merge `PRE_MERGE_STATUS = '等待验收'` / `MERGED_STATUS = '已合并'` 未引用 registry 常量；preflight `'本地已定义'` 独立声明 4 处。registry 改状态词会静默失配。

## 6. 修改后

- 新建一个「任务卡解析」module（ESM，建议 `scripts/task-card-parse.mjs`）：表格字段提取 `field()`、规格版本解析 `parseSpecVersion()`（唯一实现 = preflight 的 6 级并集）、字段名词汇常量。
- 三个脚本删除各自副本，改为 import；merge 侧版本解析能力变宽（超集），preflight 门禁语义不变。
- merge / preflight 的状态字面量改为引用 `local-task-registry` 导出常量（不改值，只改引用来源；若某词 registry 未导出，先在 registry 补齐导出）。
- `sync-ai-task-skill-set.mjs` 分发清单补入新 module 文件。

## 7. 功能范围

1. 新 module：`field()` + `parseSpecVersion()`（6 级并集）+ 字段名词汇常量。
2. 三个消费脚本改造：`ai-task-preflight-check.mjs`、`ai-task-execution-plan.mjs`、`local-task-merge.mjs`。
3. 状态词汇收敛：`local-task-merge.mjs`、`ai-task-preflight-check.mjs` 引用 registry 常量。
4. 新增 module 直测（`scripts/test/task-card-parse.test.mjs`）。
5. 分发清单更新（`sync-ai-task-skill-set.mjs`）。

## 8. 不修改范围

- `ai-task-workspace-env.mjs`（`parseDeps` 已单源）
- 登记册 schema / CLI 行为（`--slug` 缺陷只登记不修）
- 任务卡 / 规格模板文档、公共契约文档
- preflight 的子进程门禁形态与 CLI 退出码语义（候选 3 范围）
- LOC-001（编辑器边 outcome UI）的全部在途文件

## 9. 业务规则

1. `field()` 语义保持现行为：匹配表格行 `| 字段 | 值 |`，取值 trim，未命中返回 null；多个同名行取第一个（钉入直测）。
2. 规格版本解析唯一实现 = 6 级并集，顺序：① `需求基线版本` 表格字段 → ② `**版本**：VN` → ③ `版本：VN` → ④ 标题行 `# … VN` → ⑤ `task-spec-VN` → ⑥ 文件名 `VN`；全不命中返回 null（调用方维持各自的「无法解析版本号」失败路径）。
3. 状态词汇唯一来源 = `local-task-registry` 导出常量；只改引用来源，不改任何状态词的值。
4. 三个脚本的对外 CLI 行为（退出码、stderr 文案语义、输出结构）不变；唯一行为差异 = merge 侧版本解析变宽（消除已知漂移的方向）。
5. 分发清单必须包含新 module 文件，与三个消费脚本同集合分发。

## 10. 用户操作路径

本任务对最终用户无感知（内部重构）。验收者操作 = 运行验收条件中的机械检查命令与测试。

## 11. 异常和边界场景

- 规格文件无任何版本标记：preflight 维持「本地任务规格无法解析版本号」失败；merge 维持 null 失败路径。
- 字段值含 `|` 竖线、字段名含正则元字符：维持现行为（正则插值语义不变，钉入直测防回归）。
- 空文件 / 缺表格：`field()` 返回 null、`parseSpecVersion()` 返回 null，各调用方现有兜底不变。

## 12. 已确认的关键决策及原因

| 决策主题 | 选择 | 原因 | 确认人 | 确认时间 |
|---|---|---|---|---|
| 范围 | 方案二：解析收敛 + 状态词汇搭车，不含候选 3 | 同主题一次验收；preflight 硬门禁形态改动性质不同，独立立项 | 用户 | 2026-09-09 |
| 版本解析语义 | 6 级并集（preflight 版） | 超集方向迁移零破坏；消除已知漂移 | 用户（方案二含此语义，推荐采纳） | 2026-09-09 |
| 发布轨道 | 本地轨道（GitHub 停用） | push 实测 403；恢复后补建 issue | 用户 | 2026-09-09 |
| 无人值守许可 | 允许 | 机械 S 型重构，验收条件可机械判定 | 用户（随基线确认） | 2026-09-09 |
| 优先级 | P1 | 漂移已随 df32b17 转正且改动小 | 用户（随基线确认，可调整） | 2026-09-09 |

## 13. 功能切片关系

- 本切片：单切片（S 型），无兄弟切片。
- 拆分原则：不适用（未拆分）。

## 14. 前置依赖说明

```text
前置依赖：无
```

## 15. 验收条件

- [ ] `grep -rn "function field" scripts/ --include="*.mjs"` 仅命中新 module 一处；三个消费脚本无本地副本。
- [ ] 版本解析唯一实现取 6 级并集；直测覆盖每一级各自命中、全不命中返回 null、多同名行取第一个。
- [ ] `等待验收` / `已合并` / `本地已定义` 在三个生产脚本源码中不再以本地字面量声明（仅 registry / module 定义处）。
- [ ] 新 module 直测存在且通过；既有相关测试（ai-task-preflight-local-track / local-task-merge / local-task-registry / ai-task-execution-plan-m3 等）不修改既有断言即全绿。
- [ ] `npm test`（引擎层）与 `npm run validate` 全绿。
- [ ] `sync-ai-task-skill-set.mjs` 分发清单包含新 module 文件名。
- [ ] 施工在本会话隔离 worktree 进行，不触碰 LOC-001 在途文件（client.js、locales、static-bundle.test.mjs、docs/tasks 中 LOC-001 的登记内容保持只追加）。

## 16. UAT 场景

### UAT-01 收敛机械验收

- 验收目的：确认解析与词汇知识各只有一处定义，且行为零破坏。
- 前置条件：
  1. 本会话隔离 worktree 检出施工分支。
- 操作步骤：
  1. 运行 `grep -rn "function field" scripts/ --include="*.mjs"`；
  2. 运行 `node --test scripts/test/task-card-parse.test.mjs`；
  3. 运行 `npm test` 与 `npm run validate`；
  4. 运行 `git diff main --stat` 确认改动文件清单与 §7 一致。
- 预期结果：
  1. `field` 定义仅新 module 一处；
  2. 直测全绿（含 6 级 fallback 用例）；
  3. 全绿；
  4. 无超出 §7/§8 范围的文件。
- 建议人工关注：merge 侧版本解析变宽是否符合预期（属本任务声明的唯一行为差异）。

## 17. 风险

- 分发清单漏新 module → skill 分发副本缺文件（已列入验收条件硬检查）。
- merge 版本解析变宽的理论影响：此前因 3 级 fallback 失败的场景现在可能通过——方向为消除已知漂移，接受并已在 §6/§9 声明。

## 18. 已知限制

- 不解决 preflight「只有退出码 interface」问题（候选 3）；execution-plan 仍 spawn 子进程并自行重解析（其 field 调用点已收敛到 module，但读取动作仍在）。
- `assess()` 硬编码 `--run-baseline V1` 与 `definedAt` 默认值问题保持现状（另行登记）。

## 19. 版本历史

| 版本 | 日期 | 变更摘要 | 确认人 |
|---|---|---|---|
| V1 | 2026-09-09 | 初版基线（方案二） | （待基线确认） |
