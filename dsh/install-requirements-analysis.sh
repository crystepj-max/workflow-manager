#!/usr/bin/env bash
# workflow-manager 的 requirements-analysis 真源直接分发到用户级技能目录。
# 用法：dsh/install-requirements-analysis.sh [目标目录]
# 默认：~/.agents/skills/requirements-analysis
set -euo pipefail

TASK_WORKFLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASK_SKILL_SOURCE="$TASK_WORKFLOW_ROOT/dsh/skills/requirements-analysis"
TASK_SKILL_DEST="${1:-$HOME/.agents/skills/requirements-analysis}"
TASK_SKILL_PARENT="$(dirname "$TASK_SKILL_DEST")"
TASK_SKILL_NAME="$(basename "$TASK_SKILL_DEST")"
TASK_SKILL_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TASK_SKILL_BACKUP_ROOT="${TASK_SKILL_BACKUP_ROOT:-$HOME/.local/share/agent-skills/backups/requirements-analysis}"
TASK_SKILL_BACKUP=""
TASK_SKILL_OLD=""

if [ ! -d "$TASK_SKILL_SOURCE" ]; then
  echo "缺少技能真源：$TASK_SKILL_SOURCE" >&2
  exit 1
fi

case "$TASK_SKILL_DEST" in
  "$TASK_SKILL_SOURCE"|"$TASK_SKILL_SOURCE"/*)
    echo "目标目录不能位于技能真源内：$TASK_SKILL_DEST" >&2
    exit 1
    ;;
esac

mkdir -p "$TASK_SKILL_PARENT"
TASK_SKILL_STAGE="$(mktemp -d "$TASK_SKILL_PARENT/.${TASK_SKILL_NAME}.stage.XXXXXX")"
trap 'rm -rf "$TASK_SKILL_STAGE"' EXIT
cp -R "$TASK_SKILL_SOURCE/." "$TASK_SKILL_STAGE/"

# 先把现有入口完整备份到技能发现目录之外，再切换安装目录。
if [ -L "$TASK_SKILL_DEST" ] || [ -e "$TASK_SKILL_DEST" ]; then
  mkdir -p "$TASK_SKILL_BACKUP_ROOT"
  TASK_SKILL_BACKUP="$TASK_SKILL_BACKUP_ROOT/$TASK_SKILL_STAMP-$$"
  if [ -L "$TASK_SKILL_DEST" ]; then
    cp -P "$TASK_SKILL_DEST" "$TASK_SKILL_BACKUP"
    if [ "$(readlink "$TASK_SKILL_DEST")" != "$(readlink "$TASK_SKILL_BACKUP")" ]; then
      echo "现有技能入口备份校验失败：$TASK_SKILL_BACKUP" >&2
      exit 1
    fi
  elif [ -d "$TASK_SKILL_DEST" ]; then
    cp -R "$TASK_SKILL_DEST" "$TASK_SKILL_BACKUP"
    if ! diff -qr "$TASK_SKILL_DEST" "$TASK_SKILL_BACKUP" >/dev/null; then
      echo "现有技能目录备份校验失败：$TASK_SKILL_BACKUP" >&2
      exit 1
    fi
  else
    cp -p "$TASK_SKILL_DEST" "$TASK_SKILL_BACKUP"
    if ! cmp -s "$TASK_SKILL_DEST" "$TASK_SKILL_BACKUP"; then
      echo "现有技能文件备份校验失败：$TASK_SKILL_BACKUP" >&2
      exit 1
    fi
  fi

  TASK_SKILL_OLD="$TASK_SKILL_PARENT/.${TASK_SKILL_NAME}.old.$TASK_SKILL_STAMP.$$"
  mv "$TASK_SKILL_DEST" "$TASK_SKILL_OLD"
fi

if ! mv "$TASK_SKILL_STAGE" "$TASK_SKILL_DEST"; then
  if [ -n "$TASK_SKILL_OLD" ] && [ -e "$TASK_SKILL_OLD" -o -L "$TASK_SKILL_OLD" ]; then
    mv "$TASK_SKILL_OLD" "$TASK_SKILL_DEST"
  fi
  echo "安装失败；旧入口已恢复。" >&2
  exit 1
fi

if [ -n "$TASK_SKILL_OLD" ]; then
  rm -rf "$TASK_SKILL_OLD"
fi

trap - EXIT
echo "installed -> $TASK_SKILL_DEST"
if [ -n "$TASK_SKILL_BACKUP" ]; then
  echo "backup -> $TASK_SKILL_BACKUP"
fi
find "$TASK_SKILL_DEST" -type f | sort
