#!/usr/bin/env bash
# 把「Requirements Analysis」安装为公共池技能（真源：本仓库 dsh/skills/requirements-analysis/）。
# 用法：dsh/install-requirements-analysis.sh [目标目录]   默认 ~/.agents/skills/requirements-analysis
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/skills/requirements-analysis"
DEST="${1:-$HOME/.agents/skills/requirements-analysis}"

mkdir -p "$DEST"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"
rm -rf "$DEST/evals" "$DEST/references"
cp -R "$SRC/evals"     "$DEST/evals"
cp -R "$SRC/references" "$DEST/references"
# references 须含：task-spec / issue-basics / definition-check / baseline-change-v1-v2 / openspec

# 清除 DSH 原子写残留的 .tmpdir 目录（不属技能内容）
find "$DEST" -type d -name "*.tmpdir" -exec rm -rf {} + 2>/dev/null || true

echo "installed -> $DEST"
find "$DEST" -type f | sort
