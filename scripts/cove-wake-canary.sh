#!/usr/bin/env bash
# One-night experiment: can this Mac run a real Cove job with the lid closed?
#
# A scheduled wake puts the Mac into a "dark wake": awake enough to run
# background work, but powerd may put it back to sleep within a minute. Cove's
# morning brief and email triage take minutes, so this measures whether the
# wake window is long enough before we trust it.
#
# It runs Claude once (the part most likely to fail in a dark wake), then logs a
# heartbeat every 30 seconds for 6 minutes. If the heartbeats stop early, the
# machine slept mid-job and scheduled wakes are not enough on their own.
#
# Delete this script and com.cove.wake-canary once the question is settled.
set -uo pipefail

LOG="$HOME/Library/Logs/cove-wake-canary.log"
CLAUDE_BIN="${COVE_CLAUDE_BIN:-$HOME/.claude/local/claude}"
[ -x "$CLAUDE_BIN" ] || CLAUDE_BIN="$(command -v claude || true)"

stamp() { date "+%Y-%m-%d %H:%M:%S"; }
say() { echo "$(stamp) | $1" >> "$LOG"; }

say "START power=$(pmset -g batt | head -1 | grep -o "'.*'" | tr -d "'")"

if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_START="$(date +%s)"
  REPLY="$("$CLAUDE_BIN" -p "Reply with exactly: CANARY_OK" --model claude-haiku-4-5-20251001 2>&1 | tail -1)"
  say "CLAUDE after $(( $(date +%s) - CLAUDE_START ))s: ${REPLY:0:40}"
else
  say "CLAUDE skipped: binary not found"
fi

for i in $(seq 1 12); do
  sleep 30
  say "heartbeat $i of 12"
done

say "END: survived the full 6 minutes"
