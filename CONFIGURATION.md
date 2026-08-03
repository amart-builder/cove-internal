# Cove Configuration

The default is local SQLite with no account or cloud database. Configuration is read from `.env.local`, `COVE_*` environment variables rendered into LaunchAgents, ignored files under `data/`, and macOS Keychain.

## Core paths and runtime

| Setting | Purpose | Default |
| --- | --- | --- |
| `COVE_DATA_DIR` | Private runtime data | `<repo>/data` |
| `COVE_DB_PATH` | SQLite database override | `<data>/cove.db` |
| `COVE_CLAUDE_BIN` | Claude CLI path | discovered from PATH |
| `COVE_CODEX_BIN` | Codex CLI path for briefs | discovered from PATH |
| `COVE_CLAUDE_WORKER_ENABLED` | Enable supervised background execution | installer-managed |
| `COVE_BRIEF_TIMEZONE` | Morning Brief target timezone | operator timezone |
| `COVE_BRIEF_WRITER` | `codex` or explicit legacy `claude` writer | `codex` |

## Optional integrations

- Google Workspace is configured through Cove's local connection flow. Do not place OAuth secrets in `.env.local`.
- Meeting ingestion requires a private `data/cove-meetings.json` copied from the disabled example and deliberately set to `enabled: true`.
- `COVE_SUPERNOVA_DIR` is an owner-only content integration, and client installs must leave it unset.
- Task-session workspaces require an explicit allowlisted workspace configuration.

## Compatibility

`FORGE_*` names are accepted only for migration from older installations. New documentation, scripts, and configuration must use `COVE_*`. Supabase, Convex, and multi-machine relay settings are not part of the supported single-Mac product.
