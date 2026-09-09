#!/usr/bin/env bash
# 把「Requirements Analysis」安装为公共池技能（真源：本仓库 dsh/skills/requirements-analysis/）。
# 用法：dsh/install-requirements-analysis.sh [目标目录]   默认 ~/.agents/skills/requirements-analysis
set -euo pipefail
# 默认公共池安装交由统一治理，避免独立副本覆盖正式来源。
TASK_WORKFLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -eq 0 ] || [ "${1:-}" = "$HOME/.agents/skills/requirements-analysis" ]; then
  TASK_SKILL_REPO="$(dirname "$TASK_WORKFLOW_ROOT")/my-agent-skills"
  node "$TASK_WORKFLOW_ROOT/scripts/sync-ai-task-skill-set.mjs" "$TASK_SKILL_REPO"
  exec python3 "$TASK_SKILL_REPO/scripts/manage-skills.py" apply
fi


SRC="$(cd "$(dirname "$0")" && pwd)/skills/requirements-analysis"
DEST="${1:-$HOME/.agents/skills/requirements-analysis}"

mkdir -p "$DEST"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"
rm -rf "$DEST/evals" "$DEST/references"
cp -R "$SRC/evals"     "$DEST/evals"
cp -R "$SRC/references" "$DEST/references"

# 清除 DSH 原子写残留的 .tmpdir 目录（不属技能内容）
find "$DEST" -type d -name "*.tmpdir" -exec rm -rf {} + 2>/dev/null || true

echo "installed -> $DEST"
find "$DEST" -type f | sort
