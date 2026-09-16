// LOC-042 诊断夹具：修复后版本
export function sum(nums) {
  if (!nums.length) return 0
  let total = 0
  for (let i = 0; i < nums.length; i++) total += nums[i]
  return total
}
