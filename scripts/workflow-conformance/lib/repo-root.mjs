import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

export function findRepoRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let dir = from
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'templates')) && existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('无法定位仓库根目录（缺少 templates/ 与 package.json）')
}
