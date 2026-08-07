#!/usr/bin/env bash
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
BUDDY_APP_URL="${COVE_BUDDY_APP_URL:-http://127.0.0.1:3200}"
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
CLAUDE_BIN="${COVE_CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
if [ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude"
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "Claude Code is required for Cove execution. Install it or set COVE_CLAUDE_BIN." >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$LA_DIR"
if [ ! -e "$REPO_DIR/.env.local" ]; then
  install -m 600 /dev/null "$REPO_DIR/.env.local"
  echo "Created a private empty .env.local. Add optional Cove settings there when needed."
fi
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
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_CLAUDE_WORKER_ENABLED</key>
    <string>1</string>
    <key>COVE_CLAUDE_BIN</key>
    <string>$CLAUDE_BIN</string>
    <key>COVE_BRIEF_WEB_BASE</key>
    <string>http://127.0.0.1:3200</string>
    <key>COVE_BRIEF_TIMEZONE</key>
    <string>America/Los_Angeles</string>
    <key>COVE_BRIEF_REQUIRE_SOURCE_CHECKPOINT</key>
    <string>1</string>
    <key>COVE_BRIEF_WRITER</key>
    <string>codex</string>
    <key>COVE_CODEX_BIN</key>
    <string>/opt/homebrew/bin/codex</string>
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
    "$NODE_REAL"
  "$NODE_REAL" "$LANE_PLIST_RENDERER" \
    "$REPO_DIR/scripts/launchd/com.cove.progress.plist" \
    "$MINI_PROGRESS_PLIST" \
    "$REPO_DIR" \
    "$HOME" \
    "$ATLAS_ROOT" \
    "$LANE_DATA_DIR" \
    "$NODE_REAL"
  retire_legacy_agent morning-brief
  retire_legacy_agent meeting-watch
  retire_legacy_agent progress
  launchctl bootout "gui/$UID_NUM/com.cove.morning-brief" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.meeting-watch" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM/com.cove.progress" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$MINI_BRIEF_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$MINI_MEETING_PLIST"
  launchctl bootstrap "gui/$UID_NUM" "$MINI_PROGRESS_PLIST"
  mark_lane_installed meeting_watch
  mark_lane_installed progress_reconcile
  echo "Installed the Mini morning-brief agent (7:30 local): $MINI_BRIEF_PLIST"
  echo "Installed the Mini meeting watcher (every 5 minutes): $MINI_MEETING_PLIST"
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

# --- Single-Mac background lanes: meeting watch + progress reconciliation ---
# StartInterval jobs catch up when the Mac wakes. The same templates also serve
# the optional Mini profile above; neither feature depends on owning a Mini.
ATLAS_ROOT="$(resolve_atlas_root)"
MEETING_PLIST="$LA_DIR/com.cove.meeting-watch.plist"
PROGRESS_PLIST="$LA_DIR/com.cove.progress.plist"
INSTALL_MEETING_LANE=0
INSTALL_PROGRESS_LANE=0
MEETING_CLAIM="$(claim_lane meeting_watch plain)"
case "$MEETING_CLAIM" in
  claimed:*) INSTALL_MEETING_LANE=1 ;;
  skipped:*)
    MEETING_OWNER="${MEETING_CLAIM#skipped:}"
    echo "Skipping meeting watcher: $MEETING_OWNER owns this lane."
    rm -f "$MEETING_PLIST"
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
render_lane_plist() {
  "$NODE_REAL" "$LANE_PLIST_RENDERER" \
    "$1" "$2" "$REPO_DIR" "$HOME" "$ATLAS_ROOT" "$LANE_DATA_DIR" "$NODE_REAL"
}
if [ "$INSTALL_MEETING_LANE" = "1" ]; then
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.meeting-watch.plist" \
    "$MEETING_PLIST"
fi
if [ "$INSTALL_PROGRESS_LANE" = "1" ]; then
  render_lane_plist \
    "$REPO_DIR/scripts/launchd/com.cove.progress.plist" \
    "$PROGRESS_PLIST"
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
    echo "Installed the Cove skills into $agent_skills"
  done
fi

