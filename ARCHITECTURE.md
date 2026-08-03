# Cove Architecture

Cove is a local-first, single-operator command center. Its north star is to show the operator what matters now, let AI prepare useful work, and never hide uncertainty or take an irreversible action without a clear boundary.

## System shape

```mermaid
flowchart LR
  UI["Next.js UI on 127.0.0.1:3200"] --> API["Loopback API routes"]
  API --> DB["SQLite: data/cove.db"]
  Jobs["Durable job scheduler"] --> DB
  Worker["Bounded model workers"] --> Jobs
  Google["Restricted Google gateway"] --> Gmail["Gmail drafts and archive"]
  API --> Google
  Watchers["Meeting and progress watchers"] --> DB
  Launchd["macOS LaunchAgents"] --> UI
  Launchd --> Jobs
  Launchd --> Worker
  Launchd --> Watchers
```

## Trust boundaries

- SQLite is the durable application source of truth. UI optimism is temporary and must roll back when persistence fails.
- Gmail remains the email source of truth. Cove's gateway code exposes read, draft creation, narrow label changes, and archive operations, with no send operation. The `gmail.modify` scope is the narrowest Google scope that still permits drafts and archiving, and it does not permit permanent deletion. The no-send guarantee is enforced by Cove's code, not by the credential.
- Model output is a proposal. Deterministic code validates schemas, task IDs, evidence references, state versions, and allowed operations before persistence.
- Background work uses durable jobs, idempotency keys, leases, bounded retries, receipts, and an Issues inbox.
- Model subprocesses receive explicit tools, isolated settings and MCP configuration, a minimal environment, a spend ceiling, and a wall-clock deadline.

## Product domains

| Domain | Primary code | Durable state |
| --- | --- | --- |
| Tasks and Quiet Current | `src/components/tasks`, `src/lib/day-plan`, `src/lib/quiet-current` | tasks, day plans, ritual decisions |
| Morning Brief | `src/lib/day-plan/brief*`, `src/lib/claude-execution/worker.ts` | immutable brief artifacts and exact input manifests |
| Email | `src/lib/email`, `scripts/cove-email-runner.ts` | thread ledger, Gmail operation outbox, receipts |
| Meetings and progress | `src/lib/intake`, meeting and progress scripts | tasks, digests, relays, heartbeats |
| Reliability | `src/lib/reliability`, `src/lib/health` | jobs, receipts, failures, backups, readiness |
| Google Workspace | `src/lib/workspace` | non-secret local config plus secrets in macOS Keychain |

## Supported deployment

The supported product is one Mac, one operator, local SQLite, and a localhost-only web process. Old Forge names, Supabase branches, relays, and retired multi-machine notes are migration history, not the product architecture. Compatibility code must never create a second source of truth.

The meeting and progress LaunchAgent plists are templates under `scripts/launchd/`; `scripts/install-cove-local.sh` generates five more agents on a default install, plus an email-triage agent once Gmail is configured. `--mini` is a separate profile: it installs the Mini brief agent and the two rendered lane plists, then stops.
