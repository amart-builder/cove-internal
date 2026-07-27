# Forge Buddy deployment

Buddy is Forge's water-drop chat companion for reading Forge data, making confirmed changes, and opening new Claude Code sessions.

## Required environment

Buddy now defaults to loopback access when `FORGE_DAY_PLAN_ACCESS_MODE` is unset or empty. Keeping this explicit value in every Forge web LaunchAgent is belt-and-braces configuration:

```xml
<key>FORGE_DAY_PLAN_ACCESS_MODE</key>
<string>loopback</string>
```

The MacBook also uses:

```xml
<key>FORGE_BUDDY_DEEPLINKS</key>
<string>1</string>
<key>FORGE_BUDDY_APP_URL</key>
<string>http://127.0.0.1:3200</string>
```

The Mini uses the same block with `FORGE_BUDDY_DEEPLINKS` set to `0`. `FORGE_BUDDY_APP_URL` is optional. Forge defaults it to `http://127.0.0.1:3200`.

## MacBook build and restart

The MacBook service is `com.forge.web`. Run:

```bash
cd /path/to/forge
npm run build

PLIST="$HOME/Library/LaunchAgents/com.forge.web.plist"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FORGE_DAY_PLAN_ACCESS_MODE loopback" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FORGE_DAY_PLAN_ACCESS_MODE string loopback" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FORGE_BUDDY_DEEPLINKS 1" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FORGE_BUDDY_DEEPLINKS string 1" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FORGE_BUDDY_APP_URL http://127.0.0.1:3200" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FORGE_BUDDY_APP_URL string http://127.0.0.1:3200" "$PLIST"

launchctl bootout "gui/$(id -u)/com.forge.web" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.forge.web"
```

## Mac Mini build and restart

Connect to the always-on machine (use your own SSH host and the repo path on that machine).

```bash
ssh <user>@<always-on-mac>
cd <path-to-forge-repo>
npm run build

PLIST="$HOME/Library/LaunchAgents/com.atlas.forge-web.plist"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FORGE_DAY_PLAN_ACCESS_MODE loopback" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FORGE_DAY_PLAN_ACCESS_MODE string loopback" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FORGE_BUDDY_DEEPLINKS 0" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FORGE_BUDDY_DEEPLINKS string 0" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:FORGE_BUDDY_APP_URL http://127.0.0.1:3200" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:FORGE_BUDDY_APP_URL string http://127.0.0.1:3200" "$PLIST"

launchctl bootout "gui/$(id -u)/com.atlas.forge-web" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.atlas.forge-web"
```

## Confirm Buddy loads

1. Open Forge on that machine.
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
