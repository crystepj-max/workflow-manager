## OpenSpec

标识：`node_isolation`；关联 LOC-041 / WR-018；V1 候选，尚未批准。决策来源为 [地图](../../docs/tasks/specs/LOC-041-node-isolation/decision-map.md)，完整规则与验收以 [任务规格](../../docs/tasks/specs/LOC-041-node-isolation/task-spec-V1.md) 为待确认唯一业务基线。

## Problem Statement

审核、测试、研究角色的“不修改”提示不能证明被审成果不变，用户无法依赖这类输出作为独立证明。

## Proposed Solution

限定一个 macOS DSH SDK 子进程参考配置，通过公开 provider 和沙箱能力提供每节点最小权限。候选在节点写根之外，测试覆盖层、缓存和报告有独立写区。无有效授权不能通过工具或 shell 发布。不具备强制边界的配置明确受阻，不产生独立 Proof。

## Changes

- `packages/dsh-visual-workflow/src/`：modify/create — 在现有宿主入口注册受控节点适配、探测保证等级并记录证据。
- `scripts/`：modify/create — 节点工作区/派生测试副本、能力声明验证和受控探针；不靠 best-effort chmod 作为安全保证。
- `templates/`：modify — 为四模板声明最小节点能力。
- `dsh/roles/` 与 `dsh/skills/`：modify — 直接关联的能力说明与参考配置 runbook，引用实际保证而非声称模型自律等于隔离。
- `packages/dsh-visual-workflow/tests/`：modify/create — 适配、能力缺失、实际拒绝/允许组合的验证入口。
- 不修改 deepseek-harness 上游源码或产品 Profile，不增加通用权限平台。

## Test Plan

在同一个真实参考配置中：先记录候选摘要，分别通过 review/test/researcher 文件工具及直接 shell 尝试越权写入；验证拒绝并复核字节。随后合法生成报告、运行测试/缓存及测试覆盖层，证明功能仍可用。用本地受控发布探针验证无授权旁路拒绝和有授权受控动作可用。补测路径穿越、symlink、间接脚本及无沙箱配置；后者必须阻断正式独立 Proof。

至少一个真实配置正反两类探针都通过才满足完成；全报 unavailable 不构成交付。自动替身、真实宿主和人工验收分别呈递。

## Risks & Open Questions

- [阻塞定义] ISO-D1/D2/D3 与 V1 基线/无人值守许可尚未由用户确认。
- [施工技术风险] 源码有 SDK/profile/cwd/sandbox 接口，不证明当前安装组合可以同时约束文件、shell 和网络；开发首步实测，失败保留 BLOCKED 证据，不改验收。
- [可并行] 其他 P1 任务不依赖本适配上线即可分析/开发；共享 host 文件只形成合入冲突风险。
- [范围边界] 若必须修改上游或扩大 Profile，需另行决定变化部分，不能借本批授权无限扩展。
