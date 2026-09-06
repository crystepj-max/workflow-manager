#!/usr/bin/env bash
# 把「Execution Plan / 批量调度」安装为公共池技能（含到点开跑说明）
# 真源：本仓库 dsh/skills/execution-plan/ + 调度/到点脚本
# 用法：dsh/install-execution-plan.sh [目标技能根]   默认 ~/.agents/skills
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/.agents/skills}"
SKILL_DIR="$DEST/execution-plan"

mkdir -p "$DEST"
rm -rf "$SKILL_DIR"
cp -R "$SRC/dsh/skills/execution-plan" "$SKILL_DIR"

mkdir -p "$SKILL_DIR/assets"
cp "$SRC/scripts/ai-task-execution-plan.mjs" "$SKILL_DIR/assets/"
cp "$SRC/scripts/ai-task-preflight-check.mjs" "$SKILL_DIR/assets/"
cp "$SRC/scripts/ai-task-scheduled-trigger.mjs" "$SKILL_DIR/assets/"
mkdir -p "$SKILL_DIR/assets/ai-task-define-delivery"
cp "$SRC/docs/design/ai-task-define-delivery/execution-plan-m3.md" "$SKILL_DIR/assets/ai-task-define-delivery/"
cp "$SRC/docs/design/ai-task-define-delivery/scheduled-trigger-m4.md" "$SKILL_DIR/assets/ai-task-define-delivery/"
cp "$SRC/docs/design/ai-task-define-delivery/public-task-contract.md" "$SKILL_DIR/assets/ai-task-define-delivery/"
cp "$SRC/docs/design/ai-task-define-delivery/skill-set.md" "$SKILL_DIR/assets/ai-task-define-delivery/"

echo "installed -> $SKILL_DIR"
find "$SKILL_DIR" -type f | sort
