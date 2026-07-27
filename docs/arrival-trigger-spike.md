# Phase 0 macOS arrival trigger spike

This is a reversible experiment for learning whether an awake, logged-in Mac can reliably put Forge in front of the user at the right morning seam. It is not wired into Forge's production or client installer.

The pulse is state-authoritative. Every run reads `GET /api/day-plan`, then opens the fixed `/tasks` URL only when:

- the configured local time has passed on a configured workday;
- the date is not a configured quiet date; and
- there is no plan yet, the current plan is `due` or `failed`, or its snooze time has elapsed.

It does not open a plan that is already opened, skipped, bypassed, confirmed, or settled. A failed request, malformed server response, bad receipt file, or unavailable Forge server fails closed. The script never POSTs to Forge and never uses or logs the CSRF token returned by the day-plan endpoint. When no plan exists, opening `/tasks` lets the app perform its normal plan ensure.

One recovery case is deliberate: if the only unsettled plan belongs to an earlier local date, the pulse opens Forge once. The app opens that prior Day Settlement first, then creates today's Morning Arrival only after the previous workday is closed.

## Configure

Create `data/forge-arrival.json` (the entire `data/` directory is already gitignored):

```json
{
  "forge_url": "http://localhost:3200",
  "timezone": "America/Los_Angeles",
  "arrival_time": "08:00",
  "weekdays": [1, 2, 3, 4, 5],
  "quiet_dates": ["2026-07-17"]
}
```

Weekdays use ISO numbers: Monday is 1 and Sunday is 7. Times are 24-hour `HH:MM`. Time and date decisions use the configured IANA timezone, including daylight-saving changes, rather than the Mac's current timezone.

For an isolated test, `FORGE_ARRIVAL_CONFIG` may contain inline JSON or the path to another config file. The configured URL is reduced to its origin. Polling is always `<origin>/api/day-plan`, and the only browser target is `<origin>/tasks`. URLs with credentials or a non-HTTP protocol are rejected.

The day-plan route denies access when no server-owned access mode is configured. For this local experiment, bind Forge to `127.0.0.1` and set `FORGE_DAY_PLAN_ACCESS_MODE=loopback`; the mode is safe only because the server is actually reachable through loopback. A non-loopback deployment must instead set `FORGE_DAY_PLAN_ACCESS_MODE=session` and `FORGE_DAY_PLAN_REMOTE_TOKEN`, then use a trusted proxy or browser integration to inject the matching `X-Forge-Day-Plan-Session` header. The current browser client does not inject that header, so remote Morning Arrival stays disabled until that trusted path is deliberately built.

The repository's local installer now writes the loopback mode into its loopback-bound Forge LaunchAgent. An already-installed plist does not update itself; rebuild and rerun the installer before local dogfood, then verify the generated agent contains both the `127.0.0.1` bind and `FORGE_DAY_PLAN_ACCESS_MODE=loopback`.

## Run the spike

Validate the config without polling or opening anything:

```bash
node scripts/forge-arrival-spike.mjs --check-config
```

Dry-run is the default. It polls and reports the decision, but creates no delivery receipt and does not invoke the browser:

```bash
node scripts/forge-arrival-spike.mjs
```

Live opening requires the explicit flag:

```bash
node scripts/forge-arrival-spike.mjs --live-open
```

Only a successful `/usr/bin/open <origin>/tasks` call gets a receipt. The receipt is atomically replaced at `data/forge-arrival-receipts.json` with mode `0600`. `data/forge-arrival-spike.lock` prevents overlapping minute pulses and is removed after each run. Runtime logs contain only a timestamp, an optional plan/event key, and a result. Manual runs log to stdout.

## launchd experiment shape

The proposed spike-only LaunchAgent is `com.forge.arrival-spike`. Its plist should use:

- absolute paths for Node, this repository, and the spike script;
- `RunAtLoad` so a login starts a pulse;
- `StartInterval` of 60 seconds so the next pulse observes wake or a late login;
- `LimitLoadToSessionType` set to `Aqua`; and
- `--live-open` in `ProgramArguments` only after supervised dry-run testing.

If installed manually, use `~/Library/Logs/forge-arrival-spike.log` for both standard output and error. Lint the temporary plist with `plutil -lint`, atomically move it into `~/Library/LaunchAgents/com.forge.arrival-spike.plist`, then use only:

```bash
launchctl bootout "gui/$(id -u)/com.forge.arrival-spike" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.forge.arrival-spike.plist"
```

This Phase 0 work does not create, install, bootstrap, or modify that plist. It does not touch any existing Forge LaunchAgent or the main installer.

To uninstall a manual experiment, boot out exactly `gui/$(id -u)/com.forge.arrival-spike` and move only its plist out of `~/Library/LaunchAgents`. The delivery receipt can remain for diagnosis or be moved to Trash to reset the experiment.

## What the spike can and cannot prove

A LaunchAgent does not wake a sleeping Mac, start an off Mac, or run while no user is logged in. `StartInterval` supplies a pulse after the Mac wakes inside a logged-in Aqua session; `RunAtLoad` supplies one after login. This is catch-up polling, not a true wake alarm.

`/usr/bin/open` delegates to the user's default browser. An already-open Forge page may be focused, reused, or accompanied by another tab depending on browser behavior. Duplicate-tab behavior remains an experiment and is not claimed as solved by the receipt policy.

The deterministic test matrix covers:

| Case | Expected result |
| --- | --- |
| Before configured time | No open |
| Later pulse after time or wake | Open if server state is due |
| Weekend or quiet date | No open |
| DST jump and timezone difference | Configured local wall clock wins |
| No current plan | One initial open so the app can ensure |
| Due or failed | One open per plan version |
| Snoozed | Open only when `snoozedUntil` elapses |
| Opened, skipped, bypassed, confirmed, settled for today | No open |
| Earlier unsettled workday | One open so Forge can finish Settlement first |
| Existing receipt | No duplicate delivery for its key |
| Server unavailable or malformed | Fail closed |

Run it with:

```bash
node --test tests/forge-arrival-schedule.test.mjs
```
