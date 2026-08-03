# Cove Operations

## Install and start

Follow `SETUP.md`. The installer renders absolute Node paths into LaunchAgents, creates a private empty `.env.local` when needed, starts the localhost app and background lanes, and reports a slow worker heartbeat as a warning with a retry command.

The supported app URL is `http://127.0.0.1:3200` (or `http://localhost:3200`). Logs live in `~/Library/Logs/` with `cove` in the filename.

## Health

The Current displays live readiness for email, the brief writer, and the background worker. Empty and unavailable are different states. `/api/health` exposes the same read model to trusted local requests, plus the latest periodic health snapshot.

Failures that need attention are recorded in Cove's Issues surface. A partial receipt means useful work completed but the named remainder needs a later run or operator action.

## Recovery

- Stale Morning Brief claims become retryable through the normal Morning Arrival control.
- Failed email archives leave the item open and retryable.
- Dead jobs appear in Issues rather than disappearing.
- Use `bash scripts/cove-restore-backup.sh --yes <backup-file>` for database recovery.
- Re-run `bash scripts/install-cove-local.sh` after moving the repository or changing the Node installation.

## Verification

Run `npm run verify` before an install artifact or release. It performs type checking, lint, the full automated suite, the production build, and the installer, skill-authentication, and redaction contract tests.

## Release boundary

The internal repository is not a client artifact. Build a sanitized tree with `node scripts/export-cove-client.mjs --output <empty-directory>`, inspect its manifest and checks, then test that exact directory. Publication and repository visibility changes are separate approved actions.
