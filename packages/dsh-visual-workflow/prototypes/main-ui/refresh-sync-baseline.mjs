import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { prototypeDir, packageRoot, sourceHashes, syncStatus } from './seed.data.mjs'

const file = path.join(prototypeDir, 'sync-baseline.json')
const baseline = JSON.parse(await readFile(file, 'utf8'))
const hash = (data) => createHash('sha256').update(data).digest('hex')
if (process.argv.includes('--check')) {
  const status = await syncStatus()
  console.log(status.inSync ? '正式来源未漂移；原型 ' + (status.previewExact ? '与正式客户端逐字一致。' : '含独立试验改动。') : '正式来源待复核：' + status.changed.join(', '))
  process.exitCode = status.inSync ? 0 : 1
} else if (process.argv.includes('--accept-reviewed') || process.argv.includes('--sync-current-client')) {
  const index = process.argv.indexOf('--label')
  const label = index >= 0 ? process.argv[index + 1] : ''
  if (!label) throw new Error('请提供已复核的 --label "main@<完整 SHA>"')
  if (process.argv.includes('--sync-current-client')) {
    const candidate = hash(await readFile(path.join(prototypeDir, 'client.prototype.js')))
    if (candidate !== baseline.hashes.client) throw new Error('原型含试验改动，拒绝覆盖。请先比较并合并差异。')
    await copyFile(path.join(packageRoot, 'src/client.js'), path.join(prototypeDir, 'client.prototype.js'))
  }
  baseline.hashes = await sourceHashes()
  baseline.productionBaseline = label
  baseline.checkedAt = new Date().toISOString().slice(0, 10)
  baseline.hostReference = 'deepseek-harness@687f282e8625c6b8d11ff58211a90524be2e4317'
  await writeFile(file, JSON.stringify(baseline, null, 2) + '\n')
  console.log('已记录复核基线。--accept-reviewed 本身不替代界面对照。')
} else {
  console.log('--check：检查来源漂移；--accept-reviewed --label：记录复核；--sync-current-client --label：无试验改动时同步客户端。')
}
