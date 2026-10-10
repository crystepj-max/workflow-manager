#!/usr/bin/env node
// 兼容旧调用名：workflow-manager 不再把 M1/M3 Skill 同步到 my-agent-skills。
// requirements-analysis 由 dsh/install-requirements-analysis.sh 直接安装到用户级入口；
// execution-plan 由 dev-flow 作为项目级 Skill 维护。
console.error('此同步入口已停用；它不会修改 my-agent-skills。')
console.error('requirements-analysis: bash dsh/install-requirements-analysis.sh')
console.error('execution-plan: 使用 dev-flow/.agents/skills/execution-plan 项目级入口')
process.exitCode = 2
