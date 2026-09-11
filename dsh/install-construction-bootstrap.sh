#!/usr/bin/env bash
# 把「建设 · 完整功能开发」Bootstrap Profile 安装为公共池技能（自包含）
# 真源：本仓库 dsh/skills/construction-bootstrap/ + scripts/cwf-*.mjs + docs/design/construction-workflow/handoff.schema.json
# 用法：dsh/install-construction-bootstrap.sh [目标技能根]   默认 ~/.agents/skills
set -euo pipefail
# 默认公共池安装交由统一治理，避免独立副本覆盖正式来源。
TASK_WORKFLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -eq 0 ] || [ "${1:-}" = "$HOME/.agents/skills" ]; then
  TASK_SKILL_REPO="$(dirname "$TASK_WORKFLOW_ROOT")/my-agent-skills"
  node "$TASK_WORKFLOW_ROOT/scripts/sync-ai-task-skill-set.mjs" "$TASK_SKILL_REPO"
  exec python3 "$TASK_SKILL_REPO/scripts/manage-skills.py" apply
fi


SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/.agents/skills}"
SKILL_DIR="$DEST/construction-bootstrap"

mkdir -p "$DEST"
rm -rf "$SKILL_DIR"
cp -R "$SRC/dsh/skills/construction-bootstrap" "$SKILL_DIR"

# 运行资产随 skill 分发（自包含：外仓库调用时不依赖本仓库 checkout）
mkdir -p "$SKILL_DIR/assets"
cp "$SRC"/scripts/cwf-*.mjs "$SKILL_DIR/assets/"
cp "$SRC/scripts/ai-task-preflight-check.mjs" "$SKILL_DIR/assets/"
cp "$SRC/scripts/ai-task-workspace-env.mjs" "$SKILL_DIR/assets/"
cp "$SRC/scripts/workspace-isolation.mjs" "$SKILL_DIR/assets/"
# workspace-isolation 依赖的同仓模块（缺一不可）
for dep in cwf-checkpoint.mjs formal-records.mjs formal-artifacts.cjs cwf-validate.mjs; do
  if [[ -f "$SRC/scripts/$dep" ]]; then cp "$SRC/scripts/$dep" "$SKILL_DIR/assets/"; fi
done
cp "$SRC/docs/design/construction-workflow/handoff.schema.json" "$SKILL_DIR/assets/"
cp "$SRC/docs/design/construction-workflow-portable-contract.md" "$SKILL_DIR/assets/"
# M2 产品主链与清单（随 skill 可读）
mkdir -p "$SKILL_DIR/assets/ai-task-define-delivery"
cp "$SRC/docs/design/ai-task-define-delivery/single-task-delivery-m2.md" "$SKILL_DIR/assets/ai-task-define-delivery/"
cp "$SRC/docs/design/ai-task-define-delivery/public-task-contract.md" "$SKILL_DIR/assets/ai-task-define-delivery/"
cp "$SRC/docs/design/ai-task-define-delivery/preflight-check.md" "$SKILL_DIR/assets/ai-task-define-delivery/"
cp "$SRC/docs/design/ai-task-define-delivery/uat-card-template.md" "$SKILL_DIR/assets/ai-task-define-delivery/"
cp "$SRC/docs/design/ai-task-define-delivery/task-workspace-env.md" "$SKILL_DIR/assets/ai-task-define-delivery/"

echo "installed -> $SKILL_DIR"
find "$SKILL_DIR" -type f | sort
