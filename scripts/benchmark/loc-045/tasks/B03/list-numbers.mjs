export function listNumbers(xs) {
  if (!Array.isArray(xs)) throw new TypeError('expected array')
  return [...xs]
}
