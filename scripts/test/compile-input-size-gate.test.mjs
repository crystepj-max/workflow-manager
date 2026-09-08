// 编译输入尺寸闸门测试（#131）：超限明确拒绝（中文报错可定位），闸内大图实测编译响应 < 1MB 通道上限。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import validatorCore from '../validate-core.cjs';
import { compileBlueprint } from '../generate.mjs';

const {
  validateBlueprint,
  compileInputSizeViolation,
  COMPILE_INPUT_LIMIT_TOTAL_BYTES,
  COMPILE_INPUT_LIMIT_GOAL_BYTES,
} = validatorCore;

const here = path.dirname(fileURLToPath(import.meta.url));
const good = JSON.parse(readFileSync(path.join(here, '../../templates/custom-seeds/dev-workflow-2-0.json'), 'utf8'));

const clone = (bp) => JSON.parse(JSON.stringify(bp));
const setGoal = (bp, id, text) => {
  const n = bp.nodes.find((x) => x.id === id);
  assert.ok(n, '测试基座缺少节点 ' + id);
  n.goal = text;
  return bp;
};

// 构造「JSON.stringify 后转义字节恰为 bytes」的 goal 文本：
// 中文/引号头部与编译嵌入口径同源（UTF-8 多字节 + 转义），ASCII 填充精确凑到目标字节。
function goalWithEscapedBytes(bytes) {
  const head = '【节点目标】"需求分析"与《评审》纪要；'
  const headEscaped = JSON.stringify(head).slice(1, -1)
  const padAscii = 'a'.repeat(Math.max(0, bytes - 2 - Buffer.byteLength(headEscaped)))
  return JSON.parse('"' + headEscaped + padAscii + '"')
}

test('闸门常量与现状体量的关系：原始模板轻松过闸（不误伤）', () => {
  assert.equal(compileInputSizeViolation(good), null);
  assert.equal(validateBlueprint(good).ok, true);
  assert.ok(COMPILE_INPUT_LIMIT_TOTAL_BYTES < 1024 * 1024, '总闸必须小于通道上限');
});

test('校验早闸：单节点 goal 超子闸 → 报错定位到节点', () => {
  const bp = setGoal(clone(good), 'dispatch', goalWithEscapedBytes(COMPILE_INPUT_LIMIT_GOAL_BYTES + 1));
  const v = validateBlueprint(bp);
  assert.equal(v.ok, false);
  const hit = v.errors.find((e) => e.at === '$.nodes[dispatch].goal');
  assert.ok(hit, '应有 $.nodes[dispatch].goal 尺寸错误：' + JSON.stringify(v.errors));
  assert.match(hit.message, /单节点上限/);
  assert.match(hit.message, /425KB/);
});

test('校验早闸：goal 在子闸内且总量在上限内 → 通过', () => {
  const bp = setGoal(clone(good), 'dispatch', goalWithEscapedBytes(COMPILE_INPUT_LIMIT_GOAL_BYTES - 1024));
  const total = Buffer.byteLength(JSON.stringify(bp));
  assert.ok(total <= COMPILE_INPUT_LIMIT_TOTAL_BYTES, '前置：该用例总量须在闸内');
  assert.equal(validateBlueprint(bp).ok, true);
});

test('校验早闸：各节点 goal 均在子闸内但总量超限 → 报错指向总量', () => {
  const perGoal = 300 * 1024;
  assert.ok(perGoal <= COMPILE_INPUT_LIMIT_GOAL_BYTES, '前置：单 goal 须在子闸内');
  let bp = clone(good);
  for (const id of ['dispatch', 'dev', 'dev-2']) bp = setGoal(bp, id, goalWithEscapedBytes(perGoal));
  assert.ok(Buffer.byteLength(JSON.stringify(bp)) > COMPILE_INPUT_LIMIT_TOTAL_BYTES, '前置：总量须超限');
  const v = validateBlueprint(bp);
  assert.equal(v.ok, false);
  const hit = v.errors.find((e) => e.at === '$');
  assert.ok(hit, '应有 $ 总量尺寸错误：' + JSON.stringify(v.errors));
  assert.match(hit.message, /超过上限/);
});

test('编译主闸：compileBlueprint 对超限图抛出可读错误（覆盖未经校验的临时图路径）', () => {
  const bp = setGoal(clone(good), 'dispatch', goalWithEscapedBytes(COMPILE_INPUT_LIMIT_GOAL_BYTES + 1024));
  assert.throws(() => compileBlueprint(bp), (e) => /工作流文档过大/.test(e.message) && /dispatch/.test(e.message));
});

test('CLI 端到端：1MB 单节点 goal 的图（#131 原始案例量级）被明确拒绝且报错可读', () => {
  const bp = setGoal(clone(good), 'dispatch', goalWithEscapedBytes(1035000));
  const dir = mkdtempSync(path.join(tmpdir(), 'csg-over-'));
  try {
    const file = path.join(dir, 'oversize.json');
    writeFileSync(file, JSON.stringify(bp));
    let threw = null;
    try {
      execFileSync(process.execPath, [path.join(here, '../generate.mjs'), 'compile', file], { encoding: 'utf8' });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, '编译应失败退出');
    assert.equal(threw.status, 1);
    const reported = JSON.parse(threw.stderr);
    assert.equal(reported.ok, false);
    assert.match(reported.error, /工作流文档过大/);
    assert.match(reported.error, /dispatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI 端到端实证：闸内大图（约 830KB，中文+引号混合）编译成功且响应字节数 < 1MB', () => {
  const baseTotal = Buffer.byteLength(JSON.stringify(good));
  const target = COMPILE_INPUT_LIMIT_TOTAL_BYTES - 20 * 1024; // 830KB 量级，留 20KB 余量
  const perGoal = Math.floor((target - baseTotal) / 3);
  assert.ok(perGoal > 0 && perGoal <= COMPILE_INPUT_LIMIT_GOAL_BYTES, '前置：均摊 goal 须在子闸内');
  let bp = clone(good);
  for (const id of ['dispatch', 'dev', 'dev-2']) bp = setGoal(bp, id, goalWithEscapedBytes(perGoal));
  // 前置：该图必须通过校验闸（保证性质的实证对象 = 「通过闸门的图」）
  assert.equal(validateBlueprint(bp).ok, true, '闸内大图必须通过校验');

  const dir = mkdtempSync(path.join(tmpdir(), 'csg-under-'));
  try {
    const file = path.join(dir, 'big-but-legal.json');
    writeFileSync(file, JSON.stringify(bp));
    const stdout = execFileSync(process.execPath, [path.join(here, '../generate.mjs'), 'compile', file], { encoding: 'utf8' });
    const responseBytes = Buffer.byteLength(stdout);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true, '编译应成功：' + String(stdout).slice(0, 200));
    assert.ok(
      responseBytes < 1024 * 1024,
      '实测编译响应 ' + responseBytes + 'B 必须小于通道上限 1048576B（#131 保证性质实证）'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
