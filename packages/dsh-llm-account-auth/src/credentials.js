// 账户鉴权的凭据解析：环境变量覆盖 → CLI 本地凭据库（账户登录态）→ API Key 兜底。
//
// 设计依据（dsh-llm api-key 契约）：
//   「a profile naming no credential authenticates through the provider's own
//     ambient discovery or OAuth」——即设置 profile 里不写凭据，
//     由 provider 自己 CLI 的本地登录态完成鉴权。本模块就是那条 ambient discovery 通道。

import fs from 'node:fs/promises';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { chatgptAccountId } from './openai-jwt.js';

/** 按 'a.b.c' 路径取值，任一层缺失返回 undefined。 */
function getPath(obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * 判定一枚令牌是 API Key 还是账户 OAuth 令牌。
 * 启发式：命中 provider 的 apiKeyPrefix 视为 API Key，其余（JWT 等）视为账户令牌。
 */
export function classifyToken(profile, token) {
  if (profile.apiKeyPrefix && token.startsWith(profile.apiKeyPrefix)) return 'api-key';
  return 'account';
}

/** 读一枚凭据文件，按候选键顺序取第一个非空字符串，并保留原文档供账户 id 提取。 */
async function readFileToken(entry) {
  let json;
  try {
    json = JSON.parse(await fs.readFile(entry.path(), 'utf8'));
  } catch {
    return null; // 文件不存在或不是 JSON：不是错误，只是这条路走不通。
  }
  for (const key of entry.keys) {
    const value = getPath(json, key);
    if (typeof value === 'string' && value.trim()) {
      return { token: value.trim(), source: `${entry.path()}#${key}`, doc: json };
    }
  }
  return null;
}

/**
 * 给账户凭据补上账户 id（仅 account 模式且 profile 声明需要时）。
 * codex 后端是 Cloudflare 前置的，缺账户 id 的请求会拿到 403，与令牌是否有效无关。
 * 三级来源，先到先得：
 *   ① env 覆盖（profile.accountIdEnv，如 DSH_OPENAI_CHATGPT_ACCOUNT_ID）
 *   ② 凭据文档直存字段（profile.accountIdKeys，如 codex auth.json 的 tokens.account_id）
 *   ③ JWT 载荷的 chatgpt_account_id claim（优先已选令牌，再扫文档里其他 JWT）
 * 取不到返回 undefined 不抛错——宁可把请求发出去暴露真实的 403，也不在凭据阶段崩掉。
 */
function withAccountId(profile, credential, doc, env) {
  if (credential.mode !== 'account' || !profile.requiresAccountId) return credential;

  for (const name of profile.accountIdEnv || []) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return { ...credential, accountId: value.trim() };
  }

  for (const key of profile.accountIdKeys || []) {
    const value = getPath(doc, key);
    if (typeof value === 'string' && value.trim()) return { ...credential, accountId: value.trim() };
  }

  for (const candidate of jwtCandidates(credential.token, doc)) {
    const id = chatgptAccountId(candidate);
    if (id) return { ...credential, accountId: id };
  }
  return credential;
}

/** 已选令牌优先，其后是凭据文档里所有形似 JWT 的字符串（auth.json 很小，限深扫描无妨）。 */
function jwtCandidates(token, doc) {
  const seen = new Set();
  const candidates = [];
  const push = (value) => {
    if (
      typeof value === 'string' &&
      value.length > 20 &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value) &&
      !seen.has(value)
    ) {
      seen.add(value);
      candidates.push(value);
    }
  };
  push(token);
  const walk = (node, depth) => {
    if (node == null || depth > 5 || candidates.length >= 8) return;
    if (typeof node === 'string') {
      push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else if (typeof node === 'object') {
      for (const value of Object.values(node)) walk(value, depth + 1);
    }
  };
  walk(doc, 0);
  return candidates;
}

/**
 * 解析一次调用要用的凭据。
 * @returns {{mode:'api-key'|'account', token:string, source:string, accountId?:string}}
 * @throws {LlmError} 三条路都没有凭据时抛 AUTH，文案给出可执行的修复指引。
 */
export async function resolveCredential(profile, env = process.env) {
  // ① 账户令牌显式覆盖（最高优先级，便于测试与 CI）。
  for (const name of profile.accountTokenEnv || []) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return withAccountId(
        profile,
        { mode: 'account', token: value.trim(), source: `env:${name}` },
        undefined,
        env,
      );
    }
  }

  // ② CLI 本地凭据库：codex login / claude login 留下的登录态（账户鉴权主路径）。
  for (const entry of profile.credentialFiles || []) {
    const found = await readFileToken(entry);
    if (found) {
      // 模式判定：
      //  · profile.accountOnly（如 OpenAI 账户模式，codex 后端）：文件来源一律视为账户凭据，
      //    强制 account——绝不走 classifyToken 把 sk- 形令牌降级成 API Key 误打官方 API。
      //  · entry.forceMode：键名结构已明确是账户登录态（如 claudeAiOauth.*）时直接声明，
      //    跳过前缀启发式——Claude 的 OAuth 令牌（sk-ant-oat01-…）也以 sk-ant- 开头。
      //  · 其余：按前缀启发式 classifyToken 兜底。
      const mode = profile.accountOnly
        ? 'account'
        : (entry.forceMode ?? classifyToken(profile, found.token));
      return withAccountId(
        profile,
        { mode, token: found.token, source: found.source },
        found.doc,
        env,
      );
    }
  }

  // ③ API Key 环境变量兜底——仅当 profile 允许退化时（非账户专用）。
  // accountOnly（如 OpenAI 账户模式，codex 后端）禁止此兜底：拿 OPENAI_API_KEY 去打
  // 官方 Chat Completions 端点语义错误且误导。账户凭据缺失就直接报 AUTH 引导重登录。
  if (!profile.accountOnly) {
    for (const name of profile.tokenEnv || []) {
      const value = env[name];
      if (typeof value === 'string' && value.trim()) {
        return { mode: 'api-key', token: value.trim(), source: `env:${name}` };
      }
    }
  }

  const files = (profile.credentialFiles || []).map((e) => e.path()).join('、');
  const loginHint = profile.accountOnly
    ? `请运行 \`npx @openai/codex login\`（或 \`codex login\`）完成 ChatGPT 账户授权后重试；` +
      `该模式走 codex 后端，不接受 OPENAI_API_KEY。`
    : `请先完成账户登录（凭据文件：${files || '未配置'}），` +
      `或设置 ${[...(profile.accountTokenEnv || []), ...(profile.tokenEnv || [])].join(' / ')}。`;
  throw new LlmError(`${profile.name}：未找到可用的账户凭据。${loginHint}`, 'AUTH');
}
