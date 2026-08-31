import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_ROUNDS = 3;
const STATE_MARKER = 'codex-review-controller-state';
const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function parseCommand(body) {
  const text = String(body ?? '').trim();
  if (!text.toLowerCase().startsWith('/codex-review')) return null;
  if (/^\/codex-review\s+next\s*$/i.test(text)) return { type: 'next' };
  if (/^\/codex-review\s+retry\s*$/i.test(text)) return { type: 'retry' };
  const extend = text.match(/^\/codex-review\s+extend\s+1(?:\s+([\s\S]+))?$/i);
  if (extend) return { type: 'extend', amount: 1, reason: sanitizeText(extend[1] ?? '') };
  return { type: 'invalid' };
}

export function initialState() {
  return {
    version: 1,
    round: 0,
    maxRounds: DEFAULT_MAX_ROUNDS,
    lastHead: null,
    status: 'READY',
    extensions: [],
    retries: 0,
    updatedAt: null,
  };
}

export function nextDecision(state, head) {
  if (state.round >= state.maxRounds) return { ok: false, reason: 'EXHAUSTED' };
  if (state.round > 0 && state.lastHead === head) return { ok: false, reason: 'DUPLICATE_HEAD' };
  return { ok: true, round: state.round + 1 };
}

export function retryDecision(state, head) {
  if (state.round < 1) return { ok: false, reason: 'NO_ROUND' };
  if (state.lastHead !== head) return { ok: false, reason: 'HEAD_CHANGED' };
  return { ok: true, round: state.round };
}

export function extendDecision(state, amount = 1) {
  if (amount !== 1) return { ok: false, reason: 'ONLY_ONE' };
  if (state.round < state.maxRounds) return { ok: false, reason: 'NOT_EXHAUSTED' };
  return { ok: true, maxRounds: state.maxRounds + 1 };
}

export function hasReviewIdentity(reviewToken) {
  return typeof reviewToken === 'string' && reviewToken.trim().length > 0;
}

export function buildReviewPrompt(round, maxRounds, extensionReason = '') {
  if (round === 1) {
    return `@codex review 第 1/${maxRounds} 轮完整审查：围绕当前 Issue/PR 的验收条件检查需求符合性、正确性、回归风险、证据与必要边界条件。请区分必须在本 PR 修复的阻塞问题与可作为 follow-up 的非阻塞建议。`;
  }
  if (round === 2) {
    return `@codex review 第 2/${maxRounds} 轮收敛审查：重点验证上一轮阻塞问题是否正确解决，以及本轮修改是否引入新的当前范围阻塞问题。新的非阻塞优化建议请明确标记为 follow-up，不要扩大当前 PR 的验收范围。`;
  }
  if (round === 3 && maxRounds === DEFAULT_MAX_ROUNDS) {
    return '@codex review 第 3/3 轮最终收敛审查：只报告会导致当前 Issue 验收失败、当前修改引入的明显回归或必须在合并前解决的阻塞问题。其他改进建议请标记为 follow-up，不得作为继续自动循环的理由。';
  }
  const reason = extensionReason ? ` 人工追加原因：${extensionReason}` : '';
  return `@codex review 人工追加的第 ${round}/${maxRounds} 轮收敛审查：仅核查当前 PR 尚未解决的明确阻塞项及相关修复是否引入回归；新的非阻塞建议统一作为 follow-up，不扩大当前 PR 范围。${reason}`;
}

export function parseStateComment(body) {
  const match = String(body ?? '').match(new RegExp(`<!-- ${STATE_MARKER}\\s*\\n([\\s\\S]*?)\\n-->`));
  if (!match) return null;
  try {
    return { ...initialState(), ...JSON.parse(match[1]) };
  } catch {
    return null;
  }
}

