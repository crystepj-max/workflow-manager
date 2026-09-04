// 流式块索引与累积：把两家 provider 的增量事件归一到 dsh-llm 的 StreamChunk 协议。
// StreamChunk 约定：block-start 开块 → 若干 *-delta（同 index 关联）→ block-end 携带完整块；
// usage 先于 finish，且 finish 之后不再有任何块。

import { CallId } from '@deepseek-ai/dsh-llm';

export function createStreamBuilder() {
  const byKey = new Map(); // 逻辑键（如 'text' / 'tool:0'）→ 块 index
  const blocks = new Map(); // index → 可变草稿块
  let next = 0;

  /**
   * 开块（幂等）：同一逻辑键复用同一 index。
   * @returns {{index:number, isNew:boolean, blockType:string}} isNew 时由调用方 yield block-start。
   */
  function open(key, blockType) {
    const known = byKey.get(key);
    if (known !== undefined) return { index: known, isNew: false, blockType };
    const index = next++;
    byKey.set(key, index);
    blocks.set(
      index,
      blockType === 'text'
        ? { type: 'text', text: '' }
        : blockType === 'reasoning'
          ? { type: 'reasoning', text: '' }
          : { type: 'tool-call', id: undefined, name: '', arguments: '' },
    );
    return { index, isNew: true, blockType };
  }

  function appendText(index, delta) {
    const block = blocks.get(index);
    if (block && typeof delta === 'string') block.text += delta;
  }

  function appendTool(index, { id, name, argumentsDelta }) {
    const block = blocks.get(index);
    if (!block || block.type !== 'tool-call') return;
    if (id) block.id = CallId(id);
    if (name) block.name += name;
    if (argumentsDelta) block.arguments += argumentsDelta;
  }

  /** 已开块的 CallId（tool-call-delta 的必填字段）；未开块返回 undefined。 */
  function idOf(index) {
    return blocks.get(index)?.id;
  }

  /** 该逻辑键是否已开块。供显式 block-stop 事件判断，避免凭空建块。 */
  function has(key) {
    return byKey.has(key);
  }

  /** 取已开块的 index；未开块返回 undefined。 */
  function indexOf(key) {
    return byKey.get(key);
  }

  /**
   * 收口单个块，返回 block-end（已关闭或未开块返回 null）。
   * patch 用于 provider 在 done 事件里给出的**权威完整值**（如 Responses 的
   * output_item.done 携带全文/完整参数），覆盖增量累积结果，避免截断。
   */
  function close(index, patch) {
    const block = blocks.get(index);
    if (!block) return null;
    if (patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'string' && value) block[key] = value;
      }
    }
    blocks.delete(index);
    for (const [key, value] of byKey) if (value === index) byKey.delete(key);
    return { type: 'block-end', index, block: { ...block } };
  }

  /** 按 index 升序收口所有仍未关闭的块（流结束兜底）。 */
  function* closeAll() {
    for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
      const chunk = close(index);
      if (chunk) yield chunk;
    }
  }

  return { open, appendText, appendTool, idOf, has, indexOf, close, closeAll };
}
