#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// 自动发现所有需要打包的插件包，无需在此登记包名——此前只写死
// packages/dsh-visual-workflow，新增插件包不会进入发布闸门。
const packagesDir = join(repoRoot, 'packages')
const buildPackages = (existsSync(packagesDir) ? readdirSync(packagesDir, { withFileTypes: true }) : [])
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = join(packagesDir, d.name)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) return null
    let scripts = {}
    try {
      scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts || {}
    } catch (e) {
      return null
    }
    return scripts.build ? { name: d.name, dir, scripts } : null
  })
  .filter(Boolean)

const stages = [
  {
    name: '重新生成工作流产物',
    command: npm,
    args: ['run', 'generate'],
    cwd: repoRoot,
  },
  ...buildPackages.map((p) => ({
    name: `生成正式组合包（${p.name}）`,
    command: npm,
    args: ['run', 'build'],
    cwd: p.dir,
  })),
  ...buildPackages
    .filter((p) => p.scripts['check:dist'])
    .map((p) => ({
      name: `检查产物新鲜度（${p.name}）`,
      command: npm,
      args: ['run', 'check:dist'],
      cwd: p.dir,
    })),
  {
    name: 'LOC-042 消费方契约机器层',
    command: process.execPath,
    args: ['scripts/workflow-conformance/run.mjs', '--machine-only'],
    cwd: repoRoot,
  },
  {
    name: '运行项目测试',
    command: npm,
    args: ['test'],
    cwd: repoRoot,
  },
  {
    name: '运行完整项目校验',
    command: npm,
    args: ['run', 'validate'],
    cwd: repoRoot,
  },
]

if (buildPackages.length === 0) {
  console.error('\n❌ 未发现任何需要打包的插件包（packages/ 下应至少有一个带 build 脚本的包）')
  process.exit(1)
}

for (const [index, stage] of stages.entries()) {
  console.log(`\n[${index + 1}/${stages.length}] ${stage.name}`)
  const result = spawnSync(stage.command, stage.args, {
    cwd: stage.cwd,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`\n❌ ${stage.name}无法执行：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\n❌ ${stage.name}失败（退出码 ${result.status ?? '未知'}）`)
    process.exit(result.status || 1)
  }
}

console.log(`
✅ 机器验证通过。
下一步：关闭开发 DSH，完整重启产品 DSH，并从真实安装路径完成人工 E2E。
动态开发插件的运行结果不是发布证据；本命令不会自动宣布 Release Ready。`)
