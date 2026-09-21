// 根 validate（T-IMP-10，FR-4）
// ① 校验 templates/ 每个蓝图（契约 §3）
// ② 幂等重生成比对：编译全部蓝图到 .generated.check/（gitignore），与 .generated/ 逐文件比对（T-04 Q2）
// ③ 引擎层测试 + 包测试（packages/dsh-visual-workflow，T-IMP-06 起接入）
// 用法：npm run validate；CI（push/PR）执行并以非零退出阻断。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import validatorCore from './validate-core.cjs';
const { validateBlueprint } = validatorCore;
import { generateAll, listBlueprintJsonFiles, compareGeneratedFiles } from './generate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const TPL_DIR = path.join(root, 'templates');
const GEN_DIR = path.join(root, '.generated');


let failures = 0;
const fail = (msg) => { failures++; console.log('❌ ' + msg); };
const pass = (msg) => console.log('✅ ' + msg);

// 失败摘要：此前只截输出的最后 4 行，正好把「哪个用例失败」整段截掉，
// CI 上只剩 `operator: 'strictEqual'` 这类残片，无法定位（CHORE-112 登记项）。
// spec 报告器失败清单形如：`test at 文件:行:1` / `✖ 名称 (12.3ms)` / `  AssertionError: 消息`；
// TAP 下名称行是 `not ok N - 名称`。两种都认，解析不到时退回输出尾部而不是静默少报。
const summarizeTestFailure = (out, label) => {
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = String(out || '').split('\n');
  const items = [];
  const nameRe = /^\s*(?:✖ |not ok \d+ - )(.+?)(?:\s+\([\d.]+m?s\))?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = nameRe.exec(lines[i]);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || name === 'failing tests:') continue;
    let where = '';
    for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
      const w = /^test at (\S+)/.exec(lines[j]);
      if (w) { where = w[1]; break }
    }
    let err = '';
    for (let k = i + 1; k <= i + 6 && k < lines.length; k++) {
      const l = lines[k];
      if (!l.trim()) continue;
      if (/^\s*(?:at |ℹ|\u2716|\u2714|not ok )/.test(l)) break;
      err = clip(l, 220);
      break;
    }
    items.push({ name, where, err });
  }
  if (!items.length) return label + '：未从输出解析到失败用例，输出尾部：\n' + lines.slice(-10).join('\n');
  // 同一用例会出现两次（正文一次 + 失败清单一次），保留带错误行的那条
  const byName = new Map();
  for (const it of items) {
    const prev = byName.get(it.name);
    if (!prev || (!prev.err && it.err) || (it.err.length > (prev.err || '').length)) byName.set(it.name, it);
  }
  const merged = [...byName.values()];
  const shown = merged.slice(0, 15);
  const body = shown.map((it) => '  ✖ ' + it.name +
    (it.where ? '\n      位置：' + it.where : '') +
    (it.err ? '\n      错误：' + it.err : '')).join('\n');
  return label + '（' + merged.length + ' 个用例）：\n' + body +
    (merged.length > shown.length ? '\n  …另有 ' + (merged.length - shown.length) + ' 个未展开' : '');
};

// ① 蓝图校验 + 等价断言（正式内置 + custom-seeds 历史种子）
const tplAbs = listBlueprintJsonFiles(TPL_DIR);
console.log('—— ① 蓝图校验（' + tplAbs.length + ' 份）——');
for (const abs of tplAbs) {
  const bp = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const v = validateBlueprint(bp);
  if (!v.ok) {
    fail(bp.id + '：' + v.errors.map((e) => e.at + ' ' + e.message).join('；'));
    continue;
  }
  const kind = abs.includes(`${path.sep}custom-seeds${path.sep}`) ? '自定义种子' : '正式内置';
  pass(bp.id + '（' + kind + '）：结构合法（' + v.counts.nodes + ' 节点 / ' + v.counts.edges + ' 边）');
  // 等价验证由步骤③的运行时排练厅套件承担（runtime.test.mjs / runtime-host.test.mjs，
  // 真实执行生成脚本断言返回体状态机——替代原字符串嗅探断言）
}

