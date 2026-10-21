/** Shared, deterministic checks for versioned task-definition files. */
export function strictDefinitionCheck(text) {
  if (!text || !text.trim()) return { ok: false, reason: 'Definition Check 文件缺失或为空' }
  const body = text.split(/^##\s*结论/m)[0]
  const unchecked = [...body.matchAll(/^\s*-\s*\[\s\]/gm)]
  if (unchecked.length) return { ok: false, reason: `Definition Check 存在 ${unchecked.length} 项未勾选` }
  const openMatch = text.match(/未决产品事项[^\n|]*[|｜][^\n|]*[|｜]\s*(\d+)/)
  if (openMatch && Number(openMatch[1]) !== 0) {
    return { ok: false, reason: `Definition Check 未决产品事项=${openMatch[1]}（须为 0）` }
  }
  if (/未决产品事项[^\n]*[：:]\s*[1-9]/.test(text)) {
    return { ok: false, reason: 'Definition Check 声明存在未决产品事项' }
  }
  return { ok: true }
}

export function specOpenItemsZero(spec) {
  return /未决产品事项[^\n]*[：:]\s*(\*\*)?0\b/.test(spec)
    || /未决[^。\n]*为\s*\*\*0\*\*/.test(spec)
    || /未决事项\s*=\s*0/.test(spec)
    || /\|[^\n]*未决[^\n]*\|\s*0\s*\|/.test(spec)
}
