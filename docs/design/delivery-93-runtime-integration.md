# #93 DSH Runtime Integration 交付说明

> 日期：2026-09-01  
> 执行者：DSH #93 Runtime Integration  
> 目标：将 workspace-isolation Core 接入 DSH workflow / cordis / Slot / RPC / storageDomain 运行路径  
> 前置：PR #144 (4e79df2) 已合入 main

---

## 改动模块

### 1. 新增文件

| 路径 | 职责 |
|---|---|
| `scripts/workspace-isolation-host.mjs` | Workspace Isolation 宿主包装脚本：桥接 vm 沙箱与 Core，17 个 CLI 子命令，Registry 持久化到 `work_root/.vwf-registry/state.json`（#79 前临时方案） |
| `scripts/test/runtime-integration-e2e.mjs` | #93 真机验收脚本：4 项 E2E 测试（双 Run 隔离、integration lock 串行、Snapshot 不重建、Proof 绑定） |

### 2. 修改文件

| 路径 | 改动摘要 |
|---|---|
| `packages/dsh-visual-workflow/src/host.js` | 新增 Workspace Isolation 集成区（~200 行）：`workspaceHostPath`/`workspaceRoot`/`wsHostCall`/`mapTemplateId`；14 个 `vwf.workspace.*` RPC；`wf_run` execute 启动前 allocateWorkspace 并注入 workspace 信息到 script args |
| `scripts/generate.mjs` | 编译脚本新增 workspace 现场变量（`WS`/`SOURCE`/`RECORDS`/`WORK_BRANCH`/`SOURCE_REVISION`）；`runtimeCtx` 注入 workspace 路径；`verifyBranchStep`/`claimError` 使用 `WORK_BRANCH` |
| `packages/dsh-visual-workflow/dist/*` | 重建 dist bundle（`npm run build`） |

---

## 如何调用 Core API

### 从 DSH Host（wf_run 启动路径）

```js
// host.js wf_run execute 中
const alloc = await wsHostCall('allocate', {
  logical_run_id: String(args.taskId || ''),
  template_id: mapTemplateId(args.templateId),
  repository_path: repoPath || null,
  base_ref: args.baseBranch || 'main',
  task_identity: String(args.taskId || ''),
})
```

### 从编译后的 Workflow 脚本（节点内）

```js
// 脚本通过 host.call 获取 workspace 现场
const ws = await host.call('vwf.workspace.get', { taskId: TASK })
// 或读写 source
await host.call('vwf.workspace.writeSource', { workspace: ws.workspace, rel: 'file.txt', content: '...' })
```

### 从外部测试/CLI

```bash
node scripts/workspace-isolation-host.mjs allocate \
  '{"work_root":"/tmp/ws","logical_run_id":"run-1","template_id":"construction","repository_path":"/path/to/repo","task_identity":"issue-93"}'

node scripts/workspace-isolation-host.mjs acquireLock \
  '{"work_root":"/tmp/ws","logical_run_id":"run-1","resource_key":"repo:org/demo:target:main:integration","owner":"run-1"}'
```

---

## 真机步骤与证据路径

### 运行真机验收

```bash
# 在仓库根目录
node scripts/test/runtime-integration-e2e.mjs
```

### 证据路径

- 真机测试脚本：`scripts/test/runtime-integration-e2e.mjs`
- 测试产物（临时 worktree/branch）：`.scratch/rt-integ-<timestamp>/`
- Registry 持久化状态：`.scratch/rt-integ-<timestamp>/*/.vwf-registry/state.json`
- 运行记录：终端输出（含时间戳、workspace_id、branch、HEAD、lock_id）

### 验证结果（2026-09-01）

```
━━ 测试 1：同仓双 Run 并行隔离 ━━
  ✓ workspace_id/path/source 独立
  ✓ branch 独立: vwf/run/run-a | vwf/run/run-b
  ✓ A 的未提交文件对 B 不可见
  ✓ A 的 cache 对 B 不可见
  ✓ source_revision 等于实况 HEAD
  ✅ 测试 1 通过

━━ 测试 2：integration lock 串行 ━━
  ✓ Run A 获取锁: lk-1
  ✓ Run B 获取锁被拒（正确）
  ✓ Run A 释放锁
  ✓ Run B 释放后获取锁: lk-2
  ✅ 测试 2 通过

━━ 测试 3：Provider/Model Snapshot 变化不重建 workspace ━━
  ✓ source_path 保持不变
  ✅ 测试 3 通过

━━ 测试 4：验证节点绑定同一 Workspace / 实况 HEAD ━━
  ✓ provenance 绑定 workspace_id / source_revision / verified_head
  ✓ 另一 workspace 的 Proof 被拒
  ✅ 测试 4 通过
```

### 回归测试

- `npm test`：263 pass / 0 fail（含 workspace-isolation Core 全部测试）
- `npm run validate`：全绿（蓝图校验 + 重生成一致性 + 引擎层测试 + 包测试）

