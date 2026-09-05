import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { compileBlueprint, generateAll, generateUserSkill, projectToVwf, skillWrap, writeUserSkill, collectBuiltinRoles, loadBuiltinRoleIds, loadBuiltinRoleDefs } from '../generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tplDir = path.join(here, '../../templates');
const bp = JSON.parse(readFileSync(path.join(tplDir, 'dev-workflow-2-0.json'), 'utf8'));
const fanoutBp = JSON.parse(readFileSync(path.join(here, 'fixtures/fanout-blueprint.json'), 'utf8'));

test('S2 生成器：产物四件套齐全', () => {
  const { files, report } = generateAll(tplDir);
  const id = 'dev-workflow-2-0';
  for (const rel of ['script.mjs', 'vwf-dsl.json', 'SKILL.md', 'meta.json']) {
    assert.ok(files.has(id + '/' + rel), '缺产物：' + rel);
  }
  assert.equal(report.length, 2, '两个蓝图（dev-workflow-2-0 + default-workflow）都产出');
  assert.equal(report[0].ok, true);
});

test('S2 生成器：route 折叠识别（FOLDS 注入）', () => {
  const { files, report } = generateAll(tplDir);
  assert.deepEqual(report[0].folds, ['route']);
  const script = files.get('dev-workflow-2-0/script.mjs');
  assert.ok(script.includes('"route"'), '脚本应内嵌 FOLDS 含 route');
});

test('S2 生成器：vwf-dsl 注入模型绑定（bindings 编译期固化）', () => {
  const { files } = generateAll(tplDir);
  const dsl = JSON.parse(files.get('dev-workflow-2-0/vwf-dsl.json'));
  const dev = dsl.nodes.find((n) => n.id === 'dev');
  assert.equal(dev.model.model, 'deepseek-v4-pro');
  const accept = dsl.nodes.find((n) => n.id === 'accept');
  assert.equal(accept.manualCheck, true);
});

test('S2 生成器：业务规则字段进 vwf DSL（候选二 Q7 修订），节点级 verifyBranch 不进', () => {
  const { files } = generateAll(tplDir);
  const dsl = JSON.parse(files.get('dev-workflow-2-0/vwf-dsl.json'));
  assert.ok(dsl.nodes.every((n) => !('verifyBranch' in n)), 'verifyBranch 节点级字段无编辑器 UI，不进 DSL');
  assert.equal(dsl.onMaxRounds, 'auto-reschedule', 'onMaxRounds 业务规则进 DSL（前端可配置）');
  assert.equal(dsl.heteroCheck, true, 'heteroCheck 业务规则进 DSL（前端可配置）');
  assert.equal(dsl.control.maxRounds, 9);
});

test('S2 生成器：bundleRoles 蓝图角色自包含分发（默认工作流用户级内置模板）', () => {
  const { files, report } = generateAll(tplDir);
  const rep = report.find((r) => r.id === 'default-workflow');
  assert.ok(rep && rep.ok, 'default-workflow 生成成功');
  assert.ok(files.has('default-workflow/roles/dispatcher.md'), '角色包随模板分发：dispatcher.md');
  assert.ok(files.has('default-workflow/roles/review.md'), '角色包随模板分发：review.md');
  const dsl = JSON.parse(files.get('default-workflow/vwf-dsl.json'));
  assert.equal(dsl.bundleRoles, true, 'DSL 投影携带 bundleRoles 标记');
  assert.ok(files.get('default-workflow/SKILL.md').includes('默认工作流'), 'SKILL.md 触发词含 displayName');
});

test('S2 生成器：SKILL.md 触发词含 displayName 与 id', () => {
  const { files } = generateAll(tplDir);
  const skill = files.get('dev-workflow-2-0/SKILL.md');
  assert.ok(skill.includes('name: dev-workflow-2-0'));
  assert.ok(skill.includes('开发工作流 2.0'));
});

