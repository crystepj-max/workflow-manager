// 从 ChatGPT OAuth 的 JWT 里取 chatgpt_account_id。
//
// 为什么必须取：chatgpt.com 的 codex 后端是 Cloudflare 前置的，缺少账户标识的
// 请求会拿到 403（cf-mitigated: challenge），与凭据本身是否正确无关。
// 账户 id 不在 auth.json 的顶层，而是**内嵌在 JWT 载荷**里：
//   payload['https://api.openai.com/auth'].chatgpt_account_id
//
// 设计取舍：解析失败一律返回 undefined 而不抛错——拿不到账户 id 时宁可发一个
// 可能被后端拒绝的请求，把真实的 403 暴露给用户，也不要在凭据解析阶段就崩掉。

const ACCOUNT_CLAIM = 'https://api.openai.com/auth';

function decodeSegment(segment) {
  // JWT 段是 base64url（无填充）。Node 的 Buffer 也能吃 base64url。
  return Buffer.from(segment, 'base64url').toString('utf8');
}

/** 取 JWT 的载荷对象；任何形态异常都返回 undefined（不抛）。 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string' || !token) return undefined;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const parsed = JSON.parse(decodeSegment(parts[1]));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取账户 id。命中返回字符串，否则 undefined。
 * @param {string} token OAuth access_token / id_token
 */
export function chatgptAccountId(token) {
  const payload = decodeJwtPayload(token);
  const claim = payload?.[ACCOUNT_CLAIM];
  const id = claim?.chatgpt_account_id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}
