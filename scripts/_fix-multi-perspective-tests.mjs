import fs from 'node:fs'

const generatePath = 'scripts/test/generate.test.mjs'
let generate = fs.readFileSync(generatePath, 'utf8')
const oldGenerate = `  assert.equal(report.length, 2, '两个蓝图（dev-workflow-2-0 + default-workflow）都产出');
  assert.equal(report[0].ok, true);`
const newGenerate = `  assert.deepEqual(report.map((r) => r.id).sort(), ['default-workflow', 'dev-workflow-2-0', 'multi-perspective-exploration'], '三套内置蓝图都产出');
  assert.ok(report.every((r) => r.ok), JSON.stringify(report));`
if (!generate.includes(oldGenerate)) throw new Error('generate test anchor not found')
generate = generate.replace(oldGenerate, newGenerate)
fs.writeFileSync(generatePath, generate)

const runtimePath = 'scripts/test/runtime.test.mjs'
let runtime = fs.readFileSync(runtimePath, 'utf8')
const oldRuntime = `  tpl.nodes.forEach((n) => {
    if (n.output && n.output.files && typeof n.output.files === 'object') Object.keys(n.output.files).forEach((p) => declared.add(p))
  })`
const newRuntime = `  for (const name of readdirSync(tplDir).filter((f) => f.endsWith('.json'))) {
    const blueprint = JSON.parse(readFileSync(path.join(tplDir, name), 'utf8'))
    for (const n of blueprint.nodes || []) {
      if (n.output && n.output.files && typeof n.output.files === 'object') Object.keys(n.output.files).forEach((p) => declared.add(p))
    }
  }`
if (!runtime.includes(oldRuntime)) throw new Error('runtime contract test anchor not found')
runtime = runtime.replace(oldRuntime, newRuntime)
runtime = runtime.replace("assert.ok(roleNames.length >= 6, '角色文件齐全')", "assert.ok(roleNames.length >= 10, '角色文件齐全')")
fs.writeFileSync(runtimePath, runtime)

fs.rmSync('scripts/_fix-multi-perspective-tests.mjs', { force: true })