test('S2 生成器：幂等（两次调用产物完全一致）', () => {
  const a = generateAll(tplDir);
  const b = generateAll(tplDir);
  assert.deepEqual([...a.files.keys()].sort(), [...b.files.keys()].sort());
  for (const [rel, content] of a.files) {
    assert.equal(content, b.files.get(rel), '产物不一致：' + rel);
  }
});

test('fanout 编译使用 pipeline、白名单 agent opts，并保持投影字段', () => {
  const { script } = compileBlueprint(fanoutBp);
  assert.ok(script.includes('pipeline('), 'fanout 产物应调用 pipeline');
  assert.ok(script.includes('const ITEM_CAP = 4096'));
  assert.ok(script.includes('const AGENT_CAP = 1000'));
  assert.ok(!/\b(?:require|process|fetch|setTimeout)\b/.test(script), '脚本不得使用沙箱外全局');
  assert.ok(!/\b(?:effort|isolation|agentType)\s*:/.test(script), 'agent opts 不得含非白名单字段');
  const dsl = projectToVwf(fanoutBp);
  const fan = dsl.nodes.find((n) => n.id === 'fan');
  assert.equal(fan.kind, 'fanout');
  assert.equal(fan.items, '$.args.items');
  assert.equal(fan.failOn, 'all');
});

test('#116 投影：humanDecision 与 HD 出边 result 进入 DSL', () => {
  const hd = JSON.parse(readFileSync(path.join(here, 'fixtures/human-decision-blueprint.json'), 'utf8'));
  hd.humanDecision = { maxRoundsReachedOptions: ['STOP', 'ADD_BUDGET'] };
  const dsl = projectToVwf(hd);
  assert.deepEqual(dsl.humanDecision, { maxRoundsReachedOptions: ['STOP', 'ADD_BUDGET'] });
  const out = dsl.edges.find((e) => e.from === '$human-decision');
  assert.equal(out.result, 'SHIP');
});

test('#128 投影：outcome / countRound / completionPath 透传，业务边不伪造 on', () => {
  const bp = JSON.parse(readFileSync(path.join(here, 'fixtures/outcome-evaluate-mini.json'), 'utf8'));
  const dsl = projectToVwf(bp);
  const ev = dsl.nodes.find((n) => n.id === 'evaluate');
  assert.equal(ev.output.outcomePath, '$.verdict');
  assert.equal(ev.output.completionPath, '$.completion_type');
  const opt = dsl.edges.find((e) => e.outcome === 'OPTIMIZE');
  assert.equal(opt.to, 'execute');
  assert.equal(opt.countRound, true);
  assert.equal(Object.prototype.hasOwnProperty.call(opt, 'on'), false);
  const tech = dsl.edges.find((e) => e.on === 'technical');
  assert.equal(tech.from, 'evaluate');
  assert.equal(Object.prototype.hasOwnProperty.call(tech, 'outcome'), false);
  const hdOut = dsl.edges.find((e) => e.from === '$human-decision');
  assert.equal(hdOut.outcome, 'USER_ACCEPTED');
  assert.equal(Object.prototype.hasOwnProperty.call(hdOut, 'on'), false);
});

test('fanout 编译与 skill 包装幂等，runbook 覆盖 cap 终态', () => {
  assert.equal(compileBlueprint(fanoutBp).script, compileBlueprint(fanoutBp).script);
  const skill = skillWrap(fanoutBp);
  assert.ok(skill.includes('FAILED_ITEM_CAP'));
  assert.ok(skill.includes('FAILED_AGENT_CAP'));
});

test('S2 生成器：非法蓝图编译失败并报错（不产出）', () => {
  const badDir = path.join(here, 'fixtures/bad-blueprint');
  const { files, report } = generateAll(badDir);
  assert.equal(report[0].ok, false);
  assert.equal(files.size, 0);
});

