import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReviewPrompt,
  extendDecision,
  initialState,
  nextDecision,
  parseCommand,
  parseStateComment,
  retryDecision,
} from '../codex-review-controller.mjs';

test('解析 next / retry / extend 命令', () => {
  assert.deepEqual(parseCommand('/codex-review next'), { type: 'next' });
  assert.deepEqual(parseCommand('/codex-review retry'), { type: 'retry' });
  assert.deepEqual(parseCommand('/codex-review extend 1 仍有 P1 阻塞'), {
    type: 'extend',
    amount: 1,
    reason: '仍有 P1 阻塞',
  });
  assert.deepEqual(parseCommand('/codex-review extend 2'), { type: 'invalid' });
  assert.equal(parseCommand('普通评论'), null);
});

test('默认最多三轮，第四次被拒绝', () => {
  const state = initialState();

  let decision = nextDecision(state, 'head-1');
  assert.deepEqual(decision, { ok: true, round: 1 });
  state.round = decision.round;
  state.lastHead = 'head-1';

  decision = nextDecision(state, 'head-2');
  assert.deepEqual(decision, { ok: true, round: 2 });
  state.round = decision.round;
  state.lastHead = 'head-2';

  decision = nextDecision(state, 'head-3');
  assert.deepEqual(decision, { ok: true, round: 3 });
  state.round = decision.round;
  state.lastHead = 'head-3';

  assert.deepEqual(nextDecision(state, 'head-4'), { ok: false, reason: 'EXHAUSTED' });
});

test('同一 PR 版本重复 next 不占用下一轮', () => {
  const state = { ...initialState(), round: 1, lastHead: 'same-head' };
  assert.deepEqual(nextDecision(state, 'same-head'), { ok: false, reason: 'DUPLICATE_HEAD' });
});

test('retry 只允许重试当前轮同一版本且不增加轮次', () => {
  const state = { ...initialState(), round: 2, lastHead: 'head-2' };
  assert.deepEqual(retryDecision(state, 'head-2'), { ok: true, round: 2 });
  assert.deepEqual(retryDecision(state, 'head-3'), { ok: false, reason: 'HEAD_CHANGED' });
  assert.deepEqual(retryDecision(initialState(), 'head-1'), { ok: false, reason: 'NO_ROUND' });
});

test('只有额度耗尽后才允许一次追加一轮', () => {
  assert.deepEqual(extendDecision({ ...initialState(), round: 2 }), { ok: false, reason: 'NOT_EXHAUSTED' });
  assert.deepEqual(extendDecision({ ...initialState(), round: 3 }), { ok: true, maxRounds: 4 });
  assert.deepEqual(extendDecision({ ...initialState(), round: 3 }, 2), { ok: false, reason: 'ONLY_ONE' });
});

test('第 2/3 轮提示词明确收敛范围', () => {
  assert.match(buildReviewPrompt(1, 3), /完整审查/);
  assert.match(buildReviewPrompt(2, 3), /收敛审查/);
  assert.match(buildReviewPrompt(3, 3), /最终收敛审查/);
  assert.match(buildReviewPrompt(4, 4, '仍有 P1'), /人工追加原因：仍有 P1/);
});

test('可以从 Controller 状态评论恢复状态', () => {
  const body = `状态\n<!-- codex-review-controller-state\n${JSON.stringify({ round: 2, maxRounds: 4, lastHead: 'abc' })}\n-->`;
  const state = parseStateComment(body);
  assert.equal(state.round, 2);
  assert.equal(state.maxRounds, 4);
  assert.equal(state.lastHead, 'abc');
  assert.deepEqual(state.extensions, []);
});
