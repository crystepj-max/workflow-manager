// Anthropic Messages 线格式（流式）。
// 覆盖：API Key 模式与账户（Claude 账号 OAuth）模式——两者同端点、同线格式，
// 差别只在鉴权头：账户模式用 Bearer + anthropic-beta: oauth-2025-04-20（Claude CLI 即此路径）。

import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { createStreamBuilder } from './blocks.js';

/** 两种模式同端点、同线格式，只按凭据模式换鉴权头，故此处忽略 credential。 */
export function anthropicWire() {
  return { request: anthropicRequest, chunks: anthropicChunks };
}

export function anthropicRequest(profile, options, credential) {
  const target = credential.mode === 'account' ? profile.accountEndpoint : profile.endpoint;
  const url = `${target.baseURL.replace(/\/+$/, '')}${target.path}`;

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...attributionHeaders(),
    ...(credential.mode === 'account' ? profile.accountHeaders : profile.headers),
  };
  // Anthropic：API Key 走 x-api-key，账户 OAuth 令牌走 Authorization: Bearer。
  if (credential.mode === 'account') headers.authorization = `Bearer ${credential.token}`;
  else headers['x-api-key'] = credential.token;

  const body = {
    model: options.model,
    stream: true,
    // max_tokens 是 Anthropic 必填项；这里是请求级输出上限，不是模型硬上限。
    max_tokens: options.maxTokens ?? profile.defaultMaxTokens ?? 8192,
    messages: toMessages(options),
  };
  if (options.system) body.system = options.system;
  if (options.tools?.length) {
    body.tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (options.temperature != null) body.temperature = options.temperature;
  if (options.stop?.length) body.stop_sequences = options.stop;

  return { url, headers, body };
}

function textOf(blocks) {
  return (blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function parseArguments(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {}; // 模型可能吐出不完整 JSON；交给 provider 侧报错而不是在此崩溃。
  }
}

function toMessages(options) {
  const out = [];
  for (const message of options.messages) {
    if (message.role === 'system') continue; // system 走顶层字段。
    const content = [];
    for (const block of message.content || []) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text });
      else if (block.type === 'tool-call') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: parseArguments(block.arguments) });
      } else if (block.type === 'tool-result') {
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: textOf(block.content),
          ...(block.isError ? { is_error: true } : {}),
        });
      }
    }
    if (content.length) out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return out;
}

const STOP = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool-calls',
  max_tokens: 'max-tokens',
};

/**
 * SSE 帧流 → dsh-llm StreamChunk 流。
 * @param {AsyncIterable<{event:string,data:string}>} frames
 */
export async function* anthropicChunks(frames) {
  const builder = createStreamBuilder();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let reason = { kind: 'stop' };

  for await (const frame of frames) {
    let event;
    try {
      event = JSON.parse(frame.data);
    } catch {
      continue;
    }

    switch (event.type) {
      case 'message_start': {
        const u = event.message?.usage || {};
        usage.inputTokens = u.input_tokens ?? 0;
        if (u.cache_read_input_tokens) usage.cacheReadTokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens) usage.cacheWriteTokens = u.cache_creation_input_tokens;
        break;
      }

      case 'content_block_start': {
        const block = event.content_block || {};
        const key = `block:${event.index}`;
        if (block.type === 'text') {
          const { index, isNew } = builder.open(key, 'text');
          if (isNew) yield { type: 'block-start', index, blockType: 'text' };
        } else if (block.type === 'thinking') {
          const { index, isNew } = builder.open(key, 'reasoning');
          if (isNew) yield { type: 'block-start', index, blockType: 'reasoning' };
        } else if (block.type === 'tool_use') {
          const { index, isNew } = builder.open(key, 'tool-call');
          if (isNew) yield { type: 'block-start', index, blockType: 'tool-call' };
          builder.appendTool(index, { id: block.id, name: block.name, argumentsDelta: '' });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta || {};
        const key = `block:${event.index}`;
        if (delta.type === 'text_delta') {
          const { index, isNew } = builder.open(key, 'text');
          if (isNew) yield { type: 'block-start', index, blockType: 'text' };
          builder.appendText(index, delta.text);
          yield { type: 'text-delta', index, text: delta.text };
        } else if (delta.type === 'thinking_delta') {
          const { index, isNew } = builder.open(key, 'reasoning');
          if (isNew) yield { type: 'block-start', index, blockType: 'reasoning' };
          builder.appendText(index, delta.thinking);
          yield { type: 'reasoning-delta', index, text: delta.thinking };
        } else if (delta.type === 'input_json_delta') {
          const { index, isNew } = builder.open(key, 'tool-call');
          if (isNew) yield { type: 'block-start', index, blockType: 'tool-call' };
          builder.appendTool(index, { argumentsDelta: delta.partial_json });
          yield {
            type: 'tool-call-delta',
            index,
            id: builder.idOf(index) ?? '',
            argumentsDelta: delta.partial_json,
          };
        }
        break;
      }

      case 'content_block_stop': {
        // 只收口已开块：避免 provider 单独下发 stop 时凭空建出一个空文本块。
        const index = builder.indexOf(`block:${event.index}`);
        if (index !== undefined) {
          const chunk = builder.close(index);
          if (chunk) yield chunk;
        }
        break;
      }

      case 'message_delta': {
        if (event.usage?.output_tokens != null) usage.outputTokens = event.usage.output_tokens;
        if (event.delta?.stop_reason) reason = { kind: STOP[event.delta.stop_reason] ?? 'stop' };
        break;
      }

      case 'message_stop':
        break;

      case 'error':
        throw Object.assign(new Error(event.error?.message || 'anthropic stream error'), {
          code: 'PROVIDER',
          status: event.error?.status,
        });

      default:
        break;
    }
  }

  yield* builder.closeAll(); // 收口兜底。
  yield { type: 'usage', usage };
  yield { type: 'finish', reason };
}