function sanitizeText(value) {
  return String(value ?? '').replace(/-->/g, '—>').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function renderState(state) {
  const remaining = Math.max(0, state.maxRounds - state.round);
  const added = state.extensions.reduce((sum, item) => sum + item.amount, 0);
  const statusText = {
    READY: '可申请下一轮',
    REVIEW_REQUESTED: '已发起审查',
    RETRY_REQUESTED: '当前轮已重试',
    EXHAUSTED: '自动额度耗尽，等待人工决策',
    EXTENDED: '人工已追加有限额度',
  }[state.status] ?? state.status;
  const json = JSON.stringify(state);
  return `### Codex PR Review Controller\n\n- 当前轮次：**${state.round} / ${state.maxRounds}**\n- 状态：**${statusText}**\n- 最近审查版本：${state.lastHead ? `\`${state.lastHead.slice(0, 12)}\`` : '—'}\n- 剩余可申请轮次：**${remaining}**\n- 人工追加：**${added}**\n\n命令：\`/codex-review next\` · 服务故障重试：\`/codex-review retry\` · 额度耗尽后人工追加：\`/codex-review extend 1 <原因>\`\n\n<!-- ${STATE_MARKER}\n${json}\n-->`;
}

function isAuthorized(event) {
  return ALLOWED_ASSOCIATIONS.has(event.comment?.author_association);
}