SERVER_PLIST="$LA_DIR/com.cove.local.plist"
BACKUP_PLIST="$LA_DIR/com.cove.local.backup.plist"
JOBS_PLIST="$LA_DIR/com.cove.jobs.plist"
REMINDERS_PLIST="$LA_DIR/com.cove.reminders.plist"
ATTENTION_SWEEP_PLIST="$LA_DIR/com.cove.attention-sweep.plist"
TRIAGE_PLIST="$LA_DIR/com.cove.email-triage.plist"
WORKER_PLIST="$LA_DIR/com.cove.claude-worker.plist"

# --- Server: next start on localhost:3200 ---
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
    <string>127.0.0.1</string>
    <string>-p</string>
    <string>3200</string>
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
    <key>PATH</key>
    <string>$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>COVE_DAY_PLAN_ACCESS_MODE</key>
    <string>loopback</string>
    <key>COVE_BUDDY_DEEPLINKS</key>
    <string>$BUDDY_DEEPLINKS</string>
    <key>COVE_BUDDY_APP_URL</key>
    <string>$BUDDY_APP_URL</string>
    <key>COVE_CLAUDE_WORKER_AVAILABLE</key>
    <string>1</string>
    <key>COVE_PROGRESS_RELAY_CONSUMER</key>
    <string>1</string>
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
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_CLAUDE_WORKER_ENABLED</key>
    <string>1</string>
    <key>COVE_NOTIFY</key>
    <string>1</string>
    <key>COVE_CLAUDE_BIN</key>
    <string>$CLAUDE_BIN</string>
    <key>COVE_BUDDY_DEEPLINKS</key>
    <string>$BUDDY_DEEPLINKS</string>
    <key>COVE_BRIEF_WEB_BASE</key>
    <string>http://127.0.0.1:3200</string>
$SUPERNOVA_PLIST_ENTRY
    <key>COVE_CONTENT_QUOTA_POSTS</key>
    <string>2</string>
  </dict>
</dict>
</plist>
EOF

# --- Morning Brief on the MBP ---
# There is intentionally no 7:30 one-shot agent here anymore: the always-on Mac
# Mini owns scheduled generation (install it there with `--mini`) and relays the
# artifact over Syncthing. The MBP still covers itself two ways with no agent:
# the arrival's on-demand backfill (the watch worker drains the brief lane) and
# the post-settlement evening trigger. Any previously installed com.cove.morning-brief
# agent is booted out below.

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
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_NOTIFY</key>
    <string>1</string>
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
    <key>PATH</key>
    <string>$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

# --- Judgment sweep: shadow-tested attention ranking at 11:30 and 16:00 ---
cat > "$ATTENTION_SWEEP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cove.attention-sweep</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_REAL</string>
    <string>--import</string>
    <string>$REPO_DIR/node_modules/tsx/dist/loader.mjs</string>
    <string>$REPO_DIR/scripts/cove-attention-sweep.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/cove-attention-sweep.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/cove-attention-sweep.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
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
EMAIL_CONFIG="$REPO_DIR/data/cove-workspace.json"
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
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>COVE_NOTIFY</key>
    <string>1</string>
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
retire_legacy_agent progress
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
launchctl bootout "gui/$UID_NUM/com.cove.email-triage" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.claude-worker" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.meeting-watch" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.cove.progress" 2>/dev/null || true
# Decommission the retired MBP 7:30 brief agent entirely (bootout + plist
# removal): the Mini owns scheduled generation now.
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
launchctl bootstrap "gui/$UID_NUM" "$ATTENTION_SWEEP_PLIST"
WORKER_START_EPOCH="$(date +%s)"
launchctl bootstrap "gui/$UID_NUM" "$WORKER_PLIST"
if [ "$INSTALL_MEETING_LANE" = "1" ]; then
  launchctl bootstrap "gui/$UID_NUM" "$MEETING_PLIST"
  mark_lane_installed meeting_watch
fi
if [ "$INSTALL_PROGRESS_LANE" = "1" ]; then
  launchctl bootstrap "gui/$UID_NUM" "$PROGRESS_PLIST"
  mark_lane_installed progress_reconcile
