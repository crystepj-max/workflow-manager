import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256File(filePath) {
  return sha256Text(readFileSync(filePath, 'utf8'))
}

export function walkFiles(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkFiles(full, base))
    else out.push(relative(base, full))
  }
  return out
}

export function digestDirectory(dir) {
  const files = walkFiles(dir)
  const parts = files.map((rel) => `${rel}:${sha256File(join(dir, rel))}`)
  return sha256Text(parts.join('\n'))
}
