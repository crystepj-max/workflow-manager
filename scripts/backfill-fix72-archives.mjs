import fs from 'node:fs'

// FIX-72 数据回填：只按登记册与 git 实况已存在的事实写入（R-5/R-9），不编造任何字段。
const ids = ['LOC-024', 'LOC-025', 'LOC-026', 'LOC-027', 'LOC-029', 'LOC-030', 'LOC-031', 'LOC-032', 'LOC-033', 'FIX-69']
const { loadRegistry, saveRegistry, writeBoard } = await import('./local-task-registry.mjs')
const repo = process.cwd()
const reg = loadRegistry(repo)

// ① branch_retained=false（分支已被 CNB 合并删除——实况核对：10 条分支均不存在；
//    FIX-69 本就是 false；LOC-032 branch=null，false 同为事实：未保留任何分支）
let flipped = 0
for (const t of reg.tasks) {
  if (ids.includes(t.task_id) && t.branch_retained === true) {
    t.branch_retained = false
    flipped++
  }
}
console.log('branch_retained true→false:', flipped, '条')
saveRegistry(repo, reg)

// ② 轻量归档（凭据全部取自登记册现存字段）
const now = new Date().toISOString()
let created = 0
for (const id of ids) {
  const t = reg.tasks.find((x) => x.task_id === id)
  if (!t) throw new Error(`登记册缺 ${id}`)
  if (t.status !== '已合并' || !t.merge || !t.merge.commit || !t.remote) {
    throw new Error(`${id} 不满足远程收口事实（status/merge/remote 缺失），拒绝回填`)
  }
  const dir = `docs/tasks/archive/${id}`
  fs.mkdirSync(dir, { recursive: true })
  const summary = {
    task_id: id,
    task_name: t.name,
    status: '已合并',
    archive_form: 'lightweight-remote',
    remote_ref: t.remote,
    merge: { commit: t.merge.commit, merged_at: t.merge.merged_at },
    branch: t.branch,
    branch_retained: t.branch_retained,
    generated_by: 'FIX-72（fix-72-r1）轻量归档回填',
    generated_at: now,
    note: '远程收口任务：经 CNB 合并请求合入，本地未走收口流程。规格正文与任务详情以远端 issue 为源（本存根仅记指针与凭据，不复制正文）；若远端 issue 被清理，该部分历史不可恢复——此风险已在 FIX-72 规格已知限制中声明。',
  }
  fs.writeFileSync(`${dir}/evidence-summary.json`, JSON.stringify(summary, null, 2) + '\n')
  if (!fs.existsSync(`${dir}/${id}-remote-closeout.md`)) {
    const card = [
      `# ${id} · 远程收口任务卡存根`,
      '',
      `> 本文件是**轻量归档存根**（FIX-72 语义分层：远程收口=存根+摘要）。任务名称：${t.name}`,
      '',
      '| 项 | 值 |',
      '|---|---|',
      `| 状态 | 已合并（merge \`${t.merge.commit.slice(0, 7)}\` @ ${t.merge.merged_at}） |`,
      `| 远端 | ${t.remote}（规格正文与详情以此为源，不复制） |`,
      `| 分支 | ${t.branch ?? '（无记录）'}（已随 CNB 合并删除，branch_retained=false） |`,
      '',
      '凭据校验字段见同目录 `evidence-summary.json`（merge.commit 与登记册逐字一致 + remote_ref）。',
    ].join('\n')
    fs.writeFileSync(`${dir}/${id}-remote-closeout.md`, card + '\n')
  }
  created++
}
console.log('轻量归档:', created, '个')
writeBoard(repo)
console.log('看板已重写')
