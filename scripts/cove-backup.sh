#!/usr/bin/env bash
# Back up the local Cove database. Keeps the 14 most recent copies.
# Run by the com.cove.local.backup LaunchAgent once a day.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB="${COVE_DB_PATH:-$REPO_DIR/data/forge.db}"
BACKUP_DIR="$REPO_DIR/data/backups"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB" ]; then
  echo "No database at $DB yet; nothing to back up."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/forge-$STAMP.db"

# SQLite's online backup is consistent even while Cove is running.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB" ".backup '$DEST'"
else
  cp "$DB" "$DEST"
fi
echo "Backed up to $DEST"

# Keep only the 14 newest backups.
ls -1t "$BACKUP_DIR"/forge-*.db 2>/dev/null | tail -n +15 | while read -r old; do
  rm -f "$old"
done
