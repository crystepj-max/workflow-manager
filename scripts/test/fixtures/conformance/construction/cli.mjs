#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))

if (process.argv.includes('--help')) {
  console.log('conformance-construction-cli — LOC-042 固定夹具\n\n用法：cli.mjs [--help|--version]')
  process.exit(0)
}

if (process.argv.includes('--version')) {
  console.log(pkg.version)
  process.exit(0)
}

console.error('未知参数；使用 --help')
process.exit(1)
