// OpenAI Chat Completions 线格式（流式）——API Key 模式走这条。
// 账户（ChatGPT 账号令牌）模式走 Responses 协议，见 wire-openai-responses.js；
// openaiWire() 按凭据模式分发。

import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { createStreamBuilder } from './blocks.js';
import { responsesRequest, responsesChunks } from './wire-openai-responses.js';

/** 按凭据模式选择线格式。 */
export function openaiWire(credential) {
  return credential.mode === 'account'
    ? { request: responsesRequest, chunks: responsesChunks }
    : { request: chatRequest, chunks: chatChunks };
}

export function chatRequest(profile, options, credential) {
  const target = profile.endpoint;
  const url = `${target.baseURL.replace(/\/+$/, '')}${target.path}`;

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...attributionHeaders(),
    ...(profile.headers || {}),
    authorization: `Bearer ${credential.token}`,
  };

  const body = {
    model: options.model,
    stream: true,
    // 让 usage 以独立 chunk 下发（位于 finish_reason 之后、流结束之前）。
    stream_options: { include_usage: true },
    messages: toMessages(options),
  };
  if (options.tools?.length) {
    body.tools = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (options.temperature != null) body.temperature = options.temperature;
  if (options.maxTokens != null) body.max_tokens = options.maxTokens;
  if (options.stop?.length) body.stop = options.stop;

  return { url, headers, body };
}

function textOf(blocks) {
  return (blocks || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function toMessages(options) {
  const out = [];
  if (options.system) out.push({ role: 'system', content: options.system });

  for (const message of options.messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: textOf(message.content) });
      continue;
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content);
      const calls = (message.content || []).filter((b) => b.type === 'tool-call');
      const item = { role: 'assistant' };
      if (text) item.content = text;
      if (calls.length) {
        item.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      if (!item.content && !item.tool_calls) item.content = '';
      out.push(item);
      continue;
    }
    // user：工具结果必须独立成 tool 角色消息，其余内容合成一条 user 消息。
    const results = (message.content || []).filter((b) => b.type === 'tool-result');
    for (const result of results) {
      out.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: textOf(result.content) || '',
      });
    }
    const rest = (message.content || []).filter((b) => b.type !== 'tool-result');
    if (rest.length) out.push({ role: 'user', content: textOf(rest) });
  }
  return out;
}

const FINISH = { stop: 'stop', tool_calls: 'tool-calls', length: 'max-tokens', content_filter: 'stop' };

/**
 * SSE 帧流 → dsh-llm StreamChunk 流。
 * @param {AsyncIterable<{event:string,data:string}>} frames
 */
export async function* chatChunks(frames) {
  const builder = createStreamBuilder();
  let usage;
  let reason = { kind: 'stop' };

  for await (const frame of frames) {
    if (frame.data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(frame.data);
    } catch {
      continue; // 非 JSON 帧忽略（心跳、注释）。
    }

    if (chunk.usage) {
      // 计数互斥契约：prompt_tokens 含缓存，故扣掉 cached_tokens 后再报 inputTokens。
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      usage = {
        inputTokens: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached),
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(cached ? { cacheReadTokens: cached } : {}),
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content) {
      const { index, isNew } = builder.open('text', 'text');
      if (isNew) yield { type: 'block-start', index, blockType: 'text' };
      builder.appendText(index, delta.content);
      yield { type: 'text-delta', index, text: delta.content };
    }

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      const { index, isNew } = builder.open('reasoning', 'reasoning');
      if (isNew) yield { type: 'block-start', index, blockType: 'reasoning' };
      builder.appendText(index, reasoning);
      yield { type: 'reasoning-delta', index, text: reasoning };
    }

    for (const call of delta.tool_calls || []) {
      const key = `tool:${call.index ?? 0}`;
      const { index, isNew } = builder.open(key, 'tool-call');
      if (isNew) yield { type: 'block-start', index, blockType: 'tool-call' };
      builder.appendTool(index, {
        id: call.id,
        name: call.function?.name,
        argumentsDelta: call.function?.arguments,
      });
      yield {
        type: 'tool-call-delta',
        index,
        id: call.id ?? '',
        ...(call.function?.name ? { name: call.function.name } : {}),
        argumentsDelta: call.function?.arguments ?? '',
      };
    }

    if (choice.finish_reason) {
      yield* builder.closeAll();
      reason = { kind: FINISH[choice.finish_reason] ?? 'stop' };
    }
  }

  yield* builder.closeAll(); // 收口兜底：provider 未给 finish_reason 时也补齐 block-end。
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason };
}
