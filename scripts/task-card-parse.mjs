// 任务卡 / 本地任务规格 Markdown 解析内核——唯一实现。
// 消费方：ai-task-preflight-check / ai-task-execution-plan / local-task-merge。
// 纯函数：不读文件、不做业务裁决；字段名词汇与规格版本 fallback 各只有这一处。
// 历史：三份 field() 副本与两份版本 fallback（6 级 vs 3 级）曾各自漂移（LOC-002 收敛）。

import path from 'node:path'

export const TASK_FIELDS = {
  TASK_ID: '任务标识',
  NAME: '任务名称',
  TYPE: '任务类型',
  STATUS: '当前状态',
  PRIORITY: '优先级',
  BASELINE: '需求基线版本',
  DEPS: '前置依赖',
  SPEC_LOC: '任务规格位置',
  DEFINED_AT: '定义时间',
  ENV_GROUP: '施工环境组',
  ENV_ROLE: '施工环境角色',
  UNATTENDED: '无人值守许可',
  GITHUB_SYNC: 'GitHub 同步',
}

export function field(md, name) {
  // 表格行：| 字段 | 值 |
  const re = new RegExp(`\\|\\s*${name}\\s*\\|\\s*([^|]+)\\|`)
  const m = md.match(re)
  return m ? m[1].trim() : null
}

// 规格版本解析唯一实现 = 6 级 fallback 并集（原 preflight 版；merge 旧 3 级为其子集）。
// 顺序：① 需求基线版本表格字段 → ② **版本**：VN → ③ 版本：VN → ④ 标题行 VN
//       → ⑤ task-spec-VN → ⑥ 文件名 VN；全不命中返回 null。
export function parseSpecVersion(specMd, specPath = '') {
  return (
    field(specMd, TASK_FIELDS.BASELINE) ||
    (specMd.match(/\*\*版本\*\*[：:]\s*(V\d+)/i) || [])[1] ||
    (specMd.match(/版本[：:]\s*(V\d+)/i) || [])[1] ||
    (specMd.match(/^#\s*.*\b(V\d+)\b/m) || [])[1] ||
    (specMd.match(/task-spec-(V\d+)/i) || [])[1] ||
    (path.basename(specPath).match(/(V\d+)/i) || [])[1]
  ) || null
}