fi
if [ -f "$TRIAGE_PLIST" ]; then launchctl bootstrap "gui/$UID_NUM" "$TRIAGE_PLIST"; fi
launchctl enable "gui/$UID_NUM/com.cove.local" 2>/dev/null || true
launchctl enable "gui/$UID_NUM/com.cove.claude-worker" 2>/dev/null || true
launchctl enable "gui/$UID_NUM/com.cove.jobs" 2>/dev/null || true
launchctl enable "gui/$UID_NUM/com.cove.attention-sweep" 2>/dev/null || true
if [ "$INSTALL_MEETING_LANE" = "1" ]; then
  launchctl enable "gui/$UID_NUM/com.cove.meeting-watch" 2>/dev/null || true
fi
if [ "$INSTALL_PROGRESS_LANE" = "1" ]; then
  launchctl enable "gui/$UID_NUM/com.cove.progress" 2>/dev/null || true
fi

# Confirm the server actually came up. This catches the most common failure:
# launchd not being able to find/run Node on the client's machine.
echo "Starting Cove..."
UP=""
for _ in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3200/tasks" 2>/dev/null || true)"
  case "$CODE" in
    200|307|308) UP="yes"; break ;;
  esac
  sleep 1
done

if [ -n "$UP" ]; then
  WORKER_UP=""
  for _ in $(seq 1 30); do
    WORKER_HEARTBEAT="$REPO_DIR/data/claude-worker.heartbeat"
    WORKER_HEARTBEAT_EPOCH="$(stat -f '%m' "$WORKER_HEARTBEAT" 2>/dev/null || printf '0')"
    if [ "$WORKER_HEARTBEAT_EPOCH" -ge "$WORKER_START_EPOCH" ]; then
      WORKER_UP="yes"
      break
    fi
    sleep 1
  done
  if [ -z "$WORKER_UP" ]; then
    echo "Warning: Cove web started, but the Claude worker has not written a fresh heartbeat yet." >&2
    echo "See: $LOG_DIR/cove-claude-worker.error.log" >&2
    echo "Retry the worker: launchctl kickstart -k gui/$UID_NUM/com.cove.claude-worker" >&2
  fi
  echo "Creating the first Cove database backup..."
  "$TSX_BIN" "$REPO_DIR/scripts/cove-jobs.ts" enqueue-backup --run
  echo "Cove is running at http://localhost:3200 and will start automatically on login."
  echo "Server logs: $LOG_DIR/cove.log"
  echo "Daily database backups: $REPO_DIR/data/backups"
  echo "Reliability jobs: bounded scheduler supervised by com.cove.jobs"
  echo "Attention sweep: shadow mode at 11:30 and 16:00"
  echo "Claude worker: supervised by com.cove.claude-worker"
  if [ -n "$WORKER_UP" ]; then
    echo "Claude worker status: ok"
  else
    echo "Claude worker status: not started"
  fi
  if [ "$INSTALL_MEETING_LANE" = "1" ]; then
    echo "Meeting watcher: every 5 minutes while this Mac is awake, with catch-up on wake"
  else
    echo "Meeting watcher: skipped because $MEETING_OWNER owns this lane"
  fi
  if [ "$INSTALL_PROGRESS_LANE" = "1" ]; then
    echo "Progress reconciler: every 30 minutes while this Mac is awake, with catch-up on wake"
  else
    echo "Progress reconciler: skipped because $PROGRESS_OWNER owns this lane"
  fi
  echo "Morning Brief: on-open backfill/post-settlement; --mini optionally adds a 7:30 always-on lane"
  echo "Day-plan batch execution remains off until COVE_CLAUDE_EXECUTION_ENABLED=1 and an allowlisted workspace config are explicitly added."
  echo "Task owner chips open Claude sessions: Claude works the task with automatic file edits; Together opens a planning session. Neither can send, publish, or purchase."
else
  echo "Cove did not respond on http://localhost:3200 within 20 seconds." >&2
  echo "See the log for why: $LOG_DIR/cove.error.log" >&2
  echo "Most common cause: Node is installed via nvm/fnm/Volta and launchd can't use it." >&2
  echo "Fix: install Node with Homebrew (brew install node), then re-run: bash scripts/install-cove-local.sh" >&2
  exit 1
fi