test('S2 generateUserSkill：用户模板 → 自包含 skill 三件套（T-03 save 即闭环）', () => {
  const files = generateUserSkill(bp);
  for (const rel of ['SKILL.md', 'script.mjs', 'meta.json']) {
    assert.ok(files.has(rel), '缺产物：' + rel);
  }
  const skill = files.get('SKILL.md');
  assert.ok(skill.includes('name: dev-workflow-2-0'), 'skill frontmatter name');
  assert.ok(skill.includes('开发工作流 2.0'), 'skill 触发词（displayName）');
  const script = files.get('script.mjs');
  assert.ok(script.includes('AWAITING_HUMAN_'), 'script 含人工门禁语义');
  assert.ok(script.includes('超限归因'), 'script 含超限归因（auto-reschedule）');
  const meta = JSON.parse(files.get('meta.json'));
  assert.equal(meta.name, 'vwf-dev-workflow-2-0');
});

test('#117 生成 skill 不再写死不通过去开发或不经门禁去收口', () => {
  const skill = skillWrap(bp);
  assert.equal(skill.includes('entry=dev'), false, '不得写死 entry=dev');
  assert.equal(skill.includes('entry=closeout'), false, '不得写死 entry=closeout');
  assert.equal(/不通过\s*→\s*entry=dev/.test(skill), false);
});

test('#119 coerceStructured 仅对 object/array schema 解析 JSON 字符串', () => {
  const { script } = compileBlueprint(bp);
  assert.equal(script.includes("if (root !== 'object' && root !== 'array') return v"), true);
});

test('#117 手写主会话手册同样不再写死这两跳', () => {
  const handbook = readFileSync(path.join(here, '../../dsh/skill/SKILL.md'), 'utf8');
  assert.equal(handbook.includes('entry=closeout'), false, '手册不得写死通过 → entry=closeout');
  assert.equal(handbook.includes('entry=dev'), false, '手册不得写死不通过 → entry=dev');
});

test('#117 主会话 README 不再写死不通过去开发或不经门禁去收口', () => {
  const readme = readFileSync(path.join(here, '../../dsh/README.md'), 'utf8');
  // 允许 JSONC `"approved":` 与裸 `approved:`；80 字符窗口覆盖同一续跑示例行
  const staleApprovedWithReject = /approved"?\s*:\s*true[\s\S]{0,80}不通过/;
  assert.equal(
    staleApprovedWithReject.test('"approved": true, "startRound": 3, "feedback": "人工验收不通过意见"'),
    true,
    '断言须能抓到带引号的 JSONC 键名',
  );
  assert.equal(readme.includes('entry=closeout'), false, 'README 不得写死通过 → entry=closeout');
  assert.equal(readme.includes('entry=dev'), false, 'README 不得写死不通过 → entry=dev');
  assert.equal(/打回起点\s*[（(]dev[）)]/.test(readme), false, '不得用自然语言写打回起点（dev）');
  assert.equal(staleApprovedWithReject.test(readme), false, '不得把 approved:true 与不通过意见写进同一续跑示例');
});

// ── 候选四 T-IMP-14 · 原子写盘（失败零残留） ──
const makeTmp = () => mkdtempSync(path.join(tmpdir(), 'vwf-skill-'))
const rmTmp = (dir) => { try { execFileSync('/bin/rm', ['-rf', dir]) } catch (e) {} }
const realIo = {
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  writeFileSync: (p, c) => fs.writeFileSync(p, c),
  renameSync: (a, b) => fs.renameSync(a, b),
  readdirSync: (p) => fs.readdirSync(p),
  statSync: (p) => fs.statSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
  rmdirSync: (p) => fs.rmdirSync(p),
  // issue-81：collectBuiltinRoles 读角色源用
  readFileSync: (p, o) => fs.readFileSync(p, o),
}

test('C4 原子写盘-成功：三件套落盘且与 generateUserSkill 内容一致，无暂存残留', () => {
  const tmp = makeTmp()
  try {
    const r = writeUserSkill(bp, tmp, realIo)
    assert.equal(r.ok, true, r.error)
    for (const rel of ['SKILL.md', 'script.mjs', 'meta.json']) {
      assert.equal(readFileSync(path.join(r.dir, rel), 'utf8'), generateUserSkill(bp).get(rel), rel + ' 内容一致')
    }
    const kids = fs.readdirSync(tmp)
    assert.deepEqual(kids, ['dev-workflow-2-0'], '无暂存目录残留')
  } finally { rmTmp(tmp) }
})

