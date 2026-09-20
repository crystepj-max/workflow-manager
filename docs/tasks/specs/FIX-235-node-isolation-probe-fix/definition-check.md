# Definition Check（定义完成检查）· FIX-235

## 检查元数据

| 项 | 值 |
|---|---|
| 任务名称 | 节点隔离探测在真实 macOS 恒判 unavailable（参考配置无法运行 canary），独立 Proof 全线拒签 |
| 拟确认基线版本 | V1 |
| 检查人（Agent） | ZCode（requirements-analysis） |
| 检查时间 | 2026-09-20T15:21:33Z |
| 未决产品事项数 | 0 |

## 9.1 目标与范围

- [x] 用户问题明确（隔离机制真机恒 unavailable → Proof 全线拒签 → 结论降级非独立取证）
- [x] 需求目标明确（探测输出可信 enforced；unavailable 只在真异常）
- [x] 非目标明确（UI 展示已拍板 backlog；降级口径/换实现消解；LOC-041 执行面不动）
- [x] 修改范围明确（probeIsolationCapability 参考 profile + 三项证据 + realpath + 单测）
- [x] 不修改范围明确（执行面逻辑、非 darwin 分支、编辑器 UI、缓存机制）
- [x] 修改前状态明确（恒 unavailable、证据口径错、CI 只测 forced）
- [x] 修改后状态明确（enforced 可达且三证据齐全）

## 9.2 规则与边界

- [x] 主要业务规则明确（enforced 必须基于真实写入拒绝证据；拒签语义不变；失败结构化留痕）
- [x] 主要用户路径明确（重启产品 DSH → 跑工作流 → Proof 签发）
- [x] 关键边界场景明确（§11：CI/Linux、sandbox-exec 被移除、三判定任一失败、软链 cwd、force 注入、缓存、探测≠执行面）
- [x] 关键异常场景明确（unavailable + reason 留痕）
- [x] 对已有功能的影响明确（仅探测实现变更，包装层协议与执行面不动）
- [x] 已知风险明确（macOS 未来收紧、缓存假象、大版本升级需复跑 UAT）

## 9.3 决策完整性

- [x] 所有会影响产品结果的人工决策均已完成（待判定 2 由用户拍板；待判定 3 取证消解）
- [x] 不存在「施工时再决定」的产品问题
- [x] 未决产品事项数量为 0

## 9.4 任务组织

- [x] 无需切片（体量 S，单切片）
- [x] 单任务可独立 UAT
- [x] 前置依赖已填写「无」（UAT 全链以 FIX-233 为 UAT 前置条件，已显式标注）
- [x] 优先级已确定（P1）

## 9.5 验收

- [x] 验收条件明确（AC-01 ~ AC-06）
- [x] 已能形成主要 UAT 场景（UAT-01 真机 enforced + Proof 恢复）
- [x] 验收标准可以通过真实操作判断

## 9.6 无人值守

- [x] 已明确「无人值守许可」（允许：实现 + 单测）
- [x] 若允许无人值守，不存在必须在施工过程中由人选择的产品问题（UAT-01 属发布链场景，已显式划出）

---

## 结论

- [x] **全部通过** → 状态改为「待确认」，呈递人工确认基线
- [ ] 未通过 → 保持「定义中」

## 关键证据索引（故障机实证，2026-09-20）

1. 复刻探测两步：`which sandbox-exec` 存在；区内 `/bin/echo` 在 `(deny default)` 下 **SIGABRT(134)**（dyld 闭包 `/usr/lib`、`/private/var/db/dyld` 被拒）→ `insideAllowed` 恒 false；区外 `touch` 被拒但**死于 exec**（profile 只放行 `/bin/echo` 的 exec）——证据口径错位。
2. 测量伪影校正：首轮「加 /usr/lib 读权限后成功」经管道 head 吞掉退出码，交替对照 3×3 复测确认 `(deny default)` 路线恒败，非偶发。
3. 可行方案实证：`(allow default)` + `(deny file-write* (require-not (subpath <区内>)))`——区内 echo exit 0、区内 touch 落盘、区外 touch「Operation not permitted」（真 file-write 拒绝）三判定全绿。
4. 软链陷阱实证：过滤器写 `/tmp/...` 匹配不上实际写入的 `/private/tmp/...`（seatbelt 按解析后路径匹配）→ 必须 realpath。
5. 运行链路：`host.js:2425-2436`（探测缓存）→ `node-isolation-host.mjs` → `probeIsolationCapability`；Proof 门 `host.js:2737` → `canIssueIndependentProof`；UI 零展示（client.js 无相关渲染）。
6. 测试盲区：`scripts/test/node-isolation.test.mjs:168` 仅覆盖 forced 注入，真实 darwin 路径 CI 从不执行。
