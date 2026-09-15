#!/usr/bin/env bash
# Create a fresh local database backup. --daily deduplicates scheduled runs.
# Run by the com.cove.local.backup LaunchAgent and safe to invoke by hand.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TSX_LOADER="$REPO_DIR/node_modules/tsx/dist/loader.mjs"
NODE_REAL="${COVE_NODE_PATH:-}"
if [ -z "$NODE_REAL" ]; then
  NODE_REAL="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_REAL" ] || [ ! -f "$TSX_LOADER" ]; then
  echo "Could not find Node or the tsx loader. Run npm install first." >&2
  exit 1
fi

# The jobs entry point loads .env.local before resolving paths. Do not inject
# a default DB_PATH here: it would override the person's saved database path.
exec "$NODE_REAL" --import "$TSX_LOADER" \
  "$REPO_DIR/scripts/cove-jobs.ts" enqueue-backup --run "$@"
