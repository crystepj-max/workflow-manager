#!/usr/bin/env bash
# 把「开发工作流 2.0」安装为公共池技能（真源：本仓库 templates/ 蓝图 + dsh/roles + dsh/skill）。
# 脚本与 meta 由单一编译器从蓝图生成（writeUserSkill 原子写盘，T-IMP-14），
# 手写编排脚本已退役删除（T-05）；runbook 用 dsh/skill/SKILL.md（含取需求/快照/门禁细节）。
# 用法：dsh/install-skill.sh [目标技能根]   默认 ~/.agents/skills（技能 = <根>/dev-workflow-2-0/）
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/.agents/skills}"

# 从蓝图生成 {SKILL.md, script.mjs, meta.json}（生成器内部先校验蓝图，失败零残留）
node "$SRC/scripts/generate.mjs" user "$SRC/templates/dev-workflow-2-0.json" "$DEST"
SKILL_DIR="$DEST/dev-workflow-2-0"

# runbook 用仓库真源（覆盖生成的通用版；内容含取需求/角色快照/人工门禁/硬规则）
cp "$SRC/dsh/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
# 角色快照进技能目录（SKILL.md runbook 步骤 2 拷贝进 run 目录留痕）
rm -rf "$SKILL_DIR/roles"
cp -R "$SRC/dsh/roles" "$SKILL_DIR/roles"

# 清除 DSH 原子写残留的 .tmpdir 目录（不属技能内容）
find "$SKILL_DIR" -type d -name "*.tmpdir" -exec rm -rf {} + 2>/dev/null || true

echo "installed -> $SKILL_DIR"
find "$SKILL_DIR" -type f | sort
