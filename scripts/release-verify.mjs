#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginRoot = join(repoRoot, 'packages', 'dsh-visual-workflow')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const stages = [
  {
    name: '重新生成工作流产物',
    command: npm,
    args: ['run', 'generate'],
    cwd: repoRoot,
  },
  {
    name: '生成正式 VWF 组合包',
    command: npm,
    args: ['run', 'build'],
    cwd: pluginRoot,
  },
  {
    name: '检查正式 VWF 产物新鲜度',
    command: npm,
    args: ['run', 'check:dist'],
    cwd: pluginRoot,
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
