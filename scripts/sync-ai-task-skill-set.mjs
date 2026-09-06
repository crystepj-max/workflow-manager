#!/usr/bin/env node
/**
 * 将 AI 任务交付 Skill 集合（M1/M2启动/M3）同步到 my-agent-skills。
 * 用法：
 *   node scripts/sync-ai-task-skill-set.mjs [my-agent-skills根目录]
 * 默认：../my-agent-skills
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wmRoot = path.resolve(__dirname, '..')
const defaultTarget = path.resolve(wmRoot, '../my-agent-skills')
const targetRoot = path.resolve(process.argv[2] || defaultTarget)

if (!fs.existsSync(targetRoot)) {
  console.error(`目标不存在: ${targetRoot}`)
  process.exit(1)
}

const pairs = [
  ['dsh/skills/requirements-analysis', 'my-skills/requirements-analysis'],
  ['dsh/skills/construction-bootstrap', 'my-skills/construction-bootstrap'],
  ['dsh/skills/execution-plan', 'my-skills/execution-plan'],
]

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (name === 'node_modules' || name === '.DS_Store') continue
    const from = path.join(src, name)
    const to = path.join(dst, name)
    const st = fs.statSync(from)
    if (st.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

const copied = []
for (const [relSrc, relDst] of pairs) {
  const src = path.join(wmRoot, relSrc)
  const dst = path.join(targetRoot, relDst)
  if (!fs.existsSync(src)) {
    console.error(`缺少源: ${src}`)
    process.exit(1)
  }
  fs.rmSync(dst, { recursive: true, force: true })
  copyDir(src, dst)
  copied.push(relDst)
}

const setReadme = path.join(targetRoot, 'my-skills/ai-task-skill-set/README.md')
fs.mkdirSync(path.dirname(setReadme), { recursive: true })
fs.writeFileSync(
  setReadme,
  `# AI 任务交付 Skill 集合（从 workflow-manager 同步）

本目录说明 + 下列三个 skill 构成通用集合；到点开跑（M4）不另建 Skill，见 \`execution-plan\` 内说明。

| 代号 | Skill 目录 | 作用 |
|---|---|---|
| M1 | \`requirements-analysis\` | 谈到「已定义」 |
| M2 | \`construction-bootstrap\` | 启动「完整功能开发」单任务交付（蓝图真源在 workflow-manager） |
| M3 | \`execution-plan\` | 批量调度；定时 = 到点再调本入口 |
| M4 | （无独立 Skill） | 到点启动脚本在 workflow-manager：\`scripts/ai-task-scheduled-trigger.mjs\` |

同步命令（在 workflow-manager）：

\`\`\`bash
node scripts/sync-ai-task-skill-set.mjs
\`\`\`

**不要**在此仓单独改出第二套流程规则；以 workflow-manager 工程真源为准后再同步。
`,
  'utf8',
)
copied.push('my-skills/ai-task-skill-set/README.md')

console.log(JSON.stringify({ ok: true, targetRoot, copied }, null, 2))
