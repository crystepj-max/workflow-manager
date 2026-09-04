// OpenAI Responses 线格式（流式）——ChatGPT 账户（codex 后端）模式。
//
// 与 Chat Completions 的四点不同：
//   · 端点与鉴权：chatgpt.com/backend-api/codex/responses + Bearer 账户令牌 + chatgpt-account-id
//   · 请求体：instructions/input/tools 扁平化（tool 无 function 包装），store:false，
//     采样参数（max_output_tokens 等）默认剔除——codex 后端拒收
//   · 必需头：originator / openai-beta / session_id / chatgpt-account-id
//   · 事件流：response.* 事件族，块生命周期由 output_item.added/done 划定，
//     done 事件携带权威完整值（覆盖增量累积，防截断）
//
// 头部事实来自公开逆向记录（codex CLI / opencode / hermes-agent），个别字段说法相互矛盾
// （如 User-Agent），已做成 env 开关，见 README「接入核验清单」逐项上机核实。

import { randomUUID } from 'node:crypto';
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { createStreamBuilder } from './blocks.js';
import { chatgptAccountId } from './openai-jwt.js';

// codex 后端要求 instructions 非空；无 system 时补一条中性默认，避免整个请求被拒。
const FALLBACK_INSTRUCTIONS = 'You are a helpful assistant.';

// 账户 id 的 env 覆盖键（与 credentials.js 保持同一组，调用侧最后一手覆盖）。
const ACCOUNT_ID_ENV = ['DSH_OPENAI_CHATGPT_ACCOUNT_ID', 'CHATGPT_ACCOUNT_ID'];

/**
 * 构造 Responses 请求。
 * @param {object} profile PROFILES.openai（含 accountEndpoint / accountHeaders）
 * @param {object} options dsh-llm 调用选项（model/messages/system/tools/maxTokens…）
 * @param {{mode:'account', token:string, accountId?:string}} credential
 * @param {NodeJS.ProcessEnv} env
 */
export function responsesRequest(profile, options, credential, env = process.env) {
  if (credential.mode !== 'account') {
    // 防御性守卫：API Key 模式走 Chat Completions，不应路由到这里。
    throw new Error('openai-responses wire 只服务账户模式；API Key 模式请用 openai wire');
  }

  const url = accountUrl(profile, env);
  const accountId = resolveAccountId(credential, env);

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...attributionHeaders(),
    ...(profile.accountHeaders || {}),
    authorization: `Bearer ${credential.token}`,
    // codex 后端（Cloudflare 前置）必需的协议头：
    'openai-beta': 'responses=experimental',
    // Cloudflare 只放行一小撮第一方 originator，codex_cli_rs 是其中之一。
    originator: 'codex_cli_rs',
    // 每次请求新的 UUID v4（codex CLI 的会话语义）。
    session_id: randomUUID(),
    // 文档记录的规范大小写是 ChatGPT-Account-ID；HTTP 头名不区分大小写，
    // 这里统一小写，若上机核实后端挑剔再改（README 核验项）。
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  };
  applyUserAgent(headers, env);

  const body = {
    model: options.model,
    stream: true,
    // codex 后端要求不落服务端存储，且仅接受 stream:true + store:false 组合。
    store: false,
    // 必填非空；input 必须是 item 数组（不接受字符串简写）。
    instructions: options.system || FALLBACK_INSTRUCTIONS,
    input: toInputItems(options),
  };

  if (options.tools?.length) {
    // Responses 的 tools 是扁平结构（没有 function 包装）；strict schema 校验关闭，
    // 用户自带的 tool schema 未必满足 strict 模式的全部要求。
    body.tools = options.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
    body.tool_choice = 'auto';
  }

  // codex 后端拒收采样参数（max_output_tokens / temperature / top_p / … 实测 400）。
  // 默认剔除；用 env 把端点指到官方 Responses（api.openai.com/v1/responses）等
  // 接受采样参数的目标时，可放行。
  if (env.DSH_OPENAI_ACCOUNT_ALLOW_SAMPLING === '1') {
    if (options.maxTokens != null) body.max_output_tokens = options.maxTokens;
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.stop?.length) body.stop = options.stop;
  }

  return { url, headers, body };
}

