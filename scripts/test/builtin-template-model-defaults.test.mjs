import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import validatorCore from '../validate-core.cjs';

const { validateBlueprint } = validatorCore;

const here = path.dirname(fileURLToPath(import.meta.url));
const loadTemplate = (id) => JSON.parse(readFileSync(path.join(here, '../../templates/' + id + '.json'), 'utf8'));

const PROVIDER = 'deepseek-official';
// 默认档模型（开发/执行/门禁/收口等非验证节点）
const DEFAULT_MODEL = 'deepseek-flash';
// 验证角色模型（承担独立验证或回归职责的节点：收敛审查 / 审核 / 测试 / 回归验证 / 评估）
const VERIFY_MODEL = 'deepseek-v4-flash';

// LOC-019 需求基线 V1 §6 逐模板映射表：四套内置模板默认绑定 DeepSeek 化
const EXPECTED = {
  'wf-construction-full-feature': {
    preflight: DEFAULT_MODEL,
    dev: DEFAULT_MODEL,
    review: VERIFY_MODEL,
    test: VERIFY_MODEL,
    uat: DEFAULT_MODEL,
    closeout: DEFAULT_MODEL,
  },
  'wf-diagnose': {
    diagnose: DEFAULT_MODEL,
    fix: DEFAULT_MODEL,
    review: VERIFY_MODEL,
    regression: VERIFY_MODEL,
    closeout: DEFAULT_MODEL,
  },
  'wf-optimize': {
    confirm: DEFAULT_MODEL,
    execute: DEFAULT_MODEL,
    evaluate: VERIFY_MODEL,
    closeout: DEFAULT_MODEL,
  },
  'wf-explore': {
    orchestrate: DEFAULT_MODEL,
    research: DEFAULT_MODEL,
    synthesize: DEFAULT_MODEL,
    evaluate: VERIFY_MODEL,
  },
};

test('LOC-019 内置模板默认绑定：provider 与逐节点模型与映射表一致', () => {
  for (const id of Object.keys(EXPECTED)) {
    const bp = loadTemplate(id);
    const models = (bp.bindings && bp.bindings.models) || {};
    assert.deepEqual(
      Object.keys(models).sort(),
      Object.keys(EXPECTED[id]).sort(),
      id + ' 的 bindings.models 节点集合与映射表不一致',
    );
    for (const nodeId of Object.keys(EXPECTED[id])) {
      const m = models[nodeId];
      assert.equal(m.provider, PROVIDER, id + '.' + nodeId + ' 的 provider 必须为 ' + PROVIDER);
      assert.equal(m.model, EXPECTED[id][nodeId], id + '.' + nodeId + ' 的默认模型与映射表不一致');
    }
  }
});

test('LOC-019 内置模板不再绑定非 DeepSeek provider', () => {
  for (const id of Object.keys(EXPECTED)) {
    const bp = loadTemplate(id);
    const providers = new Set(Object.values((bp.bindings && bp.bindings.models) || {}).map((m) => m.provider));
    assert.deepEqual([...providers], [PROVIDER], id + ' 存在非预期 provider：' + [...providers].join(', '));
  }
});

test('LOC-019 内置模板保持默认弱异源语义：同 provider 不同 model 通过并给出弱异源警告', () => {
  for (const id of ['wf-construction-full-feature', 'wf-diagnose']) {
    const bp = loadTemplate(id);
    const r = validateBlueprint(bp, { requireModels: true });
    assert.equal(r.ok, true, id + ' 必须通过校验：' + JSON.stringify(r.errors));
    assert.equal(r.warnings.length, 1, id + ' 应产生恰好 1 条弱异源警告');
    assert.ok(r.warnings[0].includes('弱异源'), id + ' 的警告应为弱异源：' + JSON.stringify(r.warnings));
  }
});

test('LOC-019 无 dev/review 节点的内置模板不参与异源校验且仍通过结构校验', () => {
  for (const id of ['wf-optimize', 'wf-explore']) {
    const r = validateBlueprint(loadTemplate(id), { requireModels: true });
    assert.equal(r.ok, true, id + ' 必须通过校验：' + JSON.stringify(r.errors));
    assert.equal(r.warnings.length, 0, id + ' 不应产生弱异源警告');
  }
});

test('LOC-021 四套内置模板显式声明弱档（heteroCheck = "weak"）', () => {
  for (const id of Object.keys(EXPECTED)) {
    const bp = loadTemplate(id);
    assert.equal(bp.heteroCheck, 'weak', id + ' 必须显式声明弱档（LOC-021）');
  }
});
