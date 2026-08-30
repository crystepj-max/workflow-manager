#!/usr/bin/env bash
# 把「建设 · 完整功能开发」Bootstrap Profile 安装为公共池技能（自包含）
# 真源：本仓库 dsh/skills/construction-bootstrap/ + scripts/cwf-*.mjs + docs/design/construction-workflow/handoff.schema.json
# 用法：dsh/install-construction-bootstrap.sh [目标技能根]   默认 ~/.agents/skills
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/.agents/skills}"
SKILL_DIR="$DEST/construction-bootstrap"

mkdir -p "$DEST"
rm -rf "$SKILL_DIR"
cp -R "$SRC/dsh/skills/construction-bootstrap" "$SKILL_DIR"

# 运行资产随 skill 分发（自包含：外仓库调用时不依赖本仓库 checkout）
mkdir -p "$SKILL_DIR/assets"
cp "$SRC"/scripts/cwf-*.mjs "$SKILL_DIR/assets/"
cp "$SRC/docs/design/construction-workflow/handoff.schema.json" "$SKILL_DIR/assets/"

echo "installed -> $SKILL_DIR"
find "$SKILL_DIR" -type f | sort
