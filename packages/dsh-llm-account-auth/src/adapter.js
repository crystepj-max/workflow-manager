// 账户鉴权 LLM 适配器：为 openai / anthropic 两条路由提供 LlmAdapter 实现。
//
// 契约要点（dsh-llm）：
//   · 只有 stream() 是抽象方法，其余（providerInfo/listModels/resolveModel/prepareCall）都有默认实现；
//   · 适配器内部可以 throw，LlmRuntime.stream() 会把异常归一成终态 error/aborted finish；
//   · 每个 provider HTTP 请求都必须带 attributionHeaders()。

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { ProxyAgent } from 'undici';
import { PROFILES } from './profiles.js';
import { resolveCredential } from './credentials.js';
import { parseSse } from './sse.js';
import { openaiWire } from './wire-openai.js';
import { anthropicWire } from './wire-anthropic.js';

// Node 的全局 fetch（undici）默认不读 HTTPS_PROXY 环境变量，企业内网下会直连超时
// （UND_ERR_CONNECT_TIMEOUT → 上层只看到 "fetch failed"）。这里显式把代理注入 fetch 的
// dispatcher，只影响本适配器的账户鉴权请求，不动 DSH 其他流量。
// 优先级：专用覆盖键 > HTTPS_PROXY > HTTP_PROXY（大小写兼容）。
function resolveProxyUrl(env) {
  const url =
    env.DSH_ACCOUNT_AUTH_PROXY ||
    env.HTTPS_PROXY ||
    env.HTTP_PROXY ||
    env.https_proxy ||
    env.http_proxy;
  return typeof url === 'string' && url.trim() ? url.trim() : undefined;
}

// 每个 provider 给一个「按凭据模式选线格式」的工厂：
// openai 在账户模式下切到 Responses，anthropic 两种模式同线格式。
const WIRES = {
  openai: openaiWire,
  anthropic: anthropicWire,
};

export class AccountAuthLlmAdapter extends LlmAdapter {
  #fetchImpl;
  #env;
  #resolve;
  #proxyAgent;

  /**
   * @param {{
   *   fetch?: typeof globalThis.fetch,
   *   env?: NodeJS.ProcessEnv,
   *   resolveCredential?: (profile: object, env: NodeJS.ProcessEnv) => Promise<{mode:string,token:string,source:string}>
   * }} [options]
   *   fetch / env / resolveCredential 均可注入，便于离线测试（见 tests/adapter.test.mjs）。
   */
  constructor(options = {}) {
    super();
    this.#fetchImpl = options.fetch ?? globalThis.fetch;
    this.#env = options.env ?? process.env;
    this.#resolve = options.resolveCredential ?? resolveCredential;

    // 代理：仅在环境变量显式给出时启用，避免无代理环境（如本机直连）被意外拦截。
    const proxyUrl = resolveProxyUrl(this.#env);
    if (proxyUrl) {
      try {
        this.#proxyAgent = new ProxyAgent(proxyUrl);
      } catch {
        // 代理 URL 非法（如手滑写错）：不阻断启动，只是不走代理，请求会暴露真实网络错误。
        this.#proxyAgent = null;
      }
    } else {
      this.#proxyAgent = null;
    }
  }

  providerInfo(provider) {
    return { id: provider, name: PROFILES[provider]?.name ?? provider };
  }

  /** 目录是建议性的：适配器接受未列出的 model id，消费方不得因未列出而拒请求。 */
  async listModels(provider) {
    return (PROFILES[provider]?.models ?? []).map((id) => ({ provider, id, name: id }));
  }

  /**
   * 精确模型元数据。context 一律省略（未知容量）——不填未经核实的能力数字。
   * defaultMaxTokens 是适配器自定的请求级输出上限，仅在调用方未给 maxTokens 时生效。
   */
  async resolveModel(provider, model, _signal) {
    const profile = PROFILES[provider];
    return {
      provider,
      id: model,
      name: model,
      ...(profile?.defaultMaxTokens ? { defaultMaxTokens: profile.defaultMaxTokens } : {}),
    };
  }

  async *stream(options) {
    const profile = PROFILES[options.provider];
    if (!profile) {
      throw new LlmError(`未注册的 provider 路由：${options.provider}`, 'NO_ADAPTER');
    }
    const makeWire = WIRES[profile.wire];
    if (!makeWire) {
      throw new LlmError(`provider ${options.provider} 缺少线格式实现：${profile.wire}`, 'NO_ADAPTER');
    }

    // 账户鉴权的主路径：设置 profile 不写凭据，由 CLI 本地登录态解析。
    const credential = await this.#resolve(profile, this.#env);
    const wire = makeWire(credential);
    const { url, headers, body } = wire.request(profile, options, credential, this.#env);

    let response;
    try {
      response = await this.#fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
        // 仅此请求走代理（企业内网出网必需）；无代理则为 undefined，fetch 直连。
        ...(this.#proxyAgent ? { dispatcher: this.#proxyAgent } : {}),
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new LlmError(`${profile.name} 请求被取消`, 'ABORTED', { cause: error });
      }
      const hint = this.#proxyAgent
        ? '（请检查 HTTPS_PROXY 指向的代理是否可达 OpenAI/Anthropic）'
        : '（企业内网请通过 HTTPS_PROXY 配置代理后再试）';
      throw new LlmError(
        `无法连接 ${profile.name}：${error?.message ?? String(error)}${hint}`,
        'NETWORK',
        { cause: error },
      );
    }

    if (!response.ok || !response.body) {
      throw await httpError(profile, response);
    }

    yield* wire.chunks(parseSse(response.body));
  }
}

async function httpError(profile, response) {
  let detail = '';
  try {
    detail = await response.text();
  } catch {
    /* 读不到响应体也要给出可用错误 */
  }
  const status = response.status;
  const code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'PROVIDER';
  const requestId =
    response.headers?.get?.('x-request-id') || response.headers?.get?.('request-id') || undefined;

  const retryAfter = response.headers?.get?.('retry-after');
  let providerRetryAfterMs;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) providerRetryAfterMs = seconds * 1000;
  }

  return new LlmError(
    `${profile.name} 返回 ${status}${requestId ? `（request-id ${requestId}）` : ''}：${detail.slice(0, 500)}`,
    code,
    { status, requestId, providerRetryAfterMs },
  );
}
