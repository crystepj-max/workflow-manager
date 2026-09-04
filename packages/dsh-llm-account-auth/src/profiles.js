// provider 画像：端点 / 凭据来源 / 鉴权方案 / 建议模型目录。
//
// 【需本机核实】账户模式（ChatGPT 账号、Claude 账号）的凭据文件布局与附加头部随 CLI 版本变化，
// 首次接入请按 README「接入核验清单」逐项核对后回填 credentialFiles / accountHeaders。
//
// 【不臆造】本骨架不填写任何未经核实的能力数字：context（上下文窗口）一律留空，
// 由 resolveModel 保持「未知容量」语义，避免把猜测值写进宿主决策。

import os from 'node:os';
import path from 'node:path';

const home = () => os.homedir();

export const PROFILES = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    wire: 'openai',
    // API Key 模式：官方 API，Chat Completions 线格式（本骨架已实现）。
    endpoint: { baseURL: 'https://api.openai.com/v1', path: '/chat/completions' },
    // 账户模式：codex 的 ChatGPT 后端走 Responses 协议（wire-openai-responses.js）。
    // 端点各版本有差异，允许用 DSH_OPENAI_ACCOUNT_BASE_URL / DSH_OPENAI_ACCOUNT_PATH
    // 在调用时覆盖，便于上机试错时不必改代码。
    accountEndpoint: { baseURL: 'https://chatgpt.com/backend-api/codex', path: '/responses' },
    accountWireSupported: true,
    // 账户专用：codex 后端（chatgpt.com）根本不接受 OPENAI_API_KEY，
    // 与 OpenAI 官方 API（api.openai.com 走 Chat Completions）是两套鉴权体系。
    // 因此不能退化到 API Key 兜底——否则退出登录后会拿 OPENAI_API_KEY 误打官方 API，
    // 报出误导性的「API key is invalid」（实测踩中）。未找到账户凭据时直接报 AUTH 引导重登录。
    // 纯 API Key（Chat Completions）模式若需保留，应另立独立 provider，而非从账户模式退化。
    accountOnly: true,
    // 账户 id（chatgpt_account_id）：codex 后端必需，缺失会被 Cloudflare 403。
    // 三级来源：env 覆盖 > auth.json 直存键 > JWT 载荷 claim（见 credentials.js withAccountId）。
    requiresAccountId: true,
    accountIdEnv: ['DSH_OPENAI_CHATGPT_ACCOUNT_ID', 'CHATGPT_ACCOUNT_ID'],
    accountIdKeys: ['tokens.account_id', 'account_id'],
    apiKeyPrefix: 'sk-',
    tokenEnv: ['OPENAI_API_KEY'],
    accountTokenEnv: ['DSH_OPENAI_ACCOUNT_TOKEN', 'CODEX_ACCESS_TOKEN'],
    credentialFiles: [
      {
        // codex 登录态只含账户令牌（tokens.access_token / tokens.id_token 为 JWT），
        // 绝不包含 OPENAI_API_KEY——该字段若出现在 auth.json 里也不应被当凭据读，
        // 否则会被误判成 API Key 退化为官方 API（见 accountOnly 守卫）。
        path: () => path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'auth.json'),
        keys: ['access_token', 'tokens.access_token', 'tokens.id_token'],
      },
    ],
    headers: {},
    accountHeaders: {},
    // ChatGPT 账户模式下可选模型（用户 2026-09-03 核实：gpt-5.6 已拆为 sol/terra/luna 三档，
    // 另有 5.5 / 5.4）。目录为建议性，DSH 不因此拒绝未列出的 model id；真实可用集以
    // codex 后端 GET /models?client_version= 枚举为准，上机若遇 404 以该枚举回填。
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
  },

  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    wire: 'anthropic',
    // API Key 与账户（Claude 账号 OAuth）模式同端点、同线格式，
    // 差别只在鉴权头部与 anthropic-beta——账户模式已可用。
    endpoint: { baseURL: 'https://api.anthropic.com/v1', path: '/messages' },
    accountEndpoint: { baseURL: 'https://api.anthropic.com/v1', path: '/messages' },
    accountWireSupported: true,
    apiKeyPrefix: 'sk-ant-',
    tokenEnv: ['ANTHROPIC_API_KEY'],
    accountTokenEnv: ['DSH_ANTHROPIC_ACCOUNT_TOKEN', 'CLAUDE_ACCESS_TOKEN'],
    credentialFiles: [
      {
        path: () => path.join(home(), '.claude', '.credentials.json'),
        keys: ['claudeAiOauth.accessToken', 'accessToken', 'oauthToken'],
        // claudeAiOauth.* 键就是 OAuth 登录态；其令牌（sk-ant-oat01-…）以 sk-ant- 开头，
        // 不声明会被 apiKeyPrefix 误判成 API Key（本机已实测踩中）。
        forceMode: 'account',
      },
      {
        path: () => path.join(home(), '.claude.json'),
        keys: ['claudeAiOauth.accessToken', 'oauthToken'],
        forceMode: 'account',
      },
    ],
    headers: { 'anthropic-version': '2023-06-01' },
    // 账户（OAuth）模式必需的 beta 头；Claude CLI 走的即此路径。
    accountHeaders: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
    // Anthropic 的 max_tokens 是必填项；这是请求级输出上限，不是模型硬上限。
    defaultMaxTokens: 8192,
    models: ['claude-sonnet-5', 'claude-opus-5'],
  },
};

export const ROUTE_IDS = Object.keys(PROFILES);
