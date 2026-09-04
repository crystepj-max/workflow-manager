// 零依赖 SSE 解析器：把 Response.body 读成 {event, data} 帧流。
// 仅覆盖 LLM 流式响应用到的子集（data / event 字段、注释行、[DONE] 哨兵）。

/**
 * @param {ReadableStream<Uint8Array>} body
 * @yields {{event:string, data:string}}
 */
export async function* parseSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flush = function* (final) {
    if (!buffer.trim()) return;
    const frame = parseFrame(buffer);
    buffer = '';
    if (frame) yield frame;
    if (final) return;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frameText = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = parseFrame(frameText);
        if (frame) yield frame;
      }
    }
    yield* flush(true);
  } finally {
    reader.releaseLock?.();
  }
}

function parseFrame(frameText) {
  let event = 'message';
  const data = [];
  for (const rawLine of frameText.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}
