// 根 validate（T-IMP-10，FR-4）
// ① 校验 templates/ 每个蓝图（契约 §3）
// ② 幂等重生成比对：编译全部蓝图到 .generated.check/（gitignore），与 .generated/ 逐文件比对（T-04 Q2）
// ③ 引擎层测试 + 包测试（packages/dsh-visual-workflow，T-IMP-06 起接入）
// 用法：npm run validate；CI（push/PR）执行并以非零退出阻断。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateBlueprint } from './validate-blueprint.mjs';
import { generateAll } from './generate.mjs';
import { assertEquivalence } from './equivalence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const TPL_DIR = path.join(root, 'templates');
const GEN_DIR = path.join(root, '.generated');


let failures = 0;
const fail = (msg) => { failures++; console.log('❌ ' + msg); };
const pass = (msg) => console.log('✅ ' + msg);

// ① 蓝图校验 + 等价断言
const tpls = fs.readdirSync(TPL_DIR).filter((f) => f.endsWith('.json')).sort();
console.log('—— ① 蓝图校验（' + tpls.length + ' 份）——');
for (const f of tpls) {
  const bp = JSON.parse(fs.readFileSync(path.join(TPL_DIR, f), 'utf8'));
  const v = validateBlueprint(bp);
  if (!v.ok) {
    fail(bp.id + '：' + v.errors.map((e) => e.at + ' ' + e.message).join('；'));
    continue;
  }
  pass(bp.id + '：结构合法（' + v.counts.nodes + ' 节点 / ' + v.counts.edges + ' 边）');
  // 等价断言：生成产物忠实表达蓝图（T-05）
  const { files } = generateAll(TPL_DIR);
  const script = files.get(bp.id + '/script.mjs');
  const eq = assertEquivalence(script, bp);
  if (!eq.ok) fail(bp.id + ' 等价断言：' + eq.failures.join('；'));
  else pass(bp.id + ' 等价断言：10 项全过');
}

// ② 幂等重生成比对（T-04 Q2：generateAll 内存产物 vs .generated/ 磁盘逐文件比对，无需临时目录）
console.log('—— ② 重生成一致性（内存生成 vs .generated/）——');
if (!fs.existsSync(GEN_DIR)) {
  fail('缺少 .generated/（生成物不存在）：请先运行 npm run generate');
} else {
  const { files } = generateAll(TPL_DIR);
  const genFiles = fs.readdirSync(GEN_DIR, { recursive: true }).filter((f) => fs.statSync(path.join(GEN_DIR, f)).isFile());
  const mismatch = [];
  for (const f of new Set([...genFiles, ...files.keys()])) {
    const disk = path.join(GEN_DIR, f);
    if (!fs.existsSync(disk) || !files.has(f) || fs.readFileSync(disk, 'utf8') !== files.get(f)) mismatch.push(f);
  }
  if (mismatch.length) fail('生成物与重生成不一致（' + mismatch.length + ' 个文件，可能手改或过期）：' + mismatch.slice(0, 5).join('、') + '——请重跑 npm run generate');
  else pass('生成物与重生成一致（' + genFiles.length + ' 个文件）');
}

// ③ 引擎层测试 + 包测试
console.log('—— ③ 引擎层测试 ——');
try {
  execFileSync(process.execPath, ['--test', 'scripts/test/*.test.mjs'], { cwd: root, stdio: 'pipe', shell: true });
  pass('引擎层测试全绿');
} catch (e) {
  fail('引擎层测试失败：' + String(e.stdout || e.message).split('\n').slice(-4).join('\n'));
}
console.log('—— ③′ 包测试（packages/dsh-visual-workflow：host 双根/异源 + client 冒烟）——');
try {
  execFileSync(process.execPath, ['--test', 'tests/host.test.mjs', 'tests/client.smoke.mjs'], { cwd: path.join(root, 'packages', 'dsh-visual-workflow'), stdio: 'pipe', shell: true });
  pass('包测试全绿');
} catch (e) {
  fail('包测试失败：' + String(e.stdout || e.message).split('\n').slice(-4).join('\n'));
}

console.log(failures === 0 ? '\n✅ validate 通过' : '\n❌ validate 失败（' + failures + ' 项）');
process.exit(failures === 0 ? 0 : 1);
