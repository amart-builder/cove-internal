#!/usr/bin/env bash
# Set up Forge to run locally and start automatically on login.
#   - Serves http://localhost:3200 (bound to localhost only; never exposed to the network)
#   - Restarts itself if it crashes or the Mac reboots
#   - Backs up the database once a day
# Safe to re-run: it replaces any previous Forge LaunchAgents.
set -euo pipefail

# --mini installs ONLY the always-on Mac Mini's 7:30 morning-brief agent (the
# Mini generates the brief and relays it to the MBP over Syncthing). The default
# (MBP) install no longer schedules a 7:30 brief agent at all; backfill and the
# post-settlement trigger cover the MBP side.
MINI=0
for arg in "$@"; do
  case "$arg" in
    --mini) MINI=1 ;;
  esac
done

# The default web profile is the MacBook, which can open local Claude Code deep
# links. The existing --mini profile defaults web-facing Buddy config to the
# portable resume-command behavior documented in BUDDY-DEPLOY.md.
if [ -n "${FORGE_BUDDY_DEEPLINKS:-}" ]; then
  BUDDY_DEEPLINKS="$FORGE_BUDDY_DEEPLINKS"
elif [ "$MINI" = "1" ]; then
  BUDDY_DEEPLINKS=0
else
  BUDDY_DEEPLINKS=1
fi
BUDDY_APP_URL="${FORGE_BUDDY_APP_URL:-http://127.0.0.1:3200}"
SUPERNOVA_DIR=""
if [ -n "${FORGE_SUPERNOVA_DIR:-}" ] && [ -d "$FORGE_SUPERNOVA_DIR" ]; then
  SUPERNOVA_DIR="$FORGE_SUPERNOVA_DIR"