test('C4 原子写盘-中途失败：暂存与已写文件零残留（注入第 2 个文件写失败）', () => {
  const tmp = makeTmp()
  try {
    let writes = 0
    const failingIo = {
      ...realIo,
      writeFileSync: (p, c) => { writes++; if (writes === 2) throw new Error('磁盘满（模拟）'); return fs.writeFileSync(p, c) },
    }
    const r = writeUserSkill(bp, tmp, failingIo)
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('磁盘满'))
    assert.deepEqual(fs.readdirSync(tmp), [], '失败后目录零残留（含暂存区）')
  } finally { rmTmp(tmp) }
})

test('C4 原子写盘-更新失败：旧版本目录不受影响（换入未发生）', () => {
  const tmp = makeTmp()
  try {
    const finalDir = path.join(tmp, 'dev-workflow-2-0')
    fs.mkdirSync(finalDir, { recursive: true })
    fs.writeFileSync(path.join(finalDir, 'OLD.md'), '旧版本')
    let writes = 0
    const failingIo = {
      ...realIo,
      writeFileSync: (p, c) => { writes++; if (writes === 2) throw new Error('磁盘满（模拟）'); return fs.writeFileSync(p, c) },
    }
    const r = writeUserSkill(bp, tmp, failingIo)
    assert.equal(r.ok, false)
    assert.equal(readFileSync(path.join(finalDir, 'OLD.md'), 'utf8'), '旧版本', '更新失败时旧版本完整保留')
  } finally { rmTmp(tmp) }
})

// ── Codex PR#124 第三轮 P1（评论 3889725489）：用户 skill 捆绑内置角色定义 ──
// 产品工作区通常没有 dsh/roles/ 树，generateUserSkill 只产出三件套，运行时找不到
// 新内置角色定义。writeUserSkill 在 save 闭环时把蓝图引用的角色文件随 skill 一起
// 写到 roles/ 子目录，compileViaPipeline 命中即带出 roleDir，运行时自包含。
test('S3 用户 skill 捆绑蓝图引用的内置角色定义（issue-81，产品工作区无 dsh/roles/ 时自定义工作流可运行）', () => {
  const tmp = makeTmp()
  try {
    const r = writeUserSkill(bp, tmp, realIo)
    assert.equal(r.ok, true, r.error)
    // bp = dev-workflow-2-0 模板，节点 profile = dispatcher/dev/review/test/accept/closeout
    const rolesDir = path.join(r.dir, 'roles')
    const roleFiles = fs.readdirSync(rolesDir).sort()
    for (const id of ['dispatcher', 'dev', 'review', 'test', 'accept', 'closeout']) {
      assert.ok(roleFiles.includes(id + '.md'), '角色已捆绑：' + id)
    }
    // 内容与源一致
    const srcDir = path.join(here, '..', '..', 'dsh', 'roles')
    assert.equal(
      readFileSync(path.join(r.dir, 'roles', 'dispatcher.md'), 'utf8'),
      readFileSync(path.join(srcDir, 'dispatcher.md'), 'utf8'),
      'dispatcher 内容与源一致'
    )
    // 三件套仍在
    for (const rel of ['SKILL.md', 'script.mjs', 'meta.json']) {
      assert.ok(fs.existsSync(path.join(r.dir, rel)), '三件套仍在：' + rel)
    }
  } finally { rmTmp(tmp) }
})