---

## 留给后续 Issue 的缺口

### #79 持久化（Logical Run / Segment / Snapshot）

- [ ] Registry 持久化当前为 JSON 文件临时方案（`work_root/.vwf-registry/state.json`），需升级为正式 Logical Run 存储
- [ ] workspace identity/lock/checkpoint 事件需接到现有存储的最小挂钩（当前仅落盘 state.json）
- [ ] 完整 Logical Run / Segment / Snapshot 升级（含历史查询、审计链）
- [ ] 当前 `runTag.workspace_id` 仅内存登记，重启后需从磁盘恢复

### #82 模板消费 Policy

- [ ] 四套正式模板资产（construction/optimize/diagnose/explore）的 Policy 消费
- [ ] `mapTemplateId()` 当前为启发式映射，需对接模板注册表
- [ ] `resolveWorkspacePolicy` 的 `input.resource_kind` 需从模板参数传递

### #53 完整发布 E2E

- [ ] 产品 DSH 重启后从正式插件路径加载，再跑一遍并行路径（本 Run 仅完成开发 DSH 验证）
- [ ] 开发动态插件不算发布证据，需关闭开发 DSH、重启产品 DSH、验证正式安装路径
- [ ] `npm run release:verify` 机器闸门通过 ≠ Release Ready

### 其他明确不做的项

- [ ] Container/Remote Provider
- [ ] Portable Contract 业务语义正文修改
- [ ] #14/#19 重做
- [ ] construction-bootstrap shim 退役（#105）

## Codex Round 1 修复（PR #150）

PR #150 经 `/codex-review next` 发起 Codex Round 1，收到 5 条 P1/A 类阻塞意见，已全部修复：

| # | 意见 | 修复 |
|---|---|---|
| A1 | 注册表 load-modify-save 跨进程竞争：并发 allocate/acquireLock 后写覆盖先写，integration lock 串行被破坏 | `workspace-isolation-host.mjs` 对全部注册表事务加跨进程文件锁（`openSync 'wx'` 排他 + stale 接管），落盘改临时文件 + `renameSync` 原子换入；新增 E2E 测试 2b 用并行 spawn 验证并发抢锁恰有一个成功 |
| A2 | workspace 分配失败静默降级，隔离保证被关闭 | `wf_run` 分配失败 fail closed 拒绝启动；仅当包装脚本不存在（宿主未部署集成）回退旧行为 |
| A3 | 节点提示仍宣称只允许在 RUNDIR 写文件，开发节点忽略 Runtime 分配的 source | `generate.mjs` `runtimeCtx` 明确「业务源码读写目录 = SOURCE（worktree 现场）」，records/run 产物分目录说明 |
| A4 | RPC 信任调用方传入的 workspace 对象，可伪造路径越权写 | `vwf.workspace.*` 写操作只接收 Run 身份（logical_run_id/workspace_id），包装脚本内 `resolveWorkspaceFromRegistry` 从注册表解析权威 workspace |
| A5 | lifecycle 映射只覆盖 3 态，cancelled/error 等终态把 workspace 永久留在 READY | 新增 `canonicalLifecycleFor`：人工等待→WAITING_HUMAN（保留态）、DONE→COMPLETED、STOPPED→STOPPED、其余失败/取消→FAILED |

修复后回归：`npm test` 262 pass / 0 fail、`npm run validate` 全绿、E2E 5/5 通过。

---

## 架构图

```
DSH Host (vm 沙箱)
  └─ host.js wf_run execute
       ├─ wsHostCall('allocate', ...) ──runNode──→ workspace-isolation-host.mjs
       │                                              └─ allocateWorkspace(registry, spec)
       │                                                 ├─ Git worktree add (ISOLATED_WRITE)
       │                                                 ├─ git worktree add --detach (ISOLATED_READ)
       │                                                 └─ DirectorySandbox (SANDBOX)
       │                                              └─ persist(state.json)
       │
       ├─ 注入 workspace 到 script args
       │    ├─ workspace_id / workspace_path
       │    ├─ source_path / records_path
       │    └─ work_branch / source_revision
       │
       └─ engine.start({ script, meta, args, parent })
                └─ workflow 脚本节点
                     ├─ host.call('vwf.workspace.get', { taskId })
                     ├─ host.call('vwf.workspace.writeSource', { logical_run_id, rel, content })
                     ├─ host.call('vwf.workspace.buildProvenance', { logical_run_id, node, attempt })
                     └─ host.call('vwf.workspace.acquireLock', { ... })
```

---

## 提交记录

1. `feat(workflow): #93 DSH Runtime Integration — workspace 分配、RPC、编译脚本注入`（PR #150 首个提交，1ba8715）
2. `fix(workflow): #93 Codex Round 1 A 类修复 — 跨进程锁、fail closed、RPC Run 身份、lifecycle 全覆盖`（新 HEAD）
