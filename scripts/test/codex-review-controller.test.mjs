import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReviewPrompt,
  extendDecision,
  hasReviewIdentity,
  initialState,
  nextDecision,
  parseCommand,
  parseStateComment,
  retryDecision,
  runController,
  TRIGGER_COMMAND,
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

test('没有独立触发身份时必须 fail closed', () => {
  assert.equal(hasReviewIdentity(undefined), false);
  assert.equal(hasReviewIdentity(''), false);
  assert.equal(hasReviewIdentity('   '), false);
  assert.equal(hasReviewIdentity('token-present'), true);
});

test('触发评论以单一常量承载 @cursor review，不再注入 @codex 自由提示词', () => {
  assert.equal(TRIGGER_COMMAND, '@cursor review', '触发词以 Cursor 设置页 Manual-Only 文案为单一事实源');
  const p1 = buildReviewPrompt(1, 3);
  assert.ok(p1.startsWith(TRIGGER_COMMAND), '触发评论首行必须是常量触发词');
  assert.match(p1, /^@cursor review(?=\s|$)/, '触发词独立成行，后接审计留痕');
  assert.ok(!p1.includes('@codex'), '不得残留 @codex 触发');
  assert.ok(!/codex/i.test(p1), '触发评论正文不得再出现 codex');
});

test('各轮仍保留轮次审计留痕（完整/收敛/最终/人工追加）', () => {
  assert.match(buildReviewPrompt(1, 3), /完整审查/);
  assert.match(buildReviewPrompt(2, 3), /收敛审查/);
  assert.match(buildReviewPrompt(3, 3), /最终收敛审查/);
  assert.match(buildReviewPrompt(4, 4, '仍有 P1'), /人工追加原因：仍有 P1/);
});

test('普通 Issue 评论不触发 Controller（非 PR）', async () => {
  // 门禁在解析命令前即返回，不触达任何网络调用
  const res = await runController(
    { issue: { number: 1 }, comment: { body: '/codex-review next' } },
    { token: 't', reviewToken: 'r', repo: 'o/r' },
  );
  assert.deepEqual(res, { handled: false, reason: 'NOT_PR' });
});

test('PR 内的非命令评论不触发 Controller', async () => {
  const res = await runController(
    { issue: { number: 1, pull_request: {} }, comment: { body: '普通评论' } },
    { token: 't', reviewToken: 'r', repo: 'o/r' },
  );
  assert.deepEqual(res, { handled: false, reason: 'NOT_COMMAND' });
});

test('可以从 Controller 状态评论恢复状态', () => {
  const body = `状态\n<!-- codex-review-controller-state\n${JSON.stringify({ round: 2, maxRounds: 4, lastHead: 'abc' })}\n-->`;
  const state = parseStateComment(body);
  assert.equal(state.round, 2);
  assert.equal(state.maxRounds, 4);
  assert.equal(state.lastHead, 'abc');
  assert.deepEqual(state.extensions, []);
});
