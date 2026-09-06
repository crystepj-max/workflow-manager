import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, '..', '..', 'src', 'client.js')
const source = readFileSync(sourcePath, 'utf8')
const beginMarker = '// VWF_LAYOUT_CORE_BEGIN'
const endMarker = '// VWF_LAYOUT_CORE_END'
const begin = source.indexOf(beginMarker)
const end = source.indexOf(endMarker)

if (begin < 0 || end < 0 || end <= begin) {
  throw new Error('client.js 缺少布局内核源码接缝标记')
}

const coreSource = source.slice(begin + beginMarker.length, end)
const load = new Function(coreSource + '\nreturn createVwfLayoutCore()')
const layoutCore = load()

if (!layoutCore || typeof layoutCore.layoutGraph !== 'function' || typeof layoutCore.deriveEntryCandidates !== 'function') {
  throw new Error('布局内核公开接口不完整')
}

export { layoutCore }
