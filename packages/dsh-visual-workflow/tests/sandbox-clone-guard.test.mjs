// LOC-015 UAT-01 真机发现：动态 Cordis 宿主 vm 沙箱未注入 structuredClone，
// 人工决策续跑路径（buildPauseResumeArgs / modelOverridesForExec）直接
// ReferenceError，wf_run 续跑失败。host 半只允许经 deepCloneData 守卫调用，
// 禁止裸用 structuredClone（vm 沙箱不保证注入任何新内建）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostSrc = readFileSync(join(here, '..', 'src', 'host.js'), 'utf8')
const hostDist = readFileSync(join(here, '..', 'dist', 'dynamic', 'host.js'), 'utf8')

test('host.js 定义 deepCloneData 守卫（typeof 探测 + JSON 回退）', () => {
  assert.match(hostSrc, /const deepCloneData = \(value\) => \{/)
  assert.match(hostSrc, /typeof structuredClone === 'function' \? structuredClone\(value\) : JSON\.parse\(JSON\.stringify\(value\)\)/)
})

test('host.js 全部 structuredClone 出现点都 confined 在 deepCloneData 内', () => {
  const helperStart = hostSrc.indexOf('const deepCloneData = (value) => {')
  assert.notEqual(helperStart, -1, 'host.js 必须定义 deepCloneData')
  const callSite = hostSrc.indexOf('JSON.parse(JSON.stringify(value))')
  const helperEnd = hostSrc.indexOf('\n    }', callSite)
  assert.notEqual(helperEnd, -1, 'deepCloneData 定义必须完整')
  // 只匹配真实用法（调用/typeof 比较），注释里的提及（含全角括号）不算
  const occurrences = [...hostSrc.matchAll(/structuredClone(?=[ (=!])/g)].map((m) => m.index)
  assert.ok(occurrences.length >= 2, 'deepCloneData 内应至少有 typeof 探测与调用两处')
  for (const idx of occurrences) {
    assert.ok(idx > helperStart && idx < helperEnd, `发现 deepCloneData 之外的 structuredClone（偏移 ${idx}）`)
  }
})

test('dist/dynamic/host.js 保留 structuredClone 守卫（构建不丢失回退）', () => {
  assert.match(hostDist, /typeof structuredClone/)
})