else
  if [ "$MINI" = "1" ]; then
    SUPERNOVA_PRIMARY="$HOME/Desktop/Atlas/Projects/supernova-engine"
    SUPERNOVA_SECONDARY="$HOME/Atlas/Projects/supernova-engine"
  else
    SUPERNOVA_PRIMARY="$HOME/Atlas/Projects/supernova-engine"
    SUPERNOVA_SECONDARY="$HOME/Desktop/Atlas/Projects/supernova-engine"
  fi
  for candidate in "$SUPERNOVA_PRIMARY" "$SUPERNOVA_SECONDARY"; do
    if [ -d "$candidate" ]; then
      SUPERNOVA_DIR="$candidate"
      break
    fi
  done
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
    '    <key>FORGE_SUPERNOVA_DIR</key>\n    <string>%s</string>' \
    "$SUPERNOVA_XML_DIR"
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs"
LA_DIR="$HOME/Library/LaunchAgents"
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
    echo "Note: Node is managed by a version manager. If Forge stops starting after you switch Node versions, re-run this script." ;;
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
CLAUDE_BIN="${FORGE_CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
if [ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude"
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  echo "Claude Code is required for Forge execution. Install it or set FORGE_CLAUDE_BIN." >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$LA_DIR"

# --- Mini-only: install the 7:30 morning-brief agent and exit ---------------
# The Mini already runs its own web + worker via com.atlas.forge-web; this flag
# adds only the scheduled brief generator, which writes the relay files the MBP
# imports. Logs go to ~/Library/Logs (TCC blocks launchd writes under ~/Desktop).
if [ "$MINI" = "1" ]; then
  # SAFETY GATE: the Mini agent is a second live SQLite writer on a tree that
  # Syncthing used to sync wholesale. Bootstrapping it before forge.db is
  # excluded from sync ON BOTH machines is a documented corruption vector, so
  # this refuses to proceed until the operator confirms. Confirm with
  # FORGE_MINI_CONFIRM_STIGNORE=1 or interactively below.
  cat <<'STIGNORE_BLOCK'
================================================================================
Before this installs anything, ~/Atlas/.stignore must contain the block below
ON BOTH MACHINES (.stignore itself does NOT sync — edit it on each machine),
and the Forge web + worker processes on both machines must have been STOPPED
when the block was applied:

// --- Forge machine-private runtime state (brief-relay change) ---
// Each machine keeps its OWN forge.db now; a live SQLite file must never sync
// (torn-write corruption). -wal/-shm are already covered by the global rules
// above. The relay dirs (brief-relay/, settlement-relay/) and
// source-checkpoint.json are the transport and MUST keep syncing — not listed.
projects/astack/forge/data/forge.db
projects/astack/forge/data/claude-runs
projects/astack/forge/data/claude-runs/**
projects/astack/forge/data/claude-worker.heartbeat
projects/astack/forge/data/backups
projects/astack/forge/data/backups/**
================================================================================
STIGNORE_BLOCK
  if [ "${FORGE_MINI_CONFIRM_STIGNORE:-0}" != "1" ]; then
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
      echo "Refusing to bootstrap the Mini brief agent: confirm the .stignore block is applied on BOTH machines (writers stopped), then re-run with FORGE_MINI_CONFIRM_STIGNORE=1." >&2
      exit 1
    fi
  fi
  # The Atlas root is three levels up from the repo (<atlas>/projects/astack/forge).
  ATLAS_ROOT="$(cd "$REPO_DIR/../../.." && pwd)"
  MINI_BRIEF_PLIST="$LA_DIR/com.forge.morning-brief.plist"
  cat > "$MINI_BRIEF_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.forge.morning-brief</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TSX_BIN</string>
    <string>$REPO_DIR/scripts/forge-claude-worker.ts</string>
    <string>--lane</string>
    <string>brief</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/forge-morning-brief.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/forge-morning-brief.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>FORGE_CLAUDE_WORKER_ENABLED</key>
    <string>1</string>
    <key>FORGE_CLAUDE_BIN</key>
    <string>$CLAUDE_BIN</string>
    <key>FORGE_BRIEF_WEB_BASE</key>
    <string>http://127.0.0.1:3200</string>
    <key>FORGE_BRIEF_TIMEZONE</key>
    <string>America/Los_Angeles</string>
    <key>FORGE_BRIEF_REQUIRE_SOURCE_CHECKPOINT</key>
    <string>1</string>
    <key>FORGE_BRIEF_WRITER</key>
    <string>codex</string>
    <key>FORGE_CODEX_BIN</key>
    <string>/opt/homebrew/bin/codex</string>
    <key>FORGE_BRIEF_GOALS_PATH</key>
    <string>$ATLAS_ROOT/brain/GOALS.md</string>
    <key>FORGE_BRIEF_OPERATOR_PROFILE_PATH</key>
    <string>$ATLAS_ROOT/brain/operator-profile.md</string>
    <key>FORGE_BRIEF_LEADUP_PATH</key>
    <string>$ATLAS_ROOT/brain/brief-leadup.md</string>
    <key>FORGE_BRIEF_SPRINT_MEMO_PATH</key>
    <string>$ATLAS_ROOT/brain/path-to-30k-2026-07.md</string>
$SUPERNOVA_PLIST_ENTRY
    <key>FORGE_CONTENT_QUOTA_POSTS</key>
    <string>2</string>
  </dict>
</dict>
</plist>
EOF
  UID_NUM="$(id -u)"
  launchctl bootout "gui/$UID_NUM/com.forge.morning-brief" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$MINI_BRIEF_PLIST"
  echo "Installed the Mini morning-brief agent (7:30 local): $MINI_BRIEF_PLIST"
  echo "Brief goals: $ATLAS_ROOT/brain/GOALS.md"
  echo "Logs: $LOG_DIR/forge-morning-brief.log"
fi

# --- Install the Forge SessionStart hook without replacing Claude settings ---
HOOK_SRC="$REPO_DIR/scripts/hooks/forge-orchestrator.sh"
HOOK_DIR="$HOME/.claude/hooks"
HOOK_DEST="$HOOK_DIR/forge-orchestrator.sh"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOOK_DIR" "$(dirname "$CLAUDE_SETTINGS")"
cp "$HOOK_SRC" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
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
const installed = settings.hooks.SessionStart.some((entry) =>
  entry && typeof entry === 'object' && entry.matcher === 'resume' &&
  Array.isArray(entry.hooks) && entry.hooks.some((hook) =>
    hook && typeof hook === 'object' && typeof hook.command === 'string' &&
    (hook.command === hookPath || hook.command.endsWith('/forge-orchestrator.sh')))
);
if (!installed) {
  settings.hooks.SessionStart.push({
    matcher: 'resume',
    hooks: [{ type: 'command', command: hookPath }],
  });
  const temporaryPath = `${settingsPath}.forge-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, settingsPath);
}
NODE
echo "Installed the Forge orchestrator hook into $HOOK_DEST"

if [ "$MINI" = "1" ]; then
  exit 0
fi

# --- Install Forge's skills for Claude and Codex ---
# The forge-* skills are refreshed every run in both supported agent homes. The
# bundled humanizer skill is installed only when absent, so unrelated personal
# skills and newer humanizer copies are never overwritten.
SKILLS_SRC="$REPO_DIR/skills"
if [ -d "$SKILLS_SRC" ]; then
  for agent_skills in "$HOME/.claude/skills" "${CODEX_HOME:-$HOME/.codex}/skills"; do
    mkdir -p "$agent_skills"
    for skill_dir in "$SKILLS_SRC"/forge-*; do
      [ -d "$skill_dir" ] || continue
      rm -rf "$agent_skills/$(basename "$skill_dir")"
      cp -R "$skill_dir" "$agent_skills/"
    done
    if [ -d "$SKILLS_SRC/humanizer" ] && [ ! -d "$agent_skills/humanizer" ]; then
      cp -R "$SKILLS_SRC/humanizer" "$agent_skills/"
    fi
    echo "Installed the Forge skills into $agent_skills"
  done
fi

SERVER_PLIST="$LA_DIR/com.forge.local.plist"
BACKUP_PLIST="$LA_DIR/com.forge.local.backup.plist"
REMINDERS_PLIST="$LA_DIR/com.forge.reminders.plist"
TRIAGE_PLIST="$LA_DIR/com.forge.email-triage.plist"
WORKER_PLIST="$LA_DIR/com.forge.claude-worker.plist"

# --- Server: next start on localhost:3200 ---
cat > "$SERVER_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.forge.local</string>
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
  <string>$LOG_DIR/forge.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/forge.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>FORGE_DAY_PLAN_ACCESS_MODE</key>
    <string>loopback</string>
    <key>FORGE_BUDDY_DEEPLINKS</key>
    <string>$BUDDY_DEEPLINKS</string>
    <key>FORGE_BUDDY_APP_URL</key>
    <string>$BUDDY_APP_URL</string>
    <key>FORGE_CLAUDE_WORKER_AVAILABLE</key>
    <string>1</string>
$SUPERNOVA_PLIST_ENTRY
    <key>FORGE_CONTENT_QUOTA_POSTS</key>
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
  <string>com.forge.claude-worker</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TSX_BIN</string>
    <string>$REPO_DIR/scripts/forge-claude-worker.ts</string>
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
  <string>$LOG_DIR/forge-claude-worker.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/forge-claude-worker.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>FORGE_CLAUDE_WORKER_ENABLED</key>
    <string>1</string>
    <key>FORGE_NOTIFY</key>
    <string>1</string>
    <key>FORGE_CLAUDE_BIN</key>
    <string>$CLAUDE_BIN</string>
    <key>FORGE_BUDDY_DEEPLINKS</key>
    <string>$BUDDY_DEEPLINKS</string>
    <key>FORGE_BRIEF_WEB_BASE</key>
    <string>http://127.0.0.1:3200</string>
$SUPERNOVA_PLIST_ENTRY
    <key>FORGE_CONTENT_QUOTA_POSTS</key>
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
# the post-settlement evening trigger. Any previously installed com.forge.morning-brief
# agent is booted out below.

# --- Daily database backup at 3:30am ---
cat > "$BACKUP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.forge.local.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_DIR/scripts/forge-backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/forge-backup.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/forge-backup.log</string>
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
  <string>com.forge.reminders</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_REAL</string>
    <string>$REPO_DIR/scripts/forge-reminders.mjs</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/forge-reminders.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/forge-reminders.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

# --- Email triage: run the forge-email skill at the user's chosen times ---
# Only scheduled once email is set up (the Email step writes data/forge-email.json
# with triage_times + timezone). launchd fires at LOCAL time on the Mac.
# triage_times may hold any number of "HH:MM" entries; we emit one calendar dict
# per entry. No Weekday keys go in the plist: the runner's weekday guard (driven
# by the config's weekdays_only flag) owns weekend skipping.
if [ -f "$REPO_DIR/data/forge-email.json" ]; then
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
  ' "$REPO_DIR/data/forge-email.json" 2>/dev/null || true)"
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
  <string>com.forge.email-triage</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_DIR/scripts/forge-email-triage.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
$TRIAGE_CAL_XML
  </array>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/forge-email-triage.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/forge-email-triage.log</string>
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
  echo "Scheduled email triage (times from data/forge-email.json; default 9:00 and 15:00)."
else
  rm -f "$TRIAGE_PLIST"
fi

# (Re)load all agents with the modern launchctl API (idempotent).
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/com.forge.local" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.forge.local.backup" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.forge.reminders" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.forge.email-triage" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/com.forge.claude-worker" 2>/dev/null || true
# Decommission the retired MBP 7:30 brief agent entirely (bootout + plist
# removal): the Mini owns scheduled generation now.
launchctl bootout "gui/$UID_NUM/com.forge.morning-brief" 2>/dev/null || true
rm -f "$LA_DIR/com.forge.morning-brief.plist"
launchctl bootstrap "gui/$UID_NUM" "$SERVER_PLIST"
launchctl bootstrap "gui/$UID_NUM" "$BACKUP_PLIST"
launchctl bootstrap "gui/$UID_NUM" "$REMINDERS_PLIST"
launchctl bootstrap "gui/$UID_NUM" "$WORKER_PLIST"
if [ -f "$TRIAGE_PLIST" ]; then launchctl bootstrap "gui/$UID_NUM" "$TRIAGE_PLIST"; fi
launchctl enable "gui/$UID_NUM/com.forge.local" 2>/dev/null || true
launchctl enable "gui/$UID_NUM/com.forge.claude-worker" 2>/dev/null || true

# Confirm the server actually came up. This catches the most common failure:
# launchd not being able to find/run Node on the client's machine.
echo "Starting Forge..."
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
  for _ in $(seq 1 10); do
    if [ -f "$REPO_DIR/data/claude-worker.heartbeat" ]; then
      WORKER_UP="yes"
      break
    fi
    sleep 1
  done
  if [ -z "$WORKER_UP" ]; then
    echo "Forge web started, but the Claude worker did not become healthy." >&2
    echo "See: $LOG_DIR/forge-claude-worker.error.log" >&2
    exit 1
  fi
  echo "Forge is running at http://localhost:3200 and will start automatically on login."
  echo "Server logs: $LOG_DIR/forge.log"
  echo "Daily database backups: $REPO_DIR/data/backups"
  echo "Claude worker: supervised by com.forge.claude-worker"
  echo "Morning Brief: generated on the Mac Mini (install there with --mini) + MBP backfill/post-settlement"
  echo "Autonomous execution remains off until FORGE_CLAUDE_EXECUTION_ENABLED=1 and an allowlisted workspace config are explicitly added."
else
  echo "Forge did not respond on http://localhost:3200 within 20 seconds." >&2
  echo "See the log for why: $LOG_DIR/forge.error.log" >&2
  echo "Most common cause: Node is installed via nvm/fnm/Volta and launchd can't use it." >&2
  echo "Fix: install Node with Homebrew (brew install node), then re-run: bash scripts/install-forge-local.sh" >&2
  exit 1
fi
