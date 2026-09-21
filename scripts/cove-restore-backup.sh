#!/usr/bin/env bash
# Restore one Cove SQLite backup after an explicit confirmation.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_REAL="${COVE_NODE_PATH:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_REAL" ] || [ ! -x "$NODE_REAL" ]; then
  echo "Could not find Node. Set COVE_NODE_PATH or restore Node before recovering Cove." >&2
  exit 1
fi
PATH_RESOLVER="$REPO_DIR/scripts/lib/cove-runtime-paths.mjs"
DB="$("$NODE_REAL" "$PATH_RESOLVER" "$REPO_DIR" dbPath)"
BACKUP_DIR="$("$NODE_REAL" "$PATH_RESOLVER" "$REPO_DIR" backupDir)"
if [ -z "$DB" ] || [ -z "$BACKUP_DIR" ]; then
  echo "Could not resolve Cove's database and recovery paths. No files were changed." >&2
  exit 1
fi
ASSUME_YES=0

if [ "${1:-}" = "--yes" ]; then
  ASSUME_YES=1
  shift
fi
BACKUP="${1:-}"
if [ -z "$BACKUP" ]; then
  echo "Usage: bash scripts/cove-restore-backup.sh [--yes] <backup.db>" >&2
  exit 2
fi
if [ ! -f "$BACKUP" ]; then
  echo "Backup does not exist: $BACKUP" >&2
  exit 2
fi
if [ -e "$DB" ] && [ "$BACKUP" -ef "$DB" ]; then
  echo "Refusing to restore the database from itself." >&2
  exit 2
fi

database_is_open() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -t -- "$DB" >/dev/null 2>&1 ||
    lsof -t -- "$DB-wal" >/dev/null 2>&1
}

# Cove's own processes open the database per operation and close it again, so
# an idle moment reads as "nobody has it open" while the server, the worker and
# the five-minute job tick are all running and about to write. The open-handle
# check below is a race backstop, not the gate: the gate is that no Cove service
# is loaded at all.
loaded_cove_services() {
  command -v launchctl >/dev/null 2>&1 || return 0
  launchctl list 2>/dev/null |
    awk '{ print $3 }' |
    grep -E '^com\.(cove|forge)\.' || true
}

if [ "${COVE_RESTORE_ALLOW_RUNNING:-0}" != "1" ]; then
  RUNNING="$(loaded_cove_services | tr '\n' ' ')"
  if [ -n "${RUNNING// /}" ]; then
    echo "Cove is still running, so a restore could be overwritten by a live writer." >&2
    echo "Loaded: $RUNNING" >&2
    echo "Stop everything first, then retry:" >&2
    echo "  bash scripts/cove-stop.sh" >&2
    echo "(Set COVE_RESTORE_ALLOW_RUNNING=1 only if you have already stopped every Cove writer another way.)" >&2
    exit 1
  fi
fi

# A live SQLite writer may replay the old WAL after replacement. Refuse when
# lsof can cheaply prove that any process has the database or WAL open.
if database_is_open; then
  echo "Cove still has $DB open. Stop the Cove server and workers with 'bash scripts/cove-stop.sh', then retry." >&2
  exit 1
fi

"$NODE_REAL" "$REPO_DIR/scripts/cove-verify-sqlite.mjs" "$BACKUP"

if [ "$ASSUME_YES" != "1" ]; then
  if [ ! -t 0 ]; then
    echo "Restore requires an interactive confirmation (or the explicit --yes flag)." >&2
    exit 1
  fi
  printf 'Replace %s with %s? The current database will be archived. [y/N] ' "$DB" "$BACKUP"
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Restore cancelled."; exit 0 ;;
  esac
fi

mkdir -p "$(dirname "$DB")" "$BACKUP_DIR/recovery"
TEMP="$DB.restore.$$"
trap 'rm -f "$TEMP"' EXIT
cp "$BACKUP" "$TEMP"
chmod 600 "$TEMP"
"$NODE_REAL" "$REPO_DIR/scripts/cove-verify-sqlite.mjs" "$TEMP"

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
if [ -f "$DB" ]; then
  cp -p "$DB" "$BACKUP_DIR/recovery/cove-pre-restore-$STAMP.db"
fi
if [ -f "$DB-wal" ]; then
  cp -p "$DB-wal" "$BACKUP_DIR/recovery/cove-pre-restore-$STAMP.db-wal"
fi
if [ -f "$DB-shm" ]; then
  cp -p "$DB-shm" "$BACKUP_DIR/recovery/cove-pre-restore-$STAMP.db-shm"
fi

# The prompt and archive copy can take time. Re-check immediately before the
# atomic replacement, then ignore termination signals for the tiny swap window.
if database_is_open; then
  echo "Cove reopened $DB during restore. Stop the server and workers with 'bash scripts/cove-stop.sh', then retry." >&2
  exit 1
fi
trap '' HUP INT TERM
mv -f "$TEMP" "$DB"
rm -f "$DB-wal" "$DB-shm"
trap - EXIT
trap - HUP INT TERM
echo "Restored $DB from $BACKUP."
echo "Previous database files are in $BACKUP_DIR/recovery."
