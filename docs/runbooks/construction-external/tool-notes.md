# External Profile 工具差异说明（薄适配层）

> 本文件只描述「同一 runbook 在不同工具环境下怎么操作」的机械差异，**不含任何业务语义**。语义一律以契约为准（见 runbook.md 头部纪律）。

## Codex CLI

| 环节 | 做法 |
|---|---|
| 上下文加载 | 仓库根 `AGENTS.md` 自动生效；契约与 runbook 路径写入 AGENTS.md 引用或开工指令 |
| 命令执行 | 内建 shell；cwf-* 脚本直接用 `node scripts/...` |
| GitHub | `gh` CLI（`gh auth login` 预置） |
| 独立证明者 | 新开 Codex 会话（新对话窗口/`codex` 新会话）执行 review/test；produced_by 用新会话标识 |
| 人工门 | 呈现文本摘要等待用户在终端回复；裁决由用户在下一条消息给出 |

## Cursor

| 环节 | 做法 |
|---|---|
| 上下文加载 | `.cursor/rules/` 或 @-references 指向契约与 runbook；或在 Agent 开工消息中粘贴路径 |
| 命令执行 | Agent 的 Terminal 能力；cwf-* 脚本同样 `node scripts/...` |
| GitHub | `gh` CLI 同上 |
| 独立证明者 | 新开一个 Chat/Agent 会话执行 review/test（不同 produced_by）；可选不同模型路线 |
| 人工门 | Agent 会话内呈递；用户在下一条消息裁决 |

## 共同纪律（工具无关）

- 每个 Run 独立 worktree/branch（runbook §1）；
- review/test 禁止与 dev 同会话同 produced_by（契约 §2 不变量 2）；
- 人工门一律挂起等待，AI 不代签（§5.4）；
- run 产物经本地 exclude 不入库（runbook §10）。