async function githubRequest(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workflow-manager-codex-review-controller',
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function listAllComments(token, repo, number) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(token, `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

function findStateComment(comments) {
  return [...comments].reverse().find((comment) =>
    comment.user?.login === 'github-actions[bot]' && String(comment.body ?? '').includes(`<!-- ${STATE_MARKER}`));
}

async function postComment(token, repo, number, body) {
  return githubRequest(token, `/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function saveState(token, repo, number, stateComment, state) {
  const body = renderState(state);
  if (stateComment) {
    return githubRequest(token, `/repos/${repo}/issues/comments/${stateComment.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }
  return postComment(token, repo, number, body);
}

async function triggerReview({ token, reviewToken, repo, number, body }) {
  if (!hasReviewIdentity(reviewToken)) {
    await postComment(token, repo, number, '⛔ Controller 尚未配置可被 Codex 识别的触发身份，本次请求**不消耗 Review 轮次**。请先配置仓库 Secret `CODEX_REVIEW_TOKEN`，其身份必须已经连接 Codex 与 GitHub，然后重新执行同一条 `/codex-review next` 或 `/codex-review retry`。');
    return false;
  }
  try {
    await postComment(reviewToken, repo, number, body);
    return true;
  } catch (error) {
    await postComment(token, repo, number, `⛔ Codex Review 触发身份调用失败，本次请求**不消耗 Review 轮次**。请检查 \`CODEX_REVIEW_TOKEN\` 后重试。错误：${sanitizeText(error.message)}`);
    return false;
  }
}

async function handleNext({ token, reviewToken, repo, number, actor, stateComment, state, head }) {
  const decision = nextDecision(state, head);
  if (!decision.ok) {
    if (decision.reason === 'EXHAUSTED') {
      state.status = 'EXHAUSTED';
      state.updatedAt = new Date().toISOString();
      await saveState(token, repo, number, stateComment, state);
      await postComment(token, repo, number, `⛔ Codex 自动 Review 已达到 ${state.round}/${state.maxRounds}。Controller 不会触发下一轮。请人工选择收口、拆分 follow-up，或使用 \`/codex-review extend 1 <原因>\` 追加 1 轮有限额度。`);
      return;
    }
    await postComment(token, repo, number, `ℹ️ 当前版本 \`${head.slice(0, 12)}\` 已经发起过 Round ${state.round}，不会重复占用下一轮。若上一轮是 Codex 服务错误，请使用 \`/codex-review retry\`；若已完成修改，请先提交新的 PR 版本再申请 \`next\`。`);
    return;
  }

  const extensionReason = state.extensions.at(-1)?.reason ?? '';
  const prompt = `${buildReviewPrompt(decision.round, state.maxRounds, extensionReason)}\n\n<!-- codex-review-controller-trigger round:${decision.round} head:${head} -->`;
  const triggered = await triggerReview({ token, reviewToken, repo, number, body: prompt });
  if (!triggered) return;

  state.round = decision.round;
  state.lastHead = head;
  state.status = 'REVIEW_REQUESTED';
  state.updatedAt = new Date().toISOString();
  state.lastRequestedBy = actor;
  await saveState(token, repo, number, stateComment, state);
}

async function handleRetry({ token, reviewToken, repo, number, actor, stateComment, state, head }) {
  const decision = retryDecision(state, head);
  if (!decision.ok) {
    const message = decision.reason === 'NO_ROUND'
      ? '当前还没有已发起的 Review，请先使用 `/codex-review next`。'
      : 'PR 版本已经变化，不能把新版本当作上一轮服务重试；请使用 `/codex-review next`。';
    await postComment(token, repo, number, `ℹ️ ${message}`);
    return;
  }
  const extensionReason = state.extensions.at(-1)?.reason ?? '';
  const prompt = `${buildReviewPrompt(state.round, state.maxRounds, extensionReason)}\n\n> Controller：这是 Round ${state.round} 的服务/工具故障重试，不增加业务轮次。\n\n<!-- codex-review-controller-retry round:${state.round} head:${head} -->`;
  const triggered = await triggerReview({ token, reviewToken, repo, number, body: prompt });
  if (!triggered) return;

  state.status = 'RETRY_REQUESTED';
  state.retries = (state.retries ?? 0) + 1;
  state.updatedAt = new Date().toISOString();
  state.lastRequestedBy = actor;
  await saveState(token, repo, number, stateComment, state);
}

async function handleExtend({ token, repo, number, actor, stateComment, state, command }) {
  if (!command.reason) {
    await postComment(token, repo, number, '⛔ 人工追加额度必须记录原因。用法：`/codex-review extend 1 <原因>`。');
    return;
  }
  const decision = extendDecision(state, command.amount);
  if (!decision.ok) {
    const message = decision.reason === 'NOT_EXHAUSTED'
      ? `当前仍有自动额度（${state.round}/${state.maxRounds}），无需提前追加。`
      : 'MVP 每次只允许追加 1 轮。';
    await postComment(token, repo, number, `⛔ ${message}`);
    return;
  }
  state.maxRounds = decision.maxRounds;
  state.status = 'EXTENDED';
  state.extensions.push({
    amount: 1,
    by: actor,
    reason: command.reason,
    at: new Date().toISOString(),
  });
  state.updatedAt = new Date().toISOString();
  await saveState(token, repo, number, stateComment, state);
  await postComment(token, repo, number, `✅ @${actor} 已人工追加 **1 轮** Codex Review，最大轮次变为 **${state.maxRounds}**。原因：${command.reason}\n\n追加额度不会自动触发审查；完成针对阻塞项的修改并提交新版本后，再使用 \`/codex-review next\`。`);
}

export async function runController(event, { token, reviewToken, repo }) {
  if (!event.issue?.pull_request) return { handled: false, reason: 'NOT_PR' };
  const command = parseCommand(event.comment?.body);
  if (!command) return { handled: false, reason: 'NOT_COMMAND' };
  const number = event.issue.number;

  if (!isAuthorized(event)) {
    await postComment(token, repo, number, '⛔ 只有仓库 Owner / Member / Collaborator 可以操作 Codex Review Controller。');
    return { handled: true, reason: 'UNAUTHORIZED' };
  }
  if (command.type === 'invalid') {
    await postComment(token, repo, number, '用法：`/codex-review next`、`/codex-review retry`、`/codex-review extend 1 <原因>`。');
    return { handled: true, reason: 'INVALID' };
  }

  const comments = await listAllComments(token, repo, number);
  const stateComment = findStateComment(comments);
  const state = stateComment ? parseStateComment(stateComment.body) ?? initialState() : initialState();
  const pr = await githubRequest(token, `/repos/${repo}/pulls/${number}`);
  const head = pr.head.sha;
  const actor = event.comment.user.login;
  const context = { token, reviewToken, repo, number, actor, stateComment, state, head, command };

  if (command.type === 'next') await handleNext(context);
  if (command.type === 'retry') await handleRetry(context);
  if (command.type === 'extend') await handleExtend(context);
  return { handled: true, reason: command.type.toUpperCase() };
}

async function main() {
  const eventPath = process.argv[2] ?? process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  const reviewToken = process.env.CODEX_REVIEW_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!eventPath || !token || !repo) throw new Error('缺少 GITHUB_EVENT_PATH / GITHUB_TOKEN / GITHUB_REPOSITORY');
  const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
  await runController(event, { token, reviewToken, repo });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
