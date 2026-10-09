// 测试专用基座 harness：旧式 on: success/failure 边形态的蓝图。
// 该基座原为历史自定义种子模板（已从模板资产中移除，不再参与生成、安装与模板库），
// 现仅作为校验器 / 生成器 / 运行时的测试输入，位于 scripts/test/fixtures/legacy-baseline.json。
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateAll } from '../../generate.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

/** 读取基座蓝图 */
export function loadBaseline() {
  return JSON.parse(readFileSync(path.join(here, '../fixtures/legacy-baseline.json'), 'utf8'))
}

/** 生成「内置角色 + 测试专用自定义角色」的临时角色源目录（仅测试用） */
export function makeFixtureRolesDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vwf-roles-'))
  cpSync(path.join(repoRoot, 'dsh', 'roles'), dir, { recursive: true })
  for (const f of readdirSync(FIXTURE_ROLES_DIR)) {
    cpSync(path.join(FIXTURE_ROLES_DIR, f), path.join(dir, f))
  }
  return dir
}

/** 在临时目录里对基座跑生成器，返回与 generateAll(templatesDir) 相同形态的 { files, report } */
export function generateBaseline() {
  return generateInTemp({ 'legacy-baseline.json': loadBaseline() }, { withRoles: true })
}

/** 测试专用自定义角色目录（角色不在内置清单内，仅供测试） */
export const FIXTURE_ROLES_DIR = path.join(here, '../fixtures/roles')

/**
 * 在临时目录里对任意蓝图跑生成器（蓝图以 <name>.json 落在临时 templates/ 下）。
 * opts.withRoles：把仓库 dsh/roles 复制为临时 templates/ 的兄弟目录——生成器按
 * `<templatesDir>/../dsh/roles` 解析角色源，bundleRoles 用例需要它。
 */
export function generateInTemp(blueprints, opts = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'vwf-baseline-'))
  try {
    const dir = path.join(base, 'templates')
    mkdirSync(dir, { recursive: true })
    if (opts.withRoles) {
      const rolesDest = path.join(base, 'dsh', 'roles')
      cpSync(path.join(repoRoot, 'dsh', 'roles'), rolesDest, { recursive: true })
      // 测试专用自定义角色（非内置）一并注入，供基座节点解析
      for (const f of readdirSync(FIXTURE_ROLES_DIR)) {
        cpSync(path.join(FIXTURE_ROLES_DIR, f), path.join(rolesDest, f))
      }
    }
    for (const [name, bp] of Object.entries(blueprints)) {
      writeFileSync(path.join(dir, name), JSON.stringify(bp, null, 2), 'utf8')
    }
    return generateAll(dir)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
