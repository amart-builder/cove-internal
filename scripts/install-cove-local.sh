#!/usr/bin/env bash
# Cove's installer is a renderer and reconciler for one local Mac.
#
# Its phases are intentionally ordered: resolve real machine paths, validate the
# runtime, render private LaunchAgent files, retire conflicting legacy agents,
# load the new agents, and prove readiness. It is safe to rerun because it owns
# only Cove-labeled plist files and preserves the database and user config.
# Never turn a failed check into a warning merely to finish an installation.
# Set up Cove to run locally and start automatically on login.
#   - Serves http://localhost:3200 (bound to localhost only; never exposed to the network)
#   - Restarts itself if it crashes or the Mac reboots
#   - Backs up the database once a day
# Safe to re-run: it replaces any previous Cove LaunchAgents.
set -euo pipefail

# --mini adds the always-on Mac Mini's scheduled brief profile. Meeting watch
# and progress reconciliation are standard single-Mac lanes on every install.
# The default install does not schedule a 7:30 brief agent; backfill and the
# post-settlement trigger cover a laptop that was asleep.
MINI=0
for arg in "$@"; do
  case "$arg" in
    --mini) MINI=1 ;;
  esac
done

# The default web profile is the MacBook, which can open local Claude Code deep
# links. The existing --mini profile defaults web-facing Buddy config to the
# portable resume-command behavior documented in BUDDY-DEPLOY.md.
if [ -n "${COVE_BUDDY_DEEPLINKS:-}" ]; then
  BUDDY_DEEPLINKS="$COVE_BUDDY_DEEPLINKS"
elif [ "$MINI" = "1" ]; then
  BUDDY_DEEPLINKS=0
else
  BUDDY_DEEPLINKS=1
fi

# Optional content-engine integration. Set COVE_SUPERNOVA_DIR to the checkout;
# nothing is guessed from the filesystem, because no two machines are laid out
# the same way and a wrong guess silently feeds the brief the wrong repo.
SUPERNOVA_DIR=""
if [ -n "${COVE_SUPERNOVA_DIR:-}" ] && [ -d "$COVE_SUPERNOVA_DIR" ]; then
  SUPERNOVA_DIR="$COVE_SUPERNOVA_DIR"
fi
SUPERNOVA_PLIST_ENTRY=""
if [ -n "$SUPERNOVA_DIR" ]; then
  # & is the whole-match reference in a sed replacement, so each entity needs a
  # single backslash escape. Two backslashes would emit a literal backslash.
  SUPERNOVA_XML_DIR="$(printf '%s' "$SUPERNOVA_DIR" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g')"
  printf -v SUPERNOVA_PLIST_ENTRY \
    '    <key>COVE_SUPERNOVA_DIR</key>\n    <string>%s</string>' \
    "$SUPERNOVA_XML_DIR"
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs"
LA_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

