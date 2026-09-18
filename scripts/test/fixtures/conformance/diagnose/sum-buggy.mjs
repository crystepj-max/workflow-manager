// LOC-042 诊断夹具：漏计最后一项（故意缺陷）
export function sum(nums) {
  if (!nums.length) return 0
  let total = 0
  for (let i = 0; i < nums.length - 1; i++) total += nums[i]
  return total
}
