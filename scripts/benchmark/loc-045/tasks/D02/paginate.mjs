export function paginate(data, page, size) {
  if (page < 1 || size < 1) throw new Error('invalid page or size')
  const start = (page - 1) * size
  return data.slice(start, start + size + 1)
}
