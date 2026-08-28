import fs from 'node:fs'

const hostPath = 'packages/dsh-visual-workflow/src/host.js'
let host = fs.readFileSync(hostPath, 'utf8')

const oldComment = `    // 模型：内置角色 = 系统标准模板（dispatcher/dev/test/review/accept/closeout），
    // 常驻、只读、可查看/选择/基于其创建自定义变体；自定义角色 = 工作区
`
const newComment = `    // 模型：内置角色 = 系统标准模板（dispatcher/dev/test/review/accept/closeout +
    // orchestrator/researcher/synthesizer/evaluator），常驻、只读、可查看/选择/基于其创建
    // 自定义变体；自定义角色 = 工作区
`
if (!host.includes(oldComment)) throw new Error('host role model comment anchor not found')
host = host.replace(oldComment, newComment)

const oldBlock = `    const BUILTIN_ROLES = [
      { id: 'dispatcher', name: '调度', summary: '调度角色：三要素门禁、分支判定、分流转发' },
      { id: 'dev', name: '开发', summary: '开发角色：测试驱动施工，满足质量闸门' },
      { id: 'test', name: '测试', summary: '测试角色：运行态验证，证据驱动判定' },
      { id: 'review', name: '审核', summary: '审核角色：独立双轴审查' },
      { id: 'accept', name: '验收', summary: '验收角色：最终核验，人工验收门禁' },
      { id: 'closeout', name: '收口', summary: '收口角色：一致性收口与交接产物汇总' }
    ]
`
const newBlock = `    const BUILTIN_ROLES = [
      { id: 'dispatcher', name: '调度', summary: '调度角色：三要素门禁、分支判定、分流转发' },
      { id: 'dev', name: '开发', summary: '开发角色：测试驱动施工，满足质量闸门' },
      { id: 'test', name: '测试', summary: '测试角色：运行态验证，证据驱动判定' },
      { id: 'review', name: '审核', summary: '审核角色：独立双轴审查' },
      { id: 'accept', name: '验收', summary: '验收角色：最终核验，人工验收门禁' },
      { id: 'closeout', name: '收口', summary: '收口角色：一致性收口与交接产物汇总' },
      { id: 'orchestrator', name: '探索统筹', summary: '探索统筹角色：理解复杂问题，设计互补研究视角并生成专家任务书' },
      { id: 'researcher', name: '专家研究', summary: '专家研究角色：按指定专业视角独立研究，提供证据、反证和不确定性' },
      { id: 'synthesizer', name: '综合分析', summary: '综合分析角色：综合独立观点，识别共识、分歧、关键假设和证据强弱' },
      { id: 'evaluator', name: '结论评估', summary: '结论评估角色：独立判断研究是否足以支持结论，并决定结束或补充探索' }
    ]
`
if (!host.includes(oldBlock)) throw new Error('BUILTIN_ROLES anchor not found')
host = host.replace(oldBlock, newBlock)
host = host.replace('统一角色清单：内置六角色常驻', '统一角色清单：内置十角色常驻')
fs.writeFileSync(hostPath, host)

const testPath = 'packages/dsh-visual-workflow/tests/host.test.mjs'
let text = fs.readFileSync(testPath, 'utf8')
const ids6 = "['accept', 'closeout', 'dev', 'dispatcher', 'review', 'test']"
const ids10 = "['accept', 'closeout', 'dev', 'dispatcher', 'evaluator', 'orchestrator', 'researcher', 'review', 'synthesizer', 'test']"
text = text.replace("test('vwf.roles 无 fs 服务时内置六角色常驻（builtin 标识）'", "test('vwf.roles 无 fs 服务时内置十角色常驻（builtin 标识）'")
text = text.replace("assert.equal(r.roles.filter(x => x.builtin).length, 6, '无 fs 时仅内置常驻')", "assert.equal(r.roles.filter(x => x.builtin).length, 10, '无 fs 时仅内置常驻')")
text = text.replace(ids6, ids10)
text = text.replace(ids6, ids10)
text = text.replace("test('vwf.roles：仓库根无 dsh/roles 目录时内置六角色常驻（静态/web 模式兜底）'", "test('vwf.roles：仓库根无 dsh/roles 目录时内置十角色常驻（静态/web 模式兜底）'")
text = text.replace("test('角色库：内置六角色常驻置前并带 builtin 标识，工作区额外 .md 归为自定义'", "test('角色库：内置十角色常驻置前并带 builtin 标识，工作区额外 .md 归为自定义'")
const oldSlice = "assert.deepEqual(r.roles.map(x => x.id).slice(0, 6), ['dispatcher', 'dev', 'test', 'review', 'accept', 'closeout'], '内置六角色常驻且置前')"
const newSlice = "assert.deepEqual(r.roles.map(x => x.id).slice(0, 10), ['dispatcher', 'dev', 'test', 'review', 'accept', 'closeout', 'orchestrator', 'researcher', 'synthesizer', 'evaluator'], '内置十角色常驻且置前')"
if (!text.includes(oldSlice)) throw new Error('host test built-in order anchor not found')
text = text.replace(oldSlice, newSlice)
fs.writeFileSync(testPath, text)

fs.rmSync('.github/workflows/_apply-multi-perspective.yml', { force: true })
fs.rmSync('scripts/_apply-multi-perspective.mjs', { force: true })
