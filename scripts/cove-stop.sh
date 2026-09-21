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
COVE_SERVING_REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COVE_SERVING_NODE="${COVE_NODE_PATH:-$(command -v node 2>/dev/null || true)}"
if [ -r "$COVE_SERVING_REPO_DIR/scripts/lib/cove-serving.sh" ]; then
  # shellcheck source=scripts/lib/cove-serving.sh
  . "$COVE_SERVING_REPO_DIR/scripts/lib/cove-serving.sh"
else
  # Stopping Cove matters more than the extra line this would have printed.
  cove_is_serving() { return 1; }
fi

# launchctl cannot stop a Cove nobody asked launchd to start, and this script
# has no business killing a process someone is watching in their own terminal.
# Saying it is there is the whole job: the sentence above it would otherwise
# read as "nothing is running", which is what sends someone into a restore.
report_hand_started_cove() {
  cove_is_serving || return 0
  echo
  echo "A Cove started by hand is still answering on http://127.0.0.1:$COVE_WEB_PORT."
  echo "This script cannot stop that one. Stop it in the terminal that started it"
  echo "(Control-C), then check again."
}

MODE="stop"
for arg in "$@"; do
  case "$arg" in
    --disable) MODE="disable" ;;
    --status) MODE="status" ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
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

# `launchctl disable` writes a persistent override: it survives a restart, it
# outlives the plist, and only an `enable` clears it. So after this script's
# own --disable, the plists are still on disk and the old --status said
# "starts at login" about services that will not start at all. Read once,
# because it is a per-user database rather than a per-label lookup.
#
# The output has had two shapes across macOS releases -- `"label" => true` and
# `"label" => disabled` -- so both count, and anything unrecognised counts as
# not disabled. If the command is missing or fails, DISABLED is empty and this
# reports exactly what it always did.
DISABLED="$(launchctl print-disabled "gui/$UID_NUM" 2>/dev/null || true)"
is_disabled() {
  printf '%s\n' "$DISABLED" | grep -qE "\"$1\" *=> *(true|disabled)"
}

if [ "$MODE" = "status" ]; then
  # Only report labels that exist on this Mac. The known list carries every
  # label this installer has ever written, including retired and pre-rename
  # ones, so printing all of them buried the fourteen that matter under
  # fifteen rows of "not loaded / no plist".
  any=0
  shown=0
  any_blocked=0
  while read -r label; do
    [ -n "$label" ] || continue
    state="not loaded"
    if loaded "$label"; then state="loaded"; any=1; fi
    installed=""
    blocked=0
    if [ -e "$LA_DIR/$label.plist" ]; then
      if is_disabled "$label"; then
        installed="disabled: will not start"
        blocked=1
        any_blocked=1
      else
        installed="starts at login"
      fi
    fi
    if [ "$state" = "not loaded" ] && [ -z "$installed" ]; then continue; fi
    [ -n "$installed" ] || installed="no plist"
    printf '%-38s %-11s %s\n' "$label" "$state" "$installed"
    shown=$((shown + 1))
  done <<< "$(labels)"
  echo
  if [ "$any_blocked" = "1" ]; then
    echo "A disabled service stays stopped through a restart, outlives its"
    echo "own file, and files no failure anywhere because it never runs."
    echo "To clear that: bash scripts/install-cove-local.sh"
  fi
  if [ "$shown" = "0" ]; then
    echo "Cove is not installed on this Mac: no service is running and no"
    echo "start-at-login file is present."
  elif [ "$any" = "0" ]; then
    echo "No Cove service is running right now."
  fi
  report_hand_started_cove
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
report_hand_started_cove