/** 端点：允许 env 覆盖（上机试错不改代码），默认 codex 后端。 */
function accountUrl(profile, env) {
  const baseURL = env.DSH_OPENAI_ACCOUNT_BASE_URL || profile.accountEndpoint.baseURL;
  const path = env.DSH_OPENAI_ACCOUNT_PATH || profile.accountEndpoint.path;
  return `${baseURL.replace(/\/+$/, '')}${path}`;
}

/**
 * 账户 id 来源优先级：env 显式覆盖 → 凭据解析阶段提取的 credential.accountId
 * （credentials.js：env > 凭据文档直存键 > JWT 载荷 claim）→ 已选令牌自身的 JWT 载荷。
 * 取不到返回 undefined，不阻断请求——宁可发出去吃真实的 403，也不在这里崩。
 */
function resolveAccountId(credential, env) {
  for (const name of ACCOUNT_ID_ENV) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (credential.accountId) return credential.accountId;
  return chatgptAccountId(credential.token);
}

/**
 * User-Agent 三档开关（核验点：opencode 记录说后端见不得第三方 UA，
 * hermes-agent 却要求 codex_cli_rs/ 前缀——矛盾，用 env 让上机试错）：
 *   omit（默认）剔除 attribution 注入的 UA
 *   codex        伪装 codex CLI 的 UA
 *   dsh          保留 dsh-llm attributionHeaders() 的 UA
 */
function applyUserAgent(headers, env) {
  const mode = (env.DSH_OPENAI_ACCOUNT_USER_AGENT || 'omit').toLowerCase();
  if (mode === 'codex') {
    headers['user-agent'] = 'codex_cli_rs/0.0.0';
  } else if (mode !== 'dsh') {
    delete headers['user-agent'];
  }
}

function textOf(blocks) {
  return (blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function toInputItems(options) {
  const items = [];
  for (const message of options.messages) {
    const blocks = message.content || [];

    if (message.role === 'assistant') {
      const text = textOf(blocks);
      if (text) {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const block of blocks) {
        if (block.type === 'tool-call') {
          items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments });
        }
      }
      continue;
    }

    // user / system：system 走顶层 instructions，这里只处理 user。
    if (message.role === 'system') continue;
    for (const block of blocks) {
      if (block.type === 'tool-result') {
        items.push({ type: 'function_call_output', call_id: block.toolCallId, output: textOf(block.content) || '' });
      }
    }
    const texts = blocks.filter((b) => b.type === 'text');
    if (texts.length) {
      items.push({
        type: 'message',
        role: 'user',
        content: texts.map((b) => ({ type: 'input_text', text: b.text })),
      });
    }
  }
  return items;
}

/**
 * dsh-llm 契约：counts 互斥——inputTokens 只计未缓存输入。
 * Responses 的 usage 与 Chat Completions 同约定：input_tokens 含缓存命中，扣掉单报；
 * reasoning_tokens 是 output_tokens 的子集明细（同 DeepSeek completion 约定），不扣减。
 */
function toUsage(usage) {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    outputTokens: usage.output_tokens ?? 0,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens
      ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
  };
}

/** output_item.done 携带的权威完整值；没有就保持增量累积结果。 */
function donePatch(item) {
  if (item.type === 'function_call') {
    const patch = {};
    if (typeof item.arguments === 'string' && item.arguments) patch.arguments = item.arguments;
    if (item.call_id) patch.id = item.call_id;
    return Object.keys(patch).length ? patch : undefined;
  }
  if (item.type === 'message') {
    const text = (item.content || []).find((c) => c.type === 'output_text')?.text;
    return typeof text === 'string' && text ? { text } : undefined;
  }
  return undefined;
}