// ② 幂等重生成比对（T-04 Q2；LOC-006 起比对逻辑单一权威 = generate.mjs compareGeneratedFiles）
console.log('—— ② 重生成一致性（内存生成 vs .generated/）——');
if (!fs.existsSync(GEN_DIR)) {
  fail('缺少 .generated/（生成物不存在）：请先运行 npm run generate');
} else {
  const { files } = generateAll(TPL_DIR);
  const { missing, extra, changed } = compareGeneratedFiles(files, GEN_DIR);
  const mismatch = [...missing, ...extra, ...changed];
  if (mismatch.length) fail('生成物与重生成不一致（' + mismatch.length + ' 个文件，可能手改或过期）：' + mismatch.slice(0, 5).join('、') + '——请重跑 npm run generate');
  else pass('生成物与重生成一致（' + files.size + ' 个文件）');
}

// ②′ LOC-040：生成 Skill runbook 漂移与四模板语义探针
console.log('—— ②′ 生成指南漂移检查 ——');
try {
  execFileSync(process.execPath, ['scripts/validate-guide-drift.mjs'], { cwd: root, stdio: 'pipe' });
  pass('生成 Skill runbook 与蓝图一致');
} catch (e) {
  fail('生成指南漂移：' + String(e.stdout || e.stderr || e.message).trim().split('\n').slice(-6).join('\n'));
}

// ③ 引擎层测试 + 包测试
console.log('—— ③ 引擎层测试 ——');
try {
  execFileSync(process.execPath, ['--test', 'scripts/test/*.test.mjs'], { cwd: root, stdio: 'pipe', shell: true });
  pass('引擎层测试全绿');
} catch (e) {
  fail(e.stdout ? summarizeTestFailure(e.stdout, '引擎层测试失败') : '引擎层测试失败：' + e.message);
}
// ③′ 包测试：自动发现 packages/* 下所有带 test 脚本的包。
// 新增包会自动纳入，无需在此登记——此前硬编码单个包名导致
// packages/dsh-llm-account-auth 的测试从未被执行（#184 同类问题）。
const packagesDir = path.join(root, 'packages');
const testPackages = (fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir, { withFileTypes: true }) : [])
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = path.join(packagesDir, d.name);
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) return null;
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts || {};
    } catch (e) {
      return null;
    }
    return scripts.test ? { name: d.name, dir, scripts } : null;
  })
  .filter(Boolean);
// 直接执行 package.json 里声明的命令，而非 `npm run`：npm 启动本身有约 5s 开销，
// 两个包就是 10s。开头的 node 换成当前进程的可执行文件，保证与本次校验同一版本。
const runInPkg = (scriptLine, cwd) =>
  execFileSync(scriptLine.replace(/^node\b/, JSON.stringify(process.execPath)), { cwd, stdio: 'pipe', shell: true });
if (testPackages.length === 0) {
  fail('未发现任何带 test 脚本的包（packages/ 下应至少有一个），包测试被跳过');
} else {
  console.log('—— ③′ 包测试（' + testPackages.map((p) => p.name).join('、') + '）——');
  for (const pkg of testPackages) {
    try {
      if (pkg.scripts.build) runInPkg(pkg.scripts.build, pkg.dir);
      runInPkg(pkg.scripts.test, pkg.dir);
      pass('包测试全绿：' + pkg.name);
    } catch (e) {
      fail(e.stdout ? summarizeTestFailure(e.stdout, '包测试失败（' + pkg.name + '）') : '包测试失败（' + pkg.name + '）：' + e.message);
    }
  }
}

console.log(failures === 0 ? '\n✅ validate 通过' : '\n❌ validate 失败（' + failures + ' 项）');
process.exit(failures === 0 ? 0 : 1);