// ── Codex PR#124 第三轮 P1（评论 3889725481）：roleRef 工作区优先 + 打包兜底 ──
test('S4 roleRef：内置角色以打包快照优先，自定义角色以工作区优先（Codex 第四轮 P1）', () => {
  // 回归：第三轮把「工作区优先」套用到所有角色，导致项目里一份旧版 dsh/roles/dev.md
  // 会静默覆盖模板自带的版本化内置角色定义（内置角色本应只读且随模板版本分发）。
  const ids = ['dev', 'closeout']
  const { script } = compileBlueprint(bp, { builtinRoleIds: ids })
  assert.ok(script.includes('const BUILTIN_ROLE_IDS = ["dev","closeout"]'), '注入内置角色清单')
  assert.ok(script.includes('BUILTIN_ROLE_IDS.indexOf(name) >= 0'), '按内置/自定义分流')
  assert.ok(script.includes('_b ? [_bundle, _ws] : [_ws, _bundle]'), '内置先打包、自定义先工作区')
  assert.ok(script.includes("A.roleDir || 'dsh/roles'"), '保留 A.roleDir 打包兜底链路')
  assert.ok(script.includes("'dsh/roles/' + name + '.md'"), '保留工作区路径')
})

// ── #129 遗留项 2：临时/未保存图编译自包含（内置角色正文编译期内联 ROLE_DEFS）──
test('S5 内置角色正文编译期内联：ROLE_DEFS 注入 + roleRef 优先内联 + stale 产物安全回退', () => {
  const devContent = readFileSync(path.join(here, '..', '..', 'dsh', 'roles', 'dev.md'), 'utf8')
  assert.ok(devContent.includes('你是开发 Agent'), '夹具卫生：dev.md 存在且非空')
  const { script } = compileBlueprint(bp, { builtinRoleIds: ['dev'] })
  assert.ok(script.includes('const ROLE_DEFS = '), '编译脚本应注入 ROLE_DEFS')
  assert.ok(script.includes(JSON.stringify(devContent)), '内置角色 dev 正文应内联进 ROLE_DEFS（临时编译自包含，不依赖 dsh/roles 存在）')
  assert.ok(script.includes("typeof ROLE_DEFS === 'undefined' ? undefined : ROLE_DEFS[name]"), 'roleRef 应优先读内联定义；stale 产物缺 ROLE_DEFS 声明时 typeof 三元守卫显式回退 undefined（评论 3900312838）')
  assert.ok(script.includes('【角色定义】（内置角色，编译期内联'), '内联分支应有明确标识')
  // 注入覆盖：测试/宿主可显式传 builtinRoleDefs（不依赖磁盘角色源）
  const { script: s2 } = compileBlueprint(bp, { builtinRoleIds: ['dev'], builtinRoleDefs: { dev: '内联测试正文\n' } })
  assert.ok(s2.includes(JSON.stringify('内联测试正文\n')), 'opts.builtinRoleDefs 可注入覆盖磁盘读取')
})

// ── Codex PR#130 P1（评论 3900290054）：内联仅限蓝图引用角色，避免临时编译 stdout 超 64KB ──
test('S6 内联仅限蓝图引用内置角色：最小图产物 < 宿主 64KB stdout 捕获上限，且 12 角色均可加载', () => {
  const mini = JSON.parse(readFileSync(path.join(here, 'fixtures', 'hello-blueprint.json'), 'utf8'))
  const devContent = readFileSync(path.join(here, '..', '..', 'dsh', 'roles', 'dev.md'), 'utf8')
  const orchContent = readFileSync(path.join(here, '..', '..', 'dsh', 'roles', 'orchestrator.md'), 'utf8')
  const { script } = compileBlueprint(mini)
  assert.ok(script.includes(JSON.stringify(devContent)), '引用到的内置角色（dev）内联')
  assert.ok(!script.includes(JSON.stringify(orchContent)), '未引用内置角色（orchestrator）不内联——避免全量内联撑爆 stdout')
  assert.ok(Buffer.byteLength(script, 'utf8') < 64 * 1024, '最小图编译产物 < 64KB（宿主 runNode maxBytes:64*1024，host.js:137）')
  // 覆盖验收：12 个内置角色均可被内联加载（按引用过滤只影响单图体积，不影响能力面）
  const all = loadBuiltinRoleDefs(loadBuiltinRoleIds())
  assert.equal(Object.keys(all).length, 12, '12 个内置角色均可加载内联')
  // 全 12 内置角色各一节点的合法图（Codex PR#130 第二轮 P1，评论 3900291469）：JSON 响应
  // 必须 < 编译路径捕获上限（host.js runNode maxBytes: 1MB）——引用过滤不足以兜住该最坏情况。
  const ids = loadBuiltinRoleIds()
  const twelve = { id: 't12', control: { maxRounds: 3 }, nodes: [], edges: [] }
  for (const [i, rid] of ids.entries()) {
    twelve.nodes.push({ id: 'n' + i, profile: rid, label: rid, goal: 'g' })
    if (i > 0) twelve.edges.push({ from: 'n' + (i - 1), to: 'n' + i, on: 'success' })
  }
  const { script: s12 } = compileBlueprint(twelve)
  const resp12 = JSON.stringify({ ok: true, script: s12, meta: {} })
  assert.ok(Buffer.byteLength(resp12, 'utf8') < 1024 * 1024, '12 角色全用图的 JSON 响应 < 编译路径 1MB 捕获上限（host.js runNode maxBytes）')
})

