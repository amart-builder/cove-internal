#!/usr/bin/env bash
# Run one deterministic, unattended inbox triage.
#
# Gmail access stays in the trusted runner. The model receives bounded email text
# through a tool-free, empty-MCP process and returns validated JSON only. It never
# receives Google credentials or a Gmail, Calendar, Drive, shell, or send tool.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/Library/Logs/cove-email-triage.log"
CONFIG="$REPO_DIR/data/cove-workspace.json"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

if [ ! -f "$CONFIG" ]; then
  echo "[$(ts)] Google Workspace is not connected; skipping email triage." >> "$LOG"
  exit 0
fi

WEEKDAYS_ONLY="$(node -e '
  const c = require(process.argv[1]);
  process.stdout.write(c.weekdays_only === true ? "true" : "false");
' "$CONFIG" 2>/dev/null || true)"
DOW="$(date +%u)"
if [ "$WEEKDAYS_ONLY" = "true" ] && { [ "$DOW" = "6" ] || [ "$DOW" = "7" ]; }; then
  echo "[$(ts)] Weekend schedule skipped." >> "$LOG"
  exit 0
fi

NODE_BIN="$(node -p 'process.execPath' 2>/dev/null || true)"
TSX_LOADER="$REPO_DIR/node_modules/tsx/dist/loader.mjs"
if [ -z "$NODE_BIN" ] || [ ! -f "$TSX_LOADER" ]; then
  echo "[$(ts)] Node or the tsx loader is unavailable." >> "$LOG"
  exit 127
fi

echo "[$(ts)] Deterministic email triage starting." >> "$LOG"
"$NODE_BIN" --import "$TSX_LOADER" \
  "$REPO_DIR/scripts/cove-email-runner.ts" >> "$LOG" 2>&1
CODE=$?
echo "[$(ts)] Deterministic email triage finished (exit $CODE)." >> "$LOG"
exit "$CODE"
