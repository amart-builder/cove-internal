# Cove Configuration

The default is local SQLite with no account or cloud database. Configuration is read from `.env.local`, `COVE_*` environment variables rendered into LaunchAgents, ignored files under `data/`, and macOS Keychain.

## Core paths and runtime

| Setting | Purpose | Default |
| --- | --- | --- |
| `COVE_DATA_DIR` | Private runtime data | `<repo>/data` |
| `COVE_DB_PATH` | SQLite database override | `<data>/cove.db` |
| `COVE_CLAUDE_BIN` | Claude CLI path | discovered from PATH |
| `COVE_CODEX_BIN` | Codex CLI path for background model jobs | discovered from PATH |
| `COVE_CLAUDE_WORKER_ENABLED` | Enable supervised background execution | installer-managed |
| `COVE_BRIEF_TIMEZONE` | Morning Brief target timezone | operator timezone |
| `COVE_JOB_RUNNER` | Background model backend: `codex-sol-high` or the manual `claude` override | `codex-sol-high` |
| `COVE_MEETING_ANALYST` | Deep meeting analysis workflow. Set to `0` or `off` to use legacy extraction wholesale | on |

`COVE_JOB_RUNNER` is the supported backend selector for every non-interactive
model lane. Older installs may still set `COVE_BRIEF_WRITER`,
`COVE_DUMP_WRITER`, or their `FORGE_*` aliases. Cove accepts those only as
legacy per-lane overrides when `COVE_JOB_RUNNER` is absent; the installer does
not emit them.

## Optional integrations

- Google Workspace is configured through Cove's local connection flow. Do not place OAuth secrets in `.env.local`.
- Meeting ingestion requires a private `data/cove-meetings.json` copied from the disabled example and deliberately set to `enabled: true`. Keep `window` at `newer_than:4d` so the weekday watcher can recover Friday-evening and weekend notes on Monday. The Gmail watcher runs every 15 minutes on weekdays from 08:00 through a final 18:00 local run, plus once at login. A separate local-only analysis drain runs every 15 minutes at all hours, invoking the model only when it claims a ready job. When enabled, `COVE_MEETING_ANALYST` defaults on. Its durable analyst queue replaces legacy extraction; `0` or `off` switches the entire meeting pipeline back to legacy extraction. After durable ingestion, Cove applies `Cove/Meeting-Processed` and archives the message by removing `INBOX`; it never deletes or marks the message read. Archive failures are logged but do not repeat ingestion. Permanently failed re-picks remain in the inbox as a visible failure signal.
- `COVE_SUPERNOVA_DIR` is an owner-only content integration, and client installs must leave it unset.
- Task-session workspaces require an explicit allowlisted workspace configuration.

## Judgment shadow modes

The installer creates private `data/attention-sweep.json` settings with both judgment model lanes in shadow mode:

```json
{"shadow":true,"email_shadow":true}
```

Set `shadow` to `false` only after the 11:30 and 16:00 attention sweep has shown acceptable precision in Quiet Current. Set `email_shadow` to `false` only after urgent-email classifications have shown acceptable precision. The deterministic noon floor is live regardless of these settings.

## Compatibility

`FORGE_*` names are accepted only for migration from older installations. New documentation, scripts, and configuration must use `COVE_*`. Supabase, Convex, and multi-machine relay settings are not part of the supported single-Mac product.
