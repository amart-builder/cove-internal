#!/usr/bin/env bash
# Stop every Cove background service on this Mac.
#
# A full install loads more than a dozen LaunchAgents, not just the website.
# Stopping the website alone leaves the worker, the reliability scheduler, the
# chief-of-staff lanes, the meeting watcher and the daily backup running, so
# "Cove is stopped" has to mean all of them or it means nothing.
#
#   bash scripts/cove-stop.sh             # stop everything until the next login
#   bash scripts/cove-stop.sh --disable   # stop everything and keep it stopped
#   bash scripts/cove-stop.sh --status    # list what is loaded, change nothing
#
# Nothing here deletes data. The database, backups, profile, goals and every
# private file under data/ are untouched, and re-running
# scripts/install-cove-local.sh brings the same installation back.
set -euo pipefail

UID_NUM="$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"
MODE="stop"
for arg in "$@"; do
  case "$arg" in
    --disable) MODE="disable" ;;
    --status) MODE="status" ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (expected --disable, --status or no option)" >&2
      exit 1
      ;;
  esac
done

# Every label this repo's installer has ever loaded, including the retired ones
# and the pre-rename com.forge.* names, so an older install stops too. Anything
# currently loaded or present on disk is added below, so a label added later
# still gets stopped even if this list is not updated.
KNOWN_LABELS="
com.cove.local
com.cove.local.backup
com.cove.jobs
com.cove.reminders
com.cove.claude-worker
com.cove.email-triage
com.cove.meeting-watch
com.cove.meeting-drain
com.cove.progress
com.cove.voice-review
com.cove.chief-of-staff-drain
com.cove.chief-of-staff-sweep
com.cove.chief-of-staff-nightly
com.cove.chief-of-staff-review
com.cove.morning-brief
com.cove.attention-sweep
com.cove.apple-reminders
com.cove.wake-canary
com.forge.web
com.forge.local
com.forge.local.backup
com.forge.jobs
com.forge.reminders
com.forge.claude-worker
com.forge.email-triage
com.forge.meeting-watch
com.forge.meeting-drain
com.forge.progress
com.forge.attention-sweep
"

discovered() {
  # Loaded services, plus plist files on disk that would load at the next login.
  launchctl list 2>/dev/null | awk '{ print $3 }' | grep -E '^com\.(cove|forge)(\.|$)' || true
  ls "$LA_DIR" 2>/dev/null | sed -n 's/^\(com\.\(cove\|forge\)\..*\)\.plist$/\1/p' || true
}

labels() {
  { printf '%s\n' $KNOWN_LABELS; discovered; } | sed '/^$/d' | sort -u
}

loaded() {
  launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1
}

if [ "$MODE" = "status" ]; then
  any=0
  while read -r label; do
    [ -n "$label" ] || continue
    state="not loaded"
    if loaded "$label"; then state="loaded"; any=1; fi
    installed="no plist"
    if [ -e "$LA_DIR/$label.plist" ]; then installed="starts at login"; fi
    printf '%-38s %-11s %s\n' "$label" "$state" "$installed"
  done <<< "$(labels)"
  if [ "$any" = "0" ]; then
    echo
    echo "No Cove service is running right now."
  fi
  exit 0
fi

stopped=0
while read -r label; do
  [ -n "$label" ] || continue
  if loaded "$label"; then
    launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
    echo "Stopped $label"
    stopped=$((stopped + 1))
  fi
  if [ "$MODE" = "disable" ] && [ -e "$LA_DIR/$label.plist" ]; then
    # bootout only unloads: launchd loads every plist in ~/Library/LaunchAgents
    # again at the next login. disable is what survives a restart, and the
    # installer's own `launchctl enable` calls undo it on the next install.
    launchctl disable "gui/$UID_NUM/$label" 2>/dev/null || true
  fi
done <<< "$(labels)"

echo
if [ "$stopped" = "0" ]; then
  echo "No Cove service was running."
else
  echo "Stopped $stopped Cove service(s). Your data was not touched."
fi
if [ "$MODE" = "disable" ]; then
  echo "They will stay stopped after a restart."
  echo "To start Cove again: bash scripts/install-cove-local.sh"
else
  echo "They start again at your next login (or restart)."
  echo "To keep them stopped: bash scripts/cove-stop.sh --disable"
  echo "To start Cove again now: bash scripts/install-cove-local.sh"
fi
