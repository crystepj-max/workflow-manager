#!/usr/bin/env bash
# 把「开发工作流 2.0」安装为公共池技能（真源：本仓库 dsh/ 目录）。
# 用法：dsh/install-skill.sh [目标目录]   默认 ~/.agents/skills/dev-workflow-2-0
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/.agents/skills/dev-workflow-2-0}"

mkdir -p "$DEST"
cp "$SRC/skill/SKILL.md" "$DEST/SKILL.md"
rm -rf "$DEST/roles" "$DEST/workflow"
cp -R "$SRC/roles"    "$DEST/roles"
cp -R "$SRC/workflow" "$DEST/workflow"

# 清除 DSH 原子写残留的 .tmpdir 目录（不属技能内容）
find "$DEST" -type d -name "*.tmpdir" -exec rm -rf {} + 2>/dev/null || true

echo "installed -> $DEST"
find "$DEST" -type f | sort
