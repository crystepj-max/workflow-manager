export function maxValue(xs) {
  if (!Array.isArray(xs)) throw new TypeError('expected array')
  if (xs.length === 0) throw new Error('empty')
  return xs.reduce((m, v) => (v ? Math.max(m, v) : m), xs[0])
}
