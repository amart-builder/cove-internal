# Email architecture redesign

## Product rule

After a successful Cove pass, Inbox means an email still needs the operator or
was explicitly kept there by the operator. Cove stores the reason and the next
action. Archive means the current thread is handled. Gmail search and Cove's
People, activity, and commitment records preserve history.

Gmail labels are not Cove's workflow database. Cove does not invent client or
topic labels. A future client-label feature must use an exact canonical CRM
identity and remain separate from inbox state.

## Target states

| Situation | Gmail | Cove |
| --- | --- | --- |
| New and not yet processed | Inbox | Durable message claim |
| Reply, decision, review, or offline action needed | Inbox | Open thread item |
| FYI surfaced once | Archived after the surface receipt commits | Terminal item and receipt |
| Noise, promotion, newsletter, or routine receipt | Archived | Terminal item and receipt |
| Reply sent | Archived | Actioned item plus any waiting-on commitment |
| Action completed in Cove | Archived first | Actioned only after Gmail succeeds |
| New inbound on a terminal thread | Inbox | Existing canonical thread item reopens |

## Architecture

1. Deterministic code fetches and observes Gmail.
2. Before any external mutation, Cove creates a durable claim keyed by Gmail
   message id and resolves one canonical row keyed by Gmail thread id.
3. The model receives bounded untrusted content and returns structured
   judgments and artifacts only: classification, summary, priority, draft text,
   and commitment or relationship candidates. It receives no Gmail credentials
   or side-effect tools.
4. Deterministic code validates the model result and owns draft creation,
   archiving, persistence, card updates, commitments, receipts, and retries.
5. External Gmail mutations use a durable operation record:
   claim in SQLite, observe Gmail, execute, then finalize SQLite. A crash at any
   point is recoverable and retries re-observe Gmail before mutating.
6. A restricted provider gateway exposes only the application operations Cove
   uses. It has no generic execute method and no send, delete, trash, forward,
   filter, settings, or recipient-management operation.

Google's Gmail OAuth scopes for draft and label operations also authorize send.
The guarantee is therefore scoped precisely: sending is structurally excluded
from Cove's agent and application paths, while the isolated Google credential
itself has broader provider-level authority.

## Gmail labels

- Stop writing `Cove/Reply`, `Cove/Action`, `Cove/FYI`, `Cove/Archived`, and
  `Cove/Done`.
- Keep `Cove/Triaged` only during the compatibility migration.
- Do not delete existing `Cove/*` or legacy `Forge/*` labels automatically.
- Remove `Cove/Triaged` only after the durable message-claim path is backfilled,
  live, and proven across crash recovery.
- Review the separate meeting-processed label under the same rule. The meeting
  ingestion ledger, not a Gmail label, must be the durable source of truth.

## User surface

Cove has one rolling Email card or Today surface. It is visible only while email
needs the operator. FYI and automated archive summaries live in Recent activity
after their receipts commit. Historical daily tasks are not interactive email
views.

## Acceptance criteria

1. A sent reply newer than the latest inbound is archived and its reply item is
   actioned. A sent message does not complete an offline-action item.
2. Checking an open email item creates a durable operation, archives Gmail, and
   only then marks the Cove item actioned. Failure leaves it visibly open and
   retryable.
3. A manually archived Gmail thread closes its open Cove item. Restoring an old
   thread to Inbox does not reopen it without a new inbound message or an
   explicit operator action.
4. A new inbound message on a terminal thread reopens the canonical thread row.
   There is one canonical row per Gmail thread and one ingestion claim per Gmail
   message.
5. FYI mail is archived only after its one-time surface is durably recorded.
   Noise may archive immediately, with a recoverable action receipt.
6. A crash after draft creation cannot produce a second draft on retry. Recovery
   observes in-thread drafts before creating one.
7. Provider failure, expired auth, sleep interruption, and process death produce
   retryable operations and visible Issues entries. No thread becomes terminal
   merely because an AI process exited zero.
8. New processing does not write Reply, Action, FYI, Archived, or Done workflow
   labels. Existing labels remain untouched during the first migration.
9. The email surface contains no links to legacy `Forge/*` labels and does not
   render today's live data when an old historical task is opened.
10. The model has no Gmail, Calendar, Drive, Composio, shell, or raw credential
    capability in the classification and drafting lane.
11. The restricted gateway has positive tests for read, draft, and archive, and
    negative tests proving send, delete, trash, forward, arbitrary tool
    execution, and arbitrary Google API paths are unavailable.
12. Composio is removed from runtime code, scheduled jobs, setup, skills, and
    configuration after Gmail, Calendar, and document consumers use the new
    gateway. Removal is verified by a repository-wide search.
13. Gmail, Calendar, and Drive account identities are checked against the
    configured operator account so interactive and background connections cannot
    silently target different accounts.
14. Focused email, meeting, Buddy feedback, Calendar, migration, and UI tests
    pass, followed by the full test suite, TypeScript, and production build.

## Non-goals

- Autonomous sending, forwarding, deleting, or trashing email.
- Free-form AI-generated client or topic folders.
- Moving full email history into Cove.
- Replacing Gmail as the message store.
- Making native Claude connectors a dependency of Cove's deterministic
  background services.
