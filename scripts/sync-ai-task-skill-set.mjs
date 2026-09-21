#!/usr/bin/env node
/**
 * 将 AI 任务交付 Skill 集合（M1/M2启动/M3）同步到 my-agent-skills。
 * 用法：
 *   node scripts/sync-ai-task-skill-set.mjs [my-agent-skills根目录]
 * 默认：../my-agent-skills
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wmRoot = path.resolve(__dirname, '..')
const defaultTarget = path.resolve(wmRoot, '../my-agent-skills')
const targetRoot = path.resolve(process.argv[2] || defaultTarget)

if (!fs.existsSync(targetRoot)) {
  console.error(`目标不存在: ${targetRoot}`)
  process.exit(1)
}

// M2 建设交付不再向通用仓复制 Bootstrap Profile（原 construction-bootstrap 已随 #102 退役）：
// 入口 = workflow-manager 的正式内置蓝图与其生成 Skill，通用会话按 skill-set.md 的落点说明使用。
const pairs = [
  ['dsh/skills/requirements-analysis', 'my-skills/requirements-analysis'],
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

// 安装态配套资产：技能脱离本仓库后仍需执行的脚本与文档
const assetScripts = {
  'requirements-analysis': ['local-task-registry.mjs', 'task-card-parse.mjs'],
  'execution-plan': ['ai-task-execution-plan.mjs', 'ai-task-preflight-check.mjs', 'ai-task-scheduled-trigger.mjs', 'task-card-parse.mjs'],
}
const assetDocs = {
  'execution-plan': ['execution-plan-m3', 'scheduled-trigger-m4', 'public-task-contract', 'skill-set'],
}

const copied = []
for (const [relSrc, relDst] of pairs) {
  const src = path.join(wmRoot, relSrc)
  const dst = path.join(targetRoot, relDst)
  if (!fs.existsSync(src)) {
    console.error(`缺少源: ${src}`)
    process.exit(1)
  }
  if (fs.existsSync(dst)) {
    const backup = path.join(targetRoot, '.skill-sync-backups', `${Date.now()}-${path.basename(dst)}`)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.renameSync(dst, backup)
  }
  copyDir(src, dst)
  const name = path.basename(dst)
  if (assetScripts[name]) {
    const assetDir = path.join(dst, 'assets')
    fs.mkdirSync(assetDir, { recursive: true })
    for (const n of assetScripts[name]) fs.copyFileSync(path.join(wmRoot, 'scripts', n), path.join(assetDir, n))
    if (assetDocs[name]) {
      fs.mkdirSync(path.join(assetDir, 'ai-task-define-delivery'), { recursive: true })
      for (const n of assetDocs[name]) fs.copyFileSync(path.join(wmRoot, 'docs/design/ai-task-define-delivery', n + '.md'), path.join(assetDir, 'ai-task-define-delivery', n + '.md'))
    }
  }
  const hashes = {}
  function recordFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) recordFiles(file)
      else hashes[path.relative(dst, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  recordFiles(dst)
  fs.writeFileSync(path.join(dst, 'source-manifest.json'), JSON.stringify({ upstream: 'workflow-manager', files: hashes }, null, 2) + '\n')
  copied.push(relDst)
}

const setReadme = path.join(targetRoot, 'my-skills/ai-task-skill-set/README.md')
fs.mkdirSync(path.dirname(setReadme), { recursive: true })
fs.writeFileSync(
  setReadme,
  `# AI 任务交付 Skill 集合（从 workflow-manager 同步）

本目录说明 + 下列两个 skill（M1/M3）构成通用集合；到点开跑（M4）不另建 Skill，见 \`execution-plan\` 内说明。

| 代号 | Skill 目录 | 作用 |
|---|---|---|
| M1 | \`requirements-analysis\` | 谈到「已定义」 |
| M2 | （不复制）| 入口在 workflow-manager：正式内置模板 \`wf-construction-full-feature\` 与其生成 Skill（\`npm run install:builtin-skills\`）；原 \`construction-bootstrap\` 已随 #102 收敛退役 |
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