test('S4 内置角色清单：单一事实源为 manifest（dsh/roles/builtin-roles.json），解析失败 loud-fail', () => {
  const ids = loadBuiltinRoleIds()
  assert.ok(ids.length >= 12, `内置角色不少于 12 个（实际 ${ids.length}）`)
  assert.ok(ids.includes('requirements') && ids.includes('synthesizer'), '含新增角色')
  assert.ok(!ids.includes('dispatcher'), 'dispatcher 已迁出内置')
  // 来源证明：不再反向解析 host.js 源码——传入任何字符串都被当作 manifest 路径处理
  assert.throws(() => loadBuiltinRoleIds('const BUILTIN_ROLES = []'), /解析失败/, '非路径输入按 manifest 读取失败报错')
  assert.throws(() => loadBuiltinRoleIds(''), /解析失败/, '空路径报错')
  // 损坏 manifest loud-fail（写入临时文件验证 fail-closed，不退化为空清单）
  const tmp = path.join(tmpdir(), 'vwf-bad-manifest-' + process.pid + '.json')
  fs.writeFileSync(tmp, '{"schemaVersion":1,"builtins":[]}', 'utf8')
  try {
    assert.throws(() => loadBuiltinRoleIds(tmp), /解析失败/, '空清单 manifest 应报错')
  } finally {
    fs.unlinkSync(tmp)
  }
})

test('S7 #93：编译脚本注入 workspace 默认 args 与 SOURCE cwd', () => {
  const { script } = compileBlueprint(bp)
  assert.ok(script.includes('const __VWF_WS_DEFAULTS__ = {}'), '宿主可替换的 workspace 默认 args 桩')
  assert.ok(script.includes("const A = Object.assign({}, __VWF_WS_DEFAULTS__, args || {})"), 'args 覆盖注入的默认 workspace 字段')
  assert.ok(script.includes('if (SOURCE) opts.cwd = SOURCE'), 'callNode 把业务源码目录绑到 agent cwd')
  assert.ok(script.includes('if (SOURCE) itemOpts.cwd = SOURCE'), 'fanout 子代理同样绑定 cwd')
  assert.ok(script.includes('【本节点应产出 Formal Artifact】'), '与 #69 Formal Artifact 提示并存')
  assert.ok(script.includes('业务源码读写目录'), 'SOURCE 存在时提示隔离现场')
})

test('S4 捆绑角色：profile 含路径穿越被拒绝（Codex 第四轮 P1）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roles-'))
  fs.writeFileSync(path.join(dir, 'dev.md'), '内置角色正文\n')
  const traversal = { nodes: [{ id: 'n1', profile: '../../AGENTS' }, { id: 'n2', profile: 'a/b' }, { id: 'n3', profile: 'dev' }] }
  const out = collectBuiltinRoles(traversal, dir)
  assert.deepEqual([...out.keys()], ['roles/dev.md'], '仅安全标识被捆绑')
})