/**
 * response.* 事件流 → dsh-llm StreamChunk 流。
 * @param {AsyncIterable<{event:string,data:string}>} frames
 */
export async function* responsesChunks(frames) {
  const builder = createStreamBuilder();
  let usage;
  let status;
  let incompleteReason;
  let sawToolCall = false;

  for await (const frame of frames) {
    if (frame.data === '[DONE]') break;
    let event;
    try {
      event = JSON.parse(frame.data);
    } catch {
      continue; // 非 JSON 帧忽略（心跳、注释）。
    }
    const type = event.type || frame.event;

    switch (type) {
      case 'response.output_item.added': {
        const item = event.item || {};
        const key = `item:${item.id}`;
        if (item.type === 'function_call') {
          const { index, isNew } = builder.open(key, 'tool-call');
          sawToolCall = true;
          if (isNew) yield { type: 'block-start', index, blockType: 'tool-call' };
          // call_id 是与 function_call_output 配对的调用 id；item.id 只是事件流标识。
          builder.appendTool(index, { id: item.call_id ?? item.id, name: item.name, argumentsDelta: '' });
        } else if (item.type === 'reasoning') {
          const { index, isNew } = builder.open(key, 'reasoning');
          if (isNew) yield { type: 'block-start', index, blockType: 'reasoning' };
        } else if (item.type === 'message') {
          const { index, isNew } = builder.open(key, 'text');
          if (isNew) yield { type: 'block-start', index, blockType: 'text' };
        }
        break;
      }

      case 'response.output_text.delta': {
        const { index, isNew } = builder.open(`item:${event.item_id}`, 'text');
        if (isNew) yield { type: 'block-start', index, blockType: 'text' };
        builder.appendText(index, event.delta);
        yield { type: 'text-delta', index, text: event.delta };
        break;
      }

      // 原始推理文本与摘要文本都归入同一 reasoning 块（按 item 聚合）。
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const { index, isNew } = builder.open(`item:${event.item_id}`, 'reasoning');
        if (isNew) yield { type: 'block-start', index, blockType: 'reasoning' };
        builder.appendText(index, event.delta);
        yield { type: 'reasoning-delta', index, text: event.delta };
        break;
      }

      case 'response.function_call_arguments.delta': {
        const { index, isNew } = builder.open(`item:${event.item_id}`, 'tool-call');
        if (isNew) {
          sawToolCall = true;
          yield { type: 'block-start', index, blockType: 'tool-call' };
        }
        builder.appendTool(index, { argumentsDelta: event.delta });
        yield {
          type: 'tool-call-delta',
          index,
          id: builder.idOf(index) ?? '',
          argumentsDelta: event.delta,
        };
        break;
      }

      case 'response.output_item.done': {
        const item = event.item || {};
        const index = builder.indexOf(`item:${item.id}`);
        if (index !== undefined) {
          const chunk = builder.close(index, donePatch(item));
          if (chunk) yield chunk;
        }
        break;
      }

      case 'response.completed': {
        usage = toUsage(event.response?.usage) ?? usage;
        status = event.response?.status ?? 'completed';
        break;
      }

      case 'response.incomplete': {
        usage = toUsage(event.response?.usage) ?? usage;
        status = 'incomplete';
        incompleteReason = event.response?.incomplete_details?.reason;
        break;
      }

      case 'response.failed':
      case 'response.error': {
        const error = event.response?.error || event.error || {};
        throw Object.assign(new Error(error.message || 'openai responses stream error'), {
          code: 'PROVIDER',
          status: error.status,
        });
      }

      default:
        break;
    }
  }

  yield* builder.closeAll(); // 收口兜底：异常截断的流也要补齐 block-end。
  if (usage) yield { type: 'usage', usage };
  const kind =
    status === 'incomplete' && incompleteReason === 'max_output_tokens'
      ? 'max-tokens'
      : sawToolCall
        ? 'tool-calls'
        : 'stop';
  yield { type: 'finish', reason: { kind } };
}