resolve_atlas_root() {
  if [ -n "${COVE_ATLAS_ROOT:-}" ]; then
    printf '%s\n' "$COVE_ATLAS_ROOT"
  elif [[ "$REPO_DIR" == */Atlas/Projects/* ]]; then
    printf '%s\n' "${REPO_DIR%%/Projects/*}"
  elif [[ "$REPO_DIR" == */Atlas/projects/* ]]; then
    printf '%s\n' "${REPO_DIR%%/projects/*}"
  else
    printf '%s\n' "$HOME/Atlas"
  fi
}

# The product was formerly called Forge, so an older install can still have
# com.forge.* LaunchAgents. Two agents for the same role would run side by side
# against one database, so every com.cove.* agent this script installs first
# unloads and deletes its com.forge.* predecessor. Safe when none exists.
retire_legacy_agent() {
  launchctl bootout "gui/$UID_NUM/com.forge.$1" 2>/dev/null || true
  rm -f "$LA_DIR/com.forge.$1.plist"
}
# Resolve the real Node binary. process.execPath follows nvm/fnm/Volta shims to
# the actual executable, which is what launchd needs in its bare environment.
NODE_REAL="$(node -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
if [ -z "$NODE_REAL" ]; then
  echo "Node.js is not on PATH. Install Node (brew install node), then re-run this script." >&2
  exit 1
fi
NODE_BIN="$(dirname "$NODE_REAL")"
case "$NODE_REAL" in
  *nvm*|*fnm*|*volta*|*/.asdf/*)
    echo "Note: Node is managed by a version manager. If Cove stops starting after you switch Node versions, re-run this script." ;;
esac

# SECURITY_AND_INTEGRATIONS.md promises a "mode-0600 .env.local" and sends
# people there to put a Granola API key. That was only true of a file this
# script created: one written by hand first -- which the setup playbook asks
# for, to set COVE_CHIEF_OF_STAFF or COVE_BRIEF_WEB_BASE before the install --
# kept its author's umask, normally 0644, and nothing here narrowed it. This
# only ever tightens, and only a file Cove already owns.
if [ ! -e "$REPO_DIR/.env.local" ]; then
  install -m 600 /dev/null "$REPO_DIR/.env.local"
  echo "Created a private empty .env.local. Add optional Cove settings there when needed."
else
  chmod 600 "$REPO_DIR/.env.local"
fi
local_env_value() {
  "$NODE_REAL" --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { loadLocalEnv } = await import(pathToFileURL(process.argv[1]).href);
    const loaded = loadLocalEnv(process.argv[2], { ...process.env });
    process.stdout.write(loaded[process.argv[3]] ?? "");
  ' "$REPO_DIR/scripts/lib/load-local-env.mjs" "$REPO_DIR" "$1"
}
# A saved provider identifies the assisted full setup. Existing installs without
# settings retain their explicit service choices.
INSTALL_RUNTIME="$REPO_DIR/scripts/lib/cove-install-runtime.mjs"
COVE_DATA_DIR="$("$NODE_REAL" "$INSTALL_RUNTIME" "$REPO_DIR" dataDir)"
COVE_DB_PATH="$("$NODE_REAL" "$INSTALL_RUNTIME" "$REPO_DIR" dbPath)"
COVE_BACKUP_DIR="$("$NODE_REAL" "$INSTALL_RUNTIME" "$REPO_DIR" backupDir)"
COVE_BRIEF_WEB_BASE="$("$NODE_REAL" "$INSTALL_RUNTIME" "$REPO_DIR" webBase)"
WEB_HOST="$("$NODE_REAL" "$INSTALL_RUNTIME" "$REPO_DIR" host)"
WEB_PORT="$("$NODE_REAL" "$INSTALL_RUNTIME" "$REPO_DIR" port)"
export COVE_DATA_DIR COVE_DB_PATH COVE_BRIEF_WEB_BASE

# Every JSON store under here is written 0600 into a directory its writer
# creates 0700 -- but data/ ships in the checkout with three example files, so
# it already exists at whatever the clone gave it, normally 0755, and none of
# those writers ever narrows it. cove.db is the other half: SQLite creates it
# under the umask, 0644, and it holds the tasks, commitments, contacts and
# triage records that the 0600 files around it are being careful about.
# Narrowing the directory covers both, and every Cove lane runs as this user.
mkdir -p "$COVE_DATA_DIR"
chmod 700 "$COVE_DATA_DIR"
BUDDY_APP_URL="$(local_env_value COVE_BUDDY_APP_URL)"
BUDDY_APP_URL="${BUDDY_APP_URL:-$COVE_BRIEF_WEB_BASE}"
AGENT_PROVIDER="$("$NODE_REAL" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { readAgentSettings } = await import(pathToFileURL(process.argv[1]).href);
  process.stdout.write(readAgentSettings()?.provider ?? "");
' "$REPO_DIR/src/lib/agent-settings.mjs")"
CHIEF_OF_STAFF_OPT_IN="$(local_env_value COVE_CHIEF_OF_STAFF)"
if [ -z "$CHIEF_OF_STAFF_OPT_IN" ] && [ -n "$AGENT_PROVIDER" ]; then CHIEF_OF_STAFF_OPT_IN=1; fi

NEXT_BIN="$REPO_DIR/node_modules/.bin/next"
if [ ! -x "$NEXT_BIN" ]; then
  echo "Could not find Next.js at $NEXT_BIN. Run 'npm install' and 'npm run build' first." >&2
  exit 1
fi
TSX_BIN="$REPO_DIR/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "Could not find tsx at $TSX_BIN. Run 'npm install' first." >&2
  exit 1
fi
CLAUDE_BIN="$(local_env_value COVE_CLAUDE_BIN)"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
if [ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude"
fi
if [ "$AGENT_PROVIDER" != "codex" ] && { [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; }; then
  echo "Claude Code is required for Cove execution. Install it or set COVE_CLAUDE_BIN." >&2
  exit 1
fi
JOB_RUNNER="$(local_env_value COVE_JOB_RUNNER)"
JOB_RUNNER="${JOB_RUNNER:-codex-sol-high}"
if [ "$AGENT_PROVIDER" = "claude" ]; then JOB_RUNNER=claude; fi
if [ "$AGENT_PROVIDER" = "codex" ]; then JOB_RUNNER=codex-sol-high; fi
case "$JOB_RUNNER" in
  codex-sol-high|claude) ;;
  *)
    echo "COVE_JOB_RUNNER must be 'codex-sol-high' or 'claude'." >&2
    exit 1
    ;;
esac
CODEX_BIN="$(local_env_value COVE_CODEX_BIN)"
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || true)}"
if [ -z "$CODEX_BIN" ] && [ -x "$HOME/.local/bin/codex" ]; then
  CODEX_BIN="$HOME/.local/bin/codex"
fi
if [ -z "$CODEX_BIN" ] && [ -x "/opt/homebrew/bin/codex" ]; then
  CODEX_BIN="/opt/homebrew/bin/codex"
fi
if [ -z "$CODEX_BIN" ] && [ -x "/usr/local/bin/codex" ]; then
  CODEX_BIN="/usr/local/bin/codex"
fi
if [ "$JOB_RUNNER" = "codex-sol-high" ] && { [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; }; then
  if [ -z "$AGENT_PROVIDER" ]; then
    # No saved selection, so JOB_RUNNER fell back to the legacy Codex default.
    # On a first install that is not a Codex problem: Step 0 of SETUP.md has not
    # been finished yet. Naming an environment variable the person never set
    # sends them to install a CLI they may have deliberately not chosen.
    echo "Cove has no saved agent selection yet, so it fell back to its legacy Codex runner and could not find the Codex CLI." >&2
    echo "Choose and verify the agent first, then re-run this installer:" >&2
    echo "  node scripts/cove-agent-settings.mjs configure --provider claude   # or --provider codex" >&2
    echo "(For an older install that really does run on Codex, install the Codex CLI or set COVE_CODEX_BIN in .env.local.)" >&2
  else
    echo "COVE_JOB_RUNNER=codex-sol-high requires an executable Codex CLI. Install it or set COVE_CODEX_BIN." >&2
  fi
  exit 1
fi
# An explicit opt-in must not silently become a successful install with the
# requested service off. Check before building helpers or replacing any agents.
if [ "$CHIEF_OF_STAFF_OPT_IN" = "1" ]; then
  if [ "$AGENT_PROVIDER" != "claude" ] && { [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; }; then
    echo "Chief of staff was requested but Codex CLI is missing. Install it or set COVE_CODEX_BIN, then re-run." >&2
    exit 1
  fi
  if [ ! -s "${COVE_DATA_DIR:-$REPO_DIR/data}/cove-mandate.md" ]; then
    echo "Chief of staff was requested but data/cove-mandate.md is missing or empty. Complete the setup mandate, then re-run." >&2
    exit 1
  fi
fi
CODEX_PLIST_ENTRY=""
if [ -n "$CODEX_BIN" ]; then
  CODEX_XML_BIN="$(printf '%s' "$CODEX_BIN" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g')"
  printf -v CODEX_PLIST_ENTRY \
    '    <key>COVE_CODEX_BIN</key>\n    <string>%s</string>' \
    "$CODEX_XML_BIN"
fi

# Buddy, replan, spawn-session and /login all run inside the web app, and they
# resolve the CLI as COVE_CLAUDE_BIN or, failing that, the literal path
# $HOME/.local/bin/claude. Neither spelling consults PATH. The worker plist
# carries the resolved path; without the same entry here, a Claude installed
# anywhere else (Homebrew, an npm global bin, which is what the `command -v`
# above expects) leaves the worker able to run Claude and Buddy not, failing
# with "Buddy was interrupted." and a Retry that fails identically.
CLAUDE_PLIST_ENTRY=""
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_XML_BIN="$(printf '%s' "$CLAUDE_BIN" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g')"
  printf -v CLAUDE_PLIST_ENTRY \
    '    <key>COVE_CLAUDE_BIN</key>\n    <string>%s</string>' \
    "$CLAUDE_XML_BIN"
fi

# Build Cove's tiny local notification sender. macOS chooses a notification's
# icon from the sender app, so a real app bundle is the only reliable branded
# path across supported macOS releases. AppleScript remains the runtime fallback
# if the installed helper is ever moved or damaged.
NOTIFICATION_ICON_PATH="$REPO_DIR/public/cove-notification-icon.png"
if [ ! -f "$NOTIFICATION_ICON_PATH" ]; then
  echo "Cove's notification icon is missing at $NOTIFICATION_ICON_PATH." >&2
  exit 1
fi
SWIFTC="$(xcrun --find swiftc 2>/dev/null || true)"
if [ -z "$SWIFTC" ] || [ ! -x "$SWIFTC" ]; then
  echo "Cove's branded notification helper requires the Xcode command line tools. Run xcode-select --install, then re-run this script." >&2
  exit 1
fi
MACOS_SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
if [ -z "$MACOS_SDK" ] || [ ! -d "$MACOS_SDK" ]; then
  echo "Cove could not find the macOS SDK required to build its notification helper. Run xcode-select --install, then re-run this script." >&2
  exit 1
fi
NOTIFICATION_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cove-notifier.XXXXXX")"
trap 'rm -rf "$NOTIFICATION_BUILD_DIR"' EXIT
NOTIFICATION_ICONSET="$NOTIFICATION_BUILD_DIR/Cove.iconset"
mkdir -p "$NOTIFICATION_ICONSET"
sips -z 16 16 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$NOTIFICATION_ICON_PATH" --out "$NOTIFICATION_ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$NOTIFICATION_ICONSET" -o "$NOTIFICATION_BUILD_DIR/Cove.icns"
case "$(uname -m)" in
  arm64) NOTIFICATION_TARGET="arm64-apple-macosx13.0" ;;
  x86_64) NOTIFICATION_TARGET="x86_64-apple-macosx13.0" ;;
  *) echo "Unsupported Mac architecture for Cove notifications: $(uname -m)" >&2; exit 1 ;;
esac
"$SWIFTC" -parse-as-library -O -target "$NOTIFICATION_TARGET" -sdk "$MACOS_SDK" \
  -framework AppKit -framework UserNotifications \
  "$REPO_DIR/scripts/cove-notifier.swift" \
  -o "$NOTIFICATION_BUILD_DIR/CoveNotifier"
NOTIFICATION_APP="$HOME/Applications/Cove Notifications.app"
NOTIFICATION_APP_EXECUTABLE="$NOTIFICATION_APP/Contents/MacOS/CoveNotifier"
mkdir -p "$NOTIFICATION_APP/Contents/MacOS" "$NOTIFICATION_APP/Contents/Resources"
install -m 755 "$NOTIFICATION_BUILD_DIR/CoveNotifier" "$NOTIFICATION_APP_EXECUTABLE"
install -m 644 "$REPO_DIR/scripts/launchd/CoveNotifications-Info.plist" \
  "$NOTIFICATION_APP/Contents/Info.plist"
install -m 644 "$NOTIFICATION_BUILD_DIR/Cove.icns" \
  "$NOTIFICATION_APP/Contents/Resources/Cove.icns"
/usr/bin/codesign --force --deep --sign - "$NOTIFICATION_APP" >/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$NOTIFICATION_APP"
/usr/bin/codesign --verify --deep --strict "$NOTIFICATION_APP"
NOTIFICATION_APP_XML="$(printf '%s' "$NOTIFICATION_APP_EXECUTABLE" | sed \
  -e 's/&/\&amp;/g' \
  -e 's/</\&lt;/g' \
  -e 's/>/\&gt;/g')"
printf -v NOTIFICATION_PLIST_ENTRY \
  '    <key>COVE_NOTIFICATION_APP</key>\n    <string>%s</string>' \
  "$NOTIFICATION_APP_XML"

# Persist the explicitly installed DB/server pairing for direct CLI use too.
"$NODE_REAL" "$INSTALL_RUNTIME" "$REPO_DIR" --save
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
printf -v RUNTIME_PLIST_ENTRY '    <key>COVE_DATA_DIR</key>\n    <string>%s</string>\n    <key>COVE_DB_PATH</key>\n    <string>%s</string>\n    <key>COVE_BRIEF_WEB_BASE</key>\n    <string>%s</string>' \
  "$(xml_escape "$COVE_DATA_DIR")" "$(xml_escape "$COVE_DB_PATH")" "$(xml_escape "$COVE_BRIEF_WEB_BASE")"

mkdir -p "$LOG_DIR" "$LA_DIR"

# `launchctl disable` survives a restart and outlives the plist, so a label
# disabled once stays refused until something enables it again. Three of the
# labels below used to be bootstrapped without ever being enabled, so anyone
# who stopped Cove for good and later re-ran this installer got the website
# and the worker back while the daily backup, the reminders lane and email
# triage stayed off, with nothing on screen saying so. Enabling is also done
# before bootstrapping rather than after, because launchd refuses to load a
# disabled service and the enable that followed came too late to help it.
#
# Enabling only clears a previous refusal; it loads nothing by itself, so a
# label whose plist this install did not write stays absent either way. That
# is why the list is every label this script can load rather than the ones the
# current options happen to select. The retired lanes it only ever removes --
# com.cove.attention-sweep and com.cove.wake-canary -- are deliberately not
# here; com.cove.morning-brief is, because --mini loads it.
for cove_label in \
  com.cove.local \
  com.cove.local.backup \
  com.cove.jobs \
  com.cove.reminders \
  com.cove.claude-worker \
  com.cove.email-triage \
  com.cove.meeting-watch \
  com.cove.meeting-drain \
  com.cove.progress \
  com.cove.voice-review \
  com.cove.morning-brief \
  com.cove.chief-of-staff-drain \
  com.cove.chief-of-staff-sweep \
  com.cove.chief-of-staff-nightly \
  com.cove.chief-of-staff-review
do
  launchctl enable "gui/$UID_NUM/$cove_label" 2>/dev/null || true
done

LANE_DATA_DIR="${COVE_DATA_DIR:-$REPO_DIR/data}"
mkdir -p "$LANE_DATA_DIR"
ATTENTION_CONFIG="$LANE_DATA_DIR/attention-sweep.json"
if [ ! -e "$ATTENTION_CONFIG" ]; then
  install -m 600 /dev/null "$ATTENTION_CONFIG"
  printf '%s\n' '{"shadow":true,"email_shadow":true}' > "$ATTENTION_CONFIG"
  echo "Created private shadow-mode attention settings at $ATTENTION_CONFIG"
fi
LANE_OWNERSHIP_SCRIPT="$REPO_DIR/scripts/lib/cove-lane-ownership.mjs"
LANE_PLIST_RENDERER="$REPO_DIR/scripts/lib/render-lane-plist.mjs"
claim_lane() {
  "$NODE_REAL" "$LANE_OWNERSHIP_SCRIPT" claim \
    "$LANE_DATA_DIR" "$1" "$2" "$HOME"
}
mark_lane_installed() {
  "$NODE_REAL" "$LANE_OWNERSHIP_SCRIPT" mark-installed \
    "$LANE_DATA_DIR" "$1" "$HOME" >/dev/null
}

# --- Optional Mini profile: scheduled brief plus the same standard lanes ----
# The Mini already runs its own web + worker via com.atlas.cove-web. This
# profile adds the scheduled brief and installs the same meeting/progress lanes.
# Logs go to ~/Library/Logs (TCC blocks launchd writes under ~/Desktop).
if [ "$MINI" = "1" ]; then
  # SAFETY GATE: the Mini agent is a second live SQLite writer on a tree that
  # Syncthing used to sync wholesale. Bootstrapping it before cove.db is
  # excluded from sync ON BOTH machines is a documented corruption vector, so
  # this refuses to proceed until the operator confirms. Confirm with
  # COVE_MINI_CONFIRM_STIGNORE=1 or interactively below.
  cat <<'STIGNORE_BLOCK'
================================================================================
Before this installs anything, the .stignore at the root of the synced
workspace folder (the folder Syncthing shares) must contain the block below
ON BOTH MACHINES (.stignore itself does NOT sync — edit it on each machine),
and the Cove web + worker processes on both machines must have been STOPPED
when the block was applied:

// --- Cove machine-private runtime state (brief-relay change) ---
// Each machine keeps its OWN cove.db now; a live SQLite file must never sync
// (torn-write corruption). -wal/-shm are already covered by the global rules
// above. The relay dirs (brief-relay/, settlement-relay/, progress-relay/) and
// source-checkpoint.json are the transport and MUST keep syncing — not listed.
projects/astack/cove/data/cove.db
projects/astack/cove/data/claude-runs
projects/astack/cove/data/claude-runs/**
projects/astack/cove/data/claude-worker.heartbeat
projects/astack/cove/data/backups
projects/astack/cove/data/backups/**
================================================================================
STIGNORE_BLOCK
  if [ "${COVE_MINI_CONFIRM_STIGNORE:-0}" != "1" ]; then
    if [ -t 0 ]; then
      printf 'Confirm the block above is applied on BOTH machines and writers were stopped when it was applied. Proceed? [y/N] '
      read -r STIGNORE_REPLY
      case "$STIGNORE_REPLY" in
        y|Y|yes|YES) ;;
        *)
          echo "Aborted: apply the .stignore block on both machines first, then re-run." >&2
          exit 1
          ;;
      esac
    else
      echo "Refusing to bootstrap the Mini brief agent: confirm the .stignore block is applied on BOTH machines (writers stopped), then re-run with COVE_MINI_CONFIRM_STIGNORE=1." >&2
      exit 1
    fi
  fi
  # Support both direct Atlas/Projects/Cove installs and older nested layouts.
  ATLAS_ROOT="$(resolve_atlas_root)"
  MINI_BRIEF_PLIST="$LA_DIR/com.cove.morning-brief.plist"
  MINI_MEETING_PLIST="$LA_DIR/com.cove.meeting-watch.plist"
  MINI_MEETING_DRAIN_PLIST="$LA_DIR/com.cove.meeting-drain.plist"
  MINI_PROGRESS_PLIST="$LA_DIR/com.cove.progress.plist"
  claim_lane meeting_watch mini >/dev/null
  claim_lane progress mini >/dev/null
  cat > "$MINI_BRIEF_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.morning-brief</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TSX_BIN</string>
    <string>$REPO_DIR/scripts/cove-claude-worker.ts</string>
    <string>--lane</string>
    <string>brief</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove-morning-brief.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove-morning-brief.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$RUNTIME_PLIST_ENTRY
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_CLAUDE_WORKER_ENABLED</key>
    <string>1</string>
    <key>COVE_CLAUDE_BIN</key>
    <string>$CLAUDE_BIN</string>
    <key>COVE_BRIEF_TIMEZONE</key>
    <string>America/Los_Angeles</string>
    <key>COVE_BRIEF_REQUIRE_SOURCE_CHECKPOINT</key>
    <string>1</string>
    <key>COVE_JOB_RUNNER</key>
    <string>$JOB_RUNNER</string>
$CODEX_PLIST_ENTRY
$NOTIFICATION_PLIST_ENTRY
    <key>COVE_BRIEF_GOALS_PATH</key>
    <string>$ATLAS_ROOT/brain/GOALS.md</string>
    <key>COVE_BRIEF_OPERATOR_PROFILE_PATH</key>
    <string>$ATLAS_ROOT/brain/operator-profile.md</string>
    <key>COVE_BRIEF_LEADUP_PATH</key>
    <string>$ATLAS_ROOT/brain/brief-leadup.md</string>
    <key>COVE_BRIEF_SPRINT_MEMO_PATH</key>
    <string>$ATLAS_ROOT/brain/path-to-30k-2026-07.md</string>
$SUPERNOVA_PLIST_ENTRY
    <key>COVE_CONTENT_QUOTA_POSTS</key>
    <string>2</string>
  </dict>
</dict>
</plist>
EOF
  "$NODE_REAL" "$LANE_PLIST_RENDERER" \
    "$REPO_DIR/scripts/launchd/com.cove.meeting-watch.plist" \
    "$MINI_MEETING_PLIST" \
    "$REPO_DIR" \
    "$HOME" \
    "$ATLAS_ROOT" \
    "$LANE_DATA_DIR" \
    "$NODE_REAL" \
    "$JOB_RUNNER" \
    "$CODEX_BIN" \
    "$NOTIFICATION_APP_EXECUTABLE" \
    "$COVE_BRIEF_WEB_BASE" \
    "$COVE_DB_PATH"
  "$NODE_REAL" "$LANE_PLIST_RENDERER" \
    "$REPO_DIR/scripts/launchd/com.cove.meeting-drain.plist" \
    "$MINI_MEETING_DRAIN_PLIST" \
    "$REPO_DIR" \
    "$HOME" \
    "$ATLAS_ROOT" \
    "$LANE_DATA_DIR" \
    "$NODE_REAL" \
    "$JOB_RUNNER" \
    "$CODEX_BIN" \
    "$NOTIFICATION_APP_EXECUTABLE" \
    "$COVE_BRIEF_WEB_BASE" \
    "$COVE_DB_PATH"
  "$NODE_REAL" "$LANE_PLIST_RENDERER" \
    "$REPO_DIR/scripts/launchd/com.cove.progress.plist" \
    "$MINI_PROGRESS_PLIST" \
    "$REPO_DIR" \
    "$HOME" \
    "$ATLAS_ROOT" \
    "$LANE_DATA_DIR" \
    "$NODE_REAL" \
    "$JOB_RUNNER" \
    "$CODEX_BIN" \
    "$NOTIFICATION_APP_EXECUTABLE" \
    "$COVE_BRIEF_WEB_BASE" \
    "$COVE_DB_PATH"
  retire_legacy_agent morning-brief
  retire_legacy_agent meeting-watch
  retire_legacy_agent meeting-drain
  retire_legacy_agent progress
  launchctl bootout "gui/$UID_NUM/com.cove.morning-brief" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.meeting-watch" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.meeting-drain" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.progress" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$MINI_BRIEF_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$MINI_MEETING_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$MINI_MEETING_DRAIN_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$MINI_PROGRESS_PLIST"
  mark_lane_installed meeting_watch
  mark_lane_installed progress_reconcile
  echo "Installed the Mini morning-brief agent (7:30 local): $MINI_BRIEF_PLIST"
  echo "Installed the Mini meeting watcher (weekdays every 15 minutes, 08:00-18:00 local, plus login catch-up): $MINI_MEETING_PLIST"
  echo "Installed the Mini meeting analysis drain (every 15 minutes, always on): $MINI_MEETING_DRAIN_PLIST"
  echo "Installed the Mini progress reconciler (every 30 minutes): $MINI_PROGRESS_PLIST"
  echo "Brief goals: $ATLAS_ROOT/brain/GOALS.md"
  echo "Logs: $LOG_DIR/cove-morning-brief.log"
fi

# --- Install the Cove SessionStart hook without replacing Claude settings ---
HOOK_SRC="$REPO_DIR/scripts/hooks/cove-orchestrator.sh"
HOOK_DIR="$HOME/.claude/hooks"
HOOK_DEST="$HOOK_DIR/cove-orchestrator.sh"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOOK_DIR" "$(dirname "$CLAUDE_SETTINGS")"
cp "$HOOK_SRC" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
rm -f "$HOOK_DIR/forge-orchestrator.sh"
"$NODE_REAL" - "$CLAUDE_SETTINGS" "$HOOK_DEST" <<'NODE'
const fs = require('node:fs');
const [settingsPath, hookPath] = process.argv.slice(2);
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    console.error('~/.claude/settings.json is not valid JSON; fix it and re-run');
    process.exit(1);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Claude settings must contain a JSON object.');
  }
}
settings.hooks ??= {};
if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
  throw new Error('Claude settings hooks must contain a JSON object.');
}
settings.hooks.SessionStart ??= [];
if (!Array.isArray(settings.hooks.SessionStart)) {
  throw new Error('Claude SessionStart hooks must contain an array.');
}
// Drop any hook left over from when this script was called forge-orchestrator.sh;
// that file no longer exists, so an old entry would just fail on every session.
let changed = false;
for (const entry of settings.hooks.SessionStart) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
  const kept = entry.hooks.filter((hook) =>
    !(hook && typeof hook === 'object' && typeof hook.command === 'string' &&
      hook.command.endsWith('/forge-orchestrator.sh')));
  if (kept.length !== entry.hooks.length) {
    entry.hooks = kept;
    changed = true;
  }
}
settings.hooks.SessionStart = settings.hooks.SessionStart.filter((entry) =>
  !(entry && typeof entry === 'object' && Array.isArray(entry.hooks) && entry.hooks.length === 0));

const installed = settings.hooks.SessionStart.some((entry) =>
  entry && typeof entry === 'object' && entry.matcher === 'resume' &&
  Array.isArray(entry.hooks) && entry.hooks.some((hook) =>
    hook && typeof hook === 'object' && typeof hook.command === 'string' &&
    (hook.command === hookPath || hook.command.endsWith('/cove-orchestrator.sh')))
);
if (!installed) {
  settings.hooks.SessionStart.push({
    matcher: 'resume',
    hooks: [{ type: 'command', command: hookPath }],
  });
  changed = true;
}
if (changed) {
  const temporaryPath = `${settingsPath}.cove-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, settingsPath);
}
NODE
echo "Installed the Cove orchestrator hook into $HOOK_DEST"

if [ "$MINI" = "1" ]; then
  exit 0
fi

# --- Single-Mac background lanes: meeting, progress, and weekly voice review ---
# The meeting calendar keeps weekday working hours while RunAtLoad provides
# login catch-up. The same templates also serve the optional Mini profile above,
# so Mini and normal installs retain identical watcher behavior.
ATLAS_ROOT="$(resolve_atlas_root)"
MEETING_PLIST="$LA_DIR/com.cove.meeting-watch.plist"
MEETING_DRAIN_PLIST="$LA_DIR/com.cove.meeting-drain.plist"
PROGRESS_PLIST="$LA_DIR/com.cove.progress.plist"
VOICE_REVIEW_PLIST="$LA_DIR/com.cove.voice-review.plist"
CHIEF_OF_STAFF_DRAIN_PLIST="$LA_DIR/com.cove.chief-of-staff-drain.plist"
CHIEF_OF_STAFF_SWEEP_PLIST="$LA_DIR/com.cove.chief-of-staff-sweep.plist"
CHIEF_OF_STAFF_NIGHTLY_PLIST="$LA_DIR/com.cove.chief-of-staff-nightly.plist"
CHIEF_OF_STAFF_REVIEW_PLIST="$LA_DIR/com.cove.chief-of-staff-review.plist"
INSTALL_MEETING_LANE=0
INSTALL_PROGRESS_LANE=0
INSTALL_VOICE_REVIEW_LANE=0
INSTALL_CHIEF_OF_STAFF_LANE=0
MEETING_CLAIM="$(claim_lane meeting_watch plain)"
case "$MEETING_CLAIM" in
  claimed:*) INSTALL_MEETING_LANE=1 ;;
  skipped:*)
    MEETING_OWNER="${MEETING_CLAIM#skipped:}"
    echo "Skipping meeting watcher: $MEETING_OWNER owns this lane."
    rm -f "$MEETING_PLIST" "$MEETING_DRAIN_PLIST"
    ;;
esac
PROGRESS_CLAIM="$(claim_lane progress plain)"
case "$PROGRESS_CLAIM" in
  claimed:*) INSTALL_PROGRESS_LANE=1 ;;
  skipped:*)
    PROGRESS_OWNER="${PROGRESS_CLAIM#skipped:}"
    echo "Skipping progress reconciler: $PROGRESS_OWNER owns this lane."
    rm -f "$PROGRESS_PLIST"
    ;;
esac
VOICE_REVIEW_CLAIM="$(claim_lane voice_review plain)"
case "$VOICE_REVIEW_CLAIM" in
  claimed:*) INSTALL_VOICE_REVIEW_LANE=1 ;;
  skipped:*)
    VOICE_REVIEW_OWNER="${VOICE_REVIEW_CLAIM#skipped:}"
    echo "Skipping weekly voice review: $VOICE_REVIEW_OWNER owns this lane."
    rm -f "$VOICE_REVIEW_PLIST"
    ;;
esac
if [ "$CHIEF_OF_STAFF_OPT_IN" = "1" ] &&
   [ -s "$LANE_DATA_DIR/cove-mandate.md" ]; then
  CHIEF_OF_STAFF_CLAIM="$(claim_lane chief_of_staff plain)"
  case "$CHIEF_OF_STAFF_CLAIM" in
    claimed:*) INSTALL_CHIEF_OF_STAFF_LANE=1 ;;
    skipped:*)
      CHIEF_OF_STAFF_OWNER="${CHIEF_OF_STAFF_CLAIM#skipped:}"
      echo "Skipping chief-of-staff lanes: $CHIEF_OF_STAFF_OWNER owns this lane."
      ;;
  esac
else
  echo "Chief of staff: off (set COVE_CHIEF_OF_STAFF=1, verify the selected agent, and add data/cove-mandate.md to enable)"
fi
if [ "$INSTALL_CHIEF_OF_STAFF_LANE" != "1" ]; then
  launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-drain" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-sweep" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-nightly" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-review" 2>/dev/null || true
  rm -f "$CHIEF_OF_STAFF_DRAIN_PLIST" "$CHIEF_OF_STAFF_SWEEP_PLIST" "$CHIEF_OF_STAFF_NIGHTLY_PLIST" "$CHIEF_OF_STAFF_REVIEW_PLIST"
fi
render_lane_plist() {
  "$NODE_REAL" "$LANE_PLIST_RENDERER" \
    "$1" "$2" "$REPO_DIR" "$HOME" "$ATLAS_ROOT" "$LANE_DATA_DIR" "$NODE_REAL" \
    "$JOB_RUNNER" "$CODEX_BIN" "$NOTIFICATION_APP_EXECUTABLE" "$COVE_BRIEF_WEB_BASE" "$COVE_DB_PATH"
}
if [ "$INSTALL_MEETING_LANE" = "1" ]; then
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.meeting-watch.plist" \
    "$MEETING_PLIST"
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.meeting-drain.plist" \
    "$MEETING_DRAIN_PLIST"
fi
if [ "$INSTALL_PROGRESS_LANE" = "1" ]; then
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.progress.plist" \
    "$PROGRESS_PLIST"
fi
if [ "$INSTALL_VOICE_REVIEW_LANE" = "1" ]; then
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.voice-review.plist" \
    "$VOICE_REVIEW_PLIST"
fi
if [ "$INSTALL_CHIEF_OF_STAFF_LANE" = "1" ]; then
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.chief-of-staff-drain.plist" \
    "$CHIEF_OF_STAFF_DRAIN_PLIST"
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.chief-of-staff-sweep.plist" \
    "$CHIEF_OF_STAFF_SWEEP_PLIST"
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.chief-of-staff-nightly.plist" \
    "$CHIEF_OF_STAFF_NIGHTLY_PLIST"
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.chief-of-staff-review.plist" \
    "$CHIEF_OF_STAFF_REVIEW_PLIST"
fi

# --- Install Cove's skills for Claude and Codex ---
# The cove-* skills are refreshed every run in both supported agent homes. The
# bundled humanizer skill is installed only when absent, so unrelated personal
# skills and newer humanizer copies are never overwritten. Skills installed
# under the old forge-* names are deleted so the agent never sees two copies.
SKILLS_SRC="$REPO_DIR/skills"
if [ -d "$SKILLS_SRC" ]; then
  for agent_skills in "$HOME/.claude/skills" "${CODEX_HOME:-$HOME/.codex}/skills"; do
    mkdir -p "$agent_skills"
    for legacy in contact email suggest task voice voice-note; do
      rm -rf "$agent_skills/forge-$legacy"
    done
    for skill_dir in "$SKILLS_SRC"/cove-*; do
      [ -d "$skill_dir" ] || continue
      rm -rf "$agent_skills/$(basename "$skill_dir")"
      cp -R "$skill_dir" "$agent_skills/"
    done
    if [ -d "$SKILLS_SRC/humanizer" ] && [ ! -d "$agent_skills/humanizer" ]; then
      cp -R "$SKILLS_SRC/humanizer" "$agent_skills/"
    fi
    # The skills name the URL the agent curls, and the repository copy names the
    # default port. This install may have taken another one, in which case every
    # curl in every skill would be refused and the agent would report Cove as
    # down. Only the cove-* copies are touched; the humanizer and the person's
    # own skills are left exactly as they are.
    "$NODE_REAL" "$REPO_DIR/scripts/lib/retarget-skill-base.mjs" "$agent_skills" "$COVE_BRIEF_WEB_BASE"
    echo "Installed the Cove skills into $agent_skills"
  done
fi

SERVER_PLIST="$LA_DIR/com.cove.local.plist"
BACKUP_PLIST="$LA_DIR/com.cove.local.backup.plist"
JOBS_PLIST="$LA_DIR/com.cove.jobs.plist"
REMINDERS_PLIST="$LA_DIR/com.cove.reminders.plist"
TRIAGE_PLIST="$LA_DIR/com.cove.email-triage.plist"
WORKER_PLIST="$LA_DIR/com.cove.claude-worker.plist"

# --- Server: next start on the selected loopback endpoint ---
cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.local</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NEXT_BIN</string>
    <string>start</string>
    <string>-H</string>
    <string>$WEB_HOST</string>
    <string>-p</string>
    <string>$WEB_PORT</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$RUNTIME_PLIST_ENTRY
    <key>PATH</key>
    <string>$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <!-- Next.js phones home anonymously on every start unless this is set.
         Cove is local-first and names what leaves the machine; this was not
         on that list, so it does not leave. -->
    <key>NEXT_TELEMETRY_DISABLED</key>
    <string>1</string>
    <key>COVE_DAY_PLAN_ACCESS_MODE</key>
    <string>loopback</string>
    <key>COVE_BUDDY_DEEPLINKS</key>
    <string>$BUDDY_DEEPLINKS</string>
    <key>COVE_BUDDY_APP_URL</key>
    <string>$BUDDY_APP_URL</string>
    <key>COVE_CLAUDE_WORKER_AVAILABLE</key>
    <string>1</string>
    <key>COVE_NOTIFY</key>
    <string>1</string>
    <key>COVE_JOB_RUNNER</key>
    <string>$JOB_RUNNER</string>
$CODEX_PLIST_ENTRY
$CLAUDE_PLIST_ENTRY
    <key>COVE_PROGRESS_RELAY_CONSUMER</key>
    <string>1</string>
$NOTIFICATION_PLIST_ENTRY
$SUPERNOVA_PLIST_ENTRY
    <key>COVE_CONTENT_QUOTA_POSTS</key>
    <string>2</string>
  </dict>
</dict>
</plist>
EOF

# --- Claude worker: supervised durable queue consumer ---
cat > "$WORKER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.claude-worker</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TSX_BIN</string>
    <string>$REPO_DIR/scripts/cove-claude-worker.ts</string>
    <string>--lane</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove-claude-worker.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove-claude-worker.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$RUNTIME_PLIST_ENTRY
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_CLAUDE_WORKER_ENABLED</key>
    <string>1</string>
    <key>COVE_NOTIFY</key>
    <string>1</string>
$NOTIFICATION_PLIST_ENTRY
    <key>COVE_CLAUDE_BIN</key>
    <string>$CLAUDE_BIN</string>
    <key>COVE_BUDDY_DEEPLINKS</key>
    <string>$BUDDY_DEEPLINKS</string>
    <key>COVE_JOB_RUNNER</key>
    <string>$JOB_RUNNER</string>
$CODEX_PLIST_ENTRY
$SUPERNOVA_PLIST_ENTRY
    <key>COVE_CONTENT_QUOTA_POSTS</key>
    <string>2</string>
  </dict>
</dict>
</plist>
EOF

# --- Morning Brief on this Mac ---
# There is intentionally no 7:30 one-shot agent in the standard laptop profile.
# The arrival's on-demand backfill and the post-settlement trigger both feed the
# supervised watch worker. Any previously installed com.cove.morning-brief agent
# is booted out below.

# --- Daily database backup at 3:30am ---
cat > "$BACKUP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.local.backup</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_DIR/scripts/cove-backup.sh</string>
    <string>--daily</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove-backup.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove-backup.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$RUNTIME_PLIST_ENTRY
    <key>COVE_NODE_PATH</key>
    <string>$NODE_REAL</string>
  </dict>
</dict>
</plist>
EOF

# --- Reliability jobs: one bounded scheduler tick every five minutes ---
cat > "$JOBS_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.jobs</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_REAL</string>
    <string>--import</string>
    <string>$REPO_DIR/node_modules/tsx/dist/loader.mjs</string>
    <string>$REPO_DIR/scripts/cove-jobs.ts</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove-jobs.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove-jobs.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$RUNTIME_PLIST_ENTRY
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_NOTIFY</key>
    <string>1</string>
    <key>COVE_JOB_RUNNER</key>
    <string>$JOB_RUNNER</string>
$CODEX_PLIST_ENTRY
$NOTIFICATION_PLIST_ENTRY
  </dict>
</dict>
</plist>
EOF

# --- Reminders: check for due tasks every minute and fire notifications ---
cat > "$REMINDERS_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.reminders</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_REAL</string>
    <string>--import</string>
    <string>$REPO_DIR/node_modules/tsx/dist/loader.mjs</string>
    <string>$REPO_DIR/scripts/cove-reminders.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove-reminders.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove-reminders.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$RUNTIME_PLIST_ENTRY
    <key>PATH</key>
    <string>$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
$NOTIFICATION_PLIST_ENTRY
  </dict>
</dict>
</plist>
EOF

# --- Email triage: run the deterministic runner at the user's chosen times ---
# Only scheduled once Google is connected (the Email step writes data/cove-workspace.json
# with triage_times + timezone). launchd fires at LOCAL time on the Mac.
# triage_times may hold any number of "HH:MM" entries; we emit one calendar dict
# per entry. No Weekday keys go in the plist: the runner's weekday guard (driven
# by the config's weekdays_only flag) owns weekend skipping.
EMAIL_CONFIG="$LANE_DATA_DIR/cove-workspace.json"
if [ -f "$EMAIL_CONFIG" ]; then
  TRIAGE_CAL_XML="$(node -e '
    const fs = require("fs");
    let times = ["09:00", "15:00"];
    try {
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (Array.isArray(c.triage_times) && c.triage_times.length) times = c.triage_times;
    } catch {}
    const blocks = times.map((t) => {
      const [h, m] = String(t).split(":").map((n) => parseInt(n, 10) || 0);
      return `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`;
    }).join("\n");
    process.stdout.write(blocks);
  ' "$EMAIL_CONFIG" 2>/dev/null || true)"
  if [ -z "$TRIAGE_CAL_XML" ]; then
    TRIAGE_CAL_XML='    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict>'
  fi
  cat > "$TRIAGE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.email-triage</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_DIR/scripts/cove-email-triage.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
$TRIAGE_CAL_XML
  </array>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove-email-triage.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove-email-triage.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$RUNTIME_PLIST_ENTRY
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_NOTIFY</key>
    <string>1</string>
    <key>COVE_JOB_RUNNER</key>
    <string>$JOB_RUNNER</string>
$CODEX_PLIST_ENTRY
$NOTIFICATION_PLIST_ENTRY
  </dict>
</dict>
</plist>
EOF
  echo "Scheduled email triage (times from data/cove-workspace.json; default 9:00 and 15:00)."
else
  rm -f "$TRIAGE_PLIST"
fi

# (Re)load all agents with the modern launchctl API (idempotent).
retire_legacy_agent local
retire_legacy_agent local.backup
retire_legacy_agent jobs
retire_legacy_agent reminders
retire_legacy_agent attention-sweep
retire_legacy_agent email-triage
retire_legacy_agent claude-worker
retire_legacy_agent meeting-watch
retire_legacy_agent meeting-drain
retire_legacy_agent progress
retire_legacy_agent voice-review
retire_legacy_agent chief-of-staff-drain
retire_legacy_agent chief-of-staff-sweep
retire_legacy_agent chief-of-staff-nightly
retire_legacy_agent chief-of-staff-review
# com.forge.web is the pre-rename web server on this same port. Leaving it
# loaded means com.cove.local crash-loops on EADDRINUSE while the readiness
# probe below happily answers off the old server, so the install looks fine and
# is not. It has to go before the new agent is bootstrapped.
retire_legacy_agent web
launchctl bootout "gui/$UID_NUM/com.cove.local" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.local.backup" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.jobs" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.reminders" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.attention-sweep" 2>/dev/null || true
rm -f "$LA_DIR/com.cove.attention-sweep.plist"
launchctl bootout "gui/$UID_NUM/com.cove.email-triage" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.claude-worker" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.meeting-watch" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.meeting-drain" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.progress" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.voice-review" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-drain" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-sweep" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-nightly" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.chief-of-staff-review" 2>/dev/null || true
# Remove any older com.cove.morning-brief one-shot agent entirely (bootout +
# plist removal): the supervised claude-worker now runs the scheduled brief.
launchctl bootout "gui/$UID_NUM/com.cove.morning-brief" 2>/dev/null || true
rm -f "$LA_DIR/com.cove.morning-brief.plist"
# The wake canary experiment is retired. Clean up the installed agent without
# recreating or loading it.
launchctl bootout "gui/$UID_NUM/com.cove.wake-canary" 2>/dev/null || true
rm -f "$LA_DIR/com.cove.wake-canary.plist"

# Move machine-private pre-Cove data only after every writer is stopped.
# Never overwrite a canonical file: two copies means the operator must decide
# which one is authoritative instead of the installer guessing.
for suffix in "" "-wal" "-shm"; do
  legacy_db="$REPO_DIR/data/forge.db$suffix"
  cove_db="$REPO_DIR/data/cove.db$suffix"
  if [ -e "$legacy_db" ] && [ -e "$cove_db" ]; then
    echo "Both $legacy_db and $cove_db exist. Refusing to choose between them." >&2
    exit 1
  fi
  if [ -e "$legacy_db" ]; then
    mv "$legacy_db" "$cove_db"
  fi
done
for legacy_config in "$REPO_DIR"/data/forge-*.json; do
  [ -e "$legacy_config" ] || continue
  cove_config="$REPO_DIR/data/cove-${legacy_config##*forge-}"
  if [ -e "$cove_config" ]; then
    echo "Keeping canonical config and leaving legacy file untouched: $legacy_config"
    continue
  fi
  mv "$legacy_config" "$cove_config"
done

launchctl bootstrap "gui/$UID_NUM" "$SERVER_PLIST"
launchctl bootstrap "gui/$UID_NUM" "$BACKUP_PLIST"
launchctl bootstrap "gui/$UID_NUM" "$JOBS_PLIST"
launchctl bootstrap "gui/$UID_NUM" "$REMINDERS_PLIST"
WORKER_START_EPOCH="$(date +%s)"
if ! launchctl bootstrap "gui/$UID_NUM" "$WORKER_PLIST" 2>/dev/null; then
  # A KeepAlive worker can still be exiting for a moment after bootout. Give
  # launchd one bounded grace period, then preserve the normal fail-closed exit.
  echo "Waiting for Cove's worker to finish its previous shutdown..."
  sleep 1
  launchctl bootstrap "gui/$UID_NUM" "$WORKER_PLIST"
fi
if [ "$INSTALL_MEETING_LANE" = "1" ]; then
  launchctl bootstrap "gui/$UID_NUM" "$MEETING_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$MEETING_DRAIN_PLIST"
  mark_lane_installed meeting_watch
fi
if [ "$INSTALL_PROGRESS_LANE" = "1" ]; then
  launchctl bootstrap "gui/$UID_NUM" "$PROGRESS_PLIST"
  mark_lane_installed progress_reconcile
fi
if [ "$INSTALL_VOICE_REVIEW_LANE" = "1" ]; then
  launchctl bootstrap "gui/$UID_NUM" "$VOICE_REVIEW_PLIST"
  mark_lane_installed voice_review
fi
if [ "$INSTALL_CHIEF_OF_STAFF_LANE" = "1" ]; then
  launchctl bootstrap "gui/$UID_NUM" "$CHIEF_OF_STAFF_DRAIN_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$CHIEF_OF_STAFF_SWEEP_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$CHIEF_OF_STAFF_NIGHTLY_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$CHIEF_OF_STAFF_REVIEW_PLIST"
  mark_lane_installed chief_of_staff
fi
if [ -f "$TRIAGE_PLIST" ]; then launchctl bootstrap "gui/$UID_NUM" "$TRIAGE_PLIST"; fi

# Confirm the server actually came up. This catches the most common failure:
# launchd not being able to find/run Node on the client's machine.
echo "Starting Cove..."
UP=""
FOREIGN_SERVER=""
for _ in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$COVE_BRIEF_WEB_BASE/tasks" 2>/dev/null || true)"
  case "$CODE" in
    200|307|308)
      # Something answering is not the same as Cove answering. When another
      # program already holds this port, `next start` exits with EADDRINUSE and
      # KeepAlive restarts it every ten seconds forever, while this probe reads
      # 200 from the other program and the install reports success. /api/health
      # is Cove's own endpoint, needs no CSRF token on a GET, and is refused
      # off loopback, so it is a safe way to ask "is this actually Cove".
      if curl -fsS "$COVE_BRIEF_WEB_BASE/api/health" 2>/dev/null | grep -q '"readiness"'; then
        UP="yes"
        break
      fi
      FOREIGN_SERVER="yes"
      ;;
  esac
  sleep 1
done

if [ -n "$UP" ]; then
  WORKER_UP=""
  for _ in $(seq 1 30); do
    WORKER_HEARTBEAT="$LANE_DATA_DIR/claude-worker.heartbeat"
    WORKER_HEARTBEAT_EPOCH="$(stat -f '%m' "$WORKER_HEARTBEAT" 2>/dev/null || printf '0')"
    if [ "$WORKER_HEARTBEAT_EPOCH" -ge "$WORKER_START_EPOCH" ]; then
      WORKER_UP="yes"
      break
    fi
    sleep 1
  done
  if [ -z "$WORKER_UP" ]; then
    echo "Cove setup is incomplete: the worker has not written a fresh heartbeat." >&2
    echo "See: $LOG_DIR/cove-claude-worker.error.log" >&2
    echo "Retry the worker: launchctl kickstart -k gui/$UID_NUM/com.cove.claude-worker" >&2
    exit 1
  fi
  echo "Creating the first Cove database backup..."
  "$TSX_BIN" "$REPO_DIR/scripts/cove-jobs.ts" enqueue-backup --run
  echo "Cove is running at $COVE_BRIEF_WEB_BASE and will start automatically on login."
  echo "Server logs: $LOG_DIR/cove.log"
  echo "Daily database backups: $COVE_BACKUP_DIR"
  echo "Reliability jobs: bounded scheduler supervised by com.cove.jobs"
  # AGENTS.md makes "the user has been told exactly which background lanes are
  # active" a condition of a finished setup, so this summary has to be true.
  # The four chief-of-staff lanes were installed and then named nowhere in it.
  # The shadow-switches line below stays as it is: data/attention-sweep.json
  # outlived com.cove.attention-sweep, which this script boots out and deletes,
  # and src/lib/attention/delivery.ts and email-urgency.ts still read it.
  if [ "$INSTALL_CHIEF_OF_STAFF_LANE" = "1" ]; then
    echo "Chief of staff: sweeps at 11:30 and 16:00, a nightly pass at 21:30, a weekly review Sundays at 18:00, and a drain every 5 minutes"
  else
    echo "Chief of staff: not installed, so nothing sweeps at 11:30 or 16:00"
  fi
  echo "Attention shadow switches: data/attention-sweep.json (shadow = chief-of-staff notify, email_shadow = urgent email)"
  echo "Claude worker: supervised by com.cove.claude-worker"
  echo "Claude worker status: ok"
  if [ "$INSTALL_MEETING_LANE" = "1" ]; then
    echo "Meeting watcher: weekdays every 15 minutes, 08:00-18:00 local, plus login catch-up"
    echo "Meeting analysis drain: every 15 minutes, always on"
  else
    echo "Meeting watcher: skipped because $MEETING_OWNER owns this lane"
    echo "Meeting analysis drain: skipped because $MEETING_OWNER owns this lane"
  fi
  if [ "$INSTALL_PROGRESS_LANE" = "1" ]; then
    echo "Progress reconciler: every 30 minutes while this Mac is awake, with catch-up on wake"
  else
    echo "Progress reconciler: skipped because $PROGRESS_OWNER owns this lane"
  fi
  if [ "$INSTALL_VOICE_REVIEW_LANE" = "1" ]; then
    echo "Weekly voice review: Sundays at 18:00 local"
  else
    echo "Weekly voice review: skipped because $VOICE_REVIEW_OWNER owns this lane"
  fi
  echo "Morning Brief: 08:00 weekdays in the brief timezone, after the prior day closes; missed runs catch up while this Mac is awake"
  echo "Day-plan batch execution remains off until COVE_CLAUDE_EXECUTION_ENABLED=1 and an allowlisted workspace config are explicitly added."
  echo "Task controls use your selected agent: Auto works the task; Planning prepares a plan. Codex retains on-request approvals. Sending, publishing, or purchasing still requires your approval."
elif [ -n "$FOREIGN_SERVER" ]; then
  echo "Something other than Cove is already using port $WEB_PORT on this Mac." >&2
  echo "Cove could not take that port, so Cove is not running." >&2
  echo "See which program has it: lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN" >&2
  echo "Then quit that program and re-run: bash scripts/install-cove-local.sh" >&2
  echo "Or give Cove a different port by putting a line like" >&2
  echo "COVE_BRIEF_WEB_BASE=http://127.0.0.1:3201 in $REPO_DIR/.env.local and re-running." >&2
  exit 1
else
  echo "Cove did not respond on $COVE_BRIEF_WEB_BASE within 20 seconds." >&2
  echo "See the log for why: $LOG_DIR/cove.error.log" >&2
  if grep -q 'EADDRINUSE' "$LOG_DIR/cove.error.log" 2>/dev/null; then
    echo "That log says port $WEB_PORT is already in use by another program." >&2
    echo "See which one: lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN" >&2
    echo "Then quit it, or set COVE_BRIEF_WEB_BASE to a free loopback port in" >&2
    echo "$REPO_DIR/.env.local, and re-run: bash scripts/install-cove-local.sh" >&2
  else
    echo "Most common cause: Node is installed via nvm/fnm/Volta and launchd can't use it." >&2
    echo "Fix: install Node with Homebrew (brew install node), then re-run: bash scripts/install-cove-local.sh" >&2
  fi
  exit 1
fi
