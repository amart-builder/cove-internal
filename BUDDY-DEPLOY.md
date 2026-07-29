# Cove Buddy deployment

Buddy is Cove's water-drop chat companion for reading Cove data, making confirmed changes, and opening new Claude Code sessions.

## Required environment

Buddy now defaults to loopback access when `COVE_DAY_PLAN_ACCESS_MODE` is unset or empty. Keeping this explicit value in every Cove web LaunchAgent is belt-and-braces configuration:

```xml
<key>COVE_DAY_PLAN_ACCESS_MODE</key>
<string>loopback</string>
```

The MacBook also uses:

```xml
<key>COVE_BUDDY_DEEPLINKS</key>
<string>1</string>
<key>COVE_BUDDY_APP_URL</key>
<string>http://127.0.0.1:3200</string>
```

The Mini uses the same block with `COVE_BUDDY_DEEPLINKS` set to `0`. `COVE_BUDDY_APP_URL` is optional. Cove defaults it to `http://127.0.0.1:3200`.

## MacBook build and restart

The local installer creates the `com.cove.local` service. Run:

```bash
cd /path/to/cove
npm run build

PLIST="$HOME/Library/LaunchAgents/com.cove.local.plist"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:COVE_DAY_PLAN_ACCESS_MODE loopback" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:COVE_DAY_PLAN_ACCESS_MODE string loopback" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:COVE_BUDDY_DEEPLINKS 1" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:COVE_BUDDY_DEEPLINKS string 1" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:COVE_BUDDY_APP_URL http://127.0.0.1:3200" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:COVE_BUDDY_APP_URL string http://127.0.0.1:3200" "$PLIST"

launchctl bootout "gui/$(id -u)/com.cove.local" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.cove.local"
```

## Mac Mini build and restart

Connect to the always-on machine (use your own SSH host and the repo path on that machine).

```bash
ssh <user>@<always-on-mac>
cd <path-to-cove-repo>
npm run build

PLIST="$HOME/Library/LaunchAgents/com.atlas.cove-web.plist"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:COVE_DAY_PLAN_ACCESS_MODE loopback" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:COVE_DAY_PLAN_ACCESS_MODE string loopback" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:COVE_BUDDY_DEEPLINKS 0" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:COVE_BUDDY_DEEPLINKS string 0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:COVE_BUDDY_APP_URL http://127.0.0.1:3200" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:COVE_BUDDY_APP_URL string http://127.0.0.1:3200" "$PLIST"

launchctl bootout "gui/$(id -u)/com.atlas.cove-web" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.atlas.cove-web"
```

## Confirm Buddy loads

1. Open Cove on that machine.
2. Confirm the blue water-drop character appears in the bottom-right corner.
3. Open it and send a short message.
4. Confirm the answer streams into the panel and the cost and turn count update.
5. On the MacBook, session cards open Claude Code directly. On the Mini, session cards show a copyable `claude --resume` command. Sessions are stored per machine.

## Roll back

If the deployed work has a Git commit, revert that commit, rebuild, and restart the matching service:

```bash
git log --oneline -10
git revert <phase-5-commit>
npm run build
```

If deployment was staged from the verified patch snapshots, restore the last known-good phase with the matching `phaseN-verified.patch` file. Check the patch direction before applying it:

```bash
git apply --check -R phase5-verified.patch
git apply -R phase5-verified.patch
npm run build
```

Then repeat the appropriate LaunchAgent restart commands above.
