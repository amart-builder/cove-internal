# Cove documentation index

Root documentation is the current product and engineering contract. Read
`CODEBASE_GUIDE.md`, `ARCHITECTURE.md`, `DATA.md`, `CONFIGURATION.md`,
`OPERATIONS.md`, and `SECURITY_AND_INTEGRATIONS.md` before using the records in
this directory.

## Current reference

| Document | Status | Use it for |
| --- | --- | --- |
| `cove-north-star-draft.md` | Proposed product direction | The responsibility Cove should assume; not an activated agent mandate. |
| `chief-of-staff-methodology-review-2026-09-05.md` | Current methodology audit | Confirmed gaps, synthetic reproductions and acceptance criteria for reliable follow-through. |
| `handoff-sales-pipeline-gpt6.md` | Prior implementation handoff | Sales pipeline ownership and remaining implementation context. |
| `responsibility-rollout-2026-09-05.md` | Implementation and acceptance record | Four-part chief-of-staff improvement, verification and activation limits. |
| `email-architecture-redesign.md` | Current design record | Gmail and Cove state ownership, crash recovery, and no-send acceptance criteria. |
| `morning-brief.md` | Current core with historical sections | Brief collection, artifact, validation, and consumption. Its cross-machine relay section is retained as history; the supported product is now one Mac. |
| `demo-runbook.md` | Current internal runbook | Isolated demo data and port 3300 rehearsal. Never use it during a real install. |

## Historical records

These explain why the code evolved but do not override root docs or current
code.

| Document | Historical scope |
| --- | --- |
| `arrival-trigger-spike.md` | Reversible browser-arrival experiment. Not part of the production installer. |
| `codebase-review-2026-09-04.md` | Review, implemented fixes, remaining decisions, validation, and activation limits. |
| `client-readiness-2026-09-04.md` | Client setup and empty-day improvements, exported-package rehearsal, and rollout limits. |
| `code-review-2026-07-26.md` | Point-in-time audit. Many findings were fixed or superseded later. |
| `cove-plan-2026-07.md` | Settled July build plan and product decisions. Implementation status is historical. |
| `wave-summary-2026-07-29.md` | Build-wave completion summary. Product and repository status in it is stale. |
| `gary-install-runbook-2026-08-03.md` | Superseded install-day plan. `SETUP.md` is authoritative. |
| `gary-handoff-one-pager.md` | Client leave-behind drafted for a specific rollout. Not general engineering documentation. |

## Supporting artifacts

| Artifact | Status | Use it for |
| --- | --- | --- |
| `cove-execution.example.json` | Compatibility example | Shape of the older allowlisted autonomous-execution workspace file. Fresh installs leave autonomy off. |
| `design/today-focus-v1.html` | Historical design prototype | Point-in-time Today focus mockup. The shipped components and current browser are authoritative. |

If a historical record conflicts with a root document, the root document wins.
If code and a root document conflict, stop and verify the current behavior, then
fix the stale side of the contract.
