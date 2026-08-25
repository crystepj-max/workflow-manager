#!/usr/bin/env bash
# 本地质量闸门（issue-33 / QUALITY_GATES Gate1-4）
# Gate1 知识/API 来源可追溯：dsh-tools 版本与宿主 DSH v0.1.1-rc.2 对齐
# Gate2 本地化：本脚本与包内中文说明保持一致（不引入未翻译对外文案）
# Gate3 构建：npm run build
# Gate4 一致性 + 包测试：check-dist-fresh + node --test
set -euo pipefail
cd "$(dirname "$0")"

echo '—— Gate3 构建 ——'
node scripts/build-bundle.mjs

echo '—— Gate4 dist 新鲜度 ——'
node scripts/check-dist-fresh.mjs

echo '—— Gate1 dsh-tools 版本 ——'
node --input-type=module -e "
import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync('./package.json','utf8'))
const v = pkg.dependencies['@deepseek-ai/dsh-tools']
if (v !== '0.1.1-rc.2') {
  console.error('❌ @deepseek-ai/dsh-tools=' + v + '，期望 0.1.1-rc.2（对齐 DSH v0.1.1-rc.2）')
  process.exit(1)
}
console.log('✅ @deepseek-ai/dsh-tools=' + v + '（对齐 DSH v0.1.1-rc.2）')
"

echo '—— Gate4 包测试 ——'
node --test tests/host.test.mjs tests/runs-persistence.test.mjs tests/client.smoke.mjs tests/static-bundle.test.mjs tests/dist-fresh.test.mjs

echo
echo '✅ verify.sh 全绿'
