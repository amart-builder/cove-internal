# Cove Security and Integrations

## Local access

The installer binds Cove to `127.0.0.1:3200`; `npm run dev` and `npm start` also default to loopback. Page responses reject framing by other pages to prevent clickjacking. Mutation routes require the local request boundary plus Cove's CSRF token. The token is a bearer credential and must never be logged, committed, or sent to a remote host.

## Google Workspace

Cove uses a direct Google OAuth connection. Non-secret settings live in ignored local data; refresh tokens and client secrets live in macOS Keychain.

- Gmail: Cove's gateway code exposes read, draft creation, narrow label changes, and archive operations, with no send operation. The `gmail.modify` scope is the narrowest Google scope that still permits drafts and archiving, and it does not permit permanent deletion. The no-send guarantee is enforced by Cove's code, not by the credential.
- Calendar: read-only.
- Google Docs: read-only for explicitly configured sources.
- Meeting ingestion: disabled until a person creates and enables a live config.
  The recommended Granola source uses the read-only REST API. Its personal key
  is `COVE_GRANOLA_API_KEY` in the ignored mode-0600 `.env.local` file. The key
  is sent only in the Granola `Authorization` header and must never be logged.
  Missing keys disable only the Granola source. Expired or rejected keys make
  that source report `failed` without disabling the Gmail watcher.

Every Gmail mutation goes through a durable operation ledger and is finalized only after Gmail confirms it. Partial and failed runs appear in receipts and Issues.

## Model execution

Brief writing, progress reconciliation, and email classification send the relevant text (task text, email bodies, meeting notes, Git evidence) to the model providers, Anthropic and OpenAI, through their CLIs; that is the second place data leaves the Mac besides Google. The optional TypeSafe Jev judgments below would be a third, and the Groundwork research lane's web search a fourth. Prompt content, email text, documents, task text, Git evidence, and transcripts are untrusted data. The execution lanes have different controls; do not assume they all have the same isolation:

- The shared background runner validates structured output, bounds output and elapsed time, and starts Codex with a read-only filesystem sandbox. It inherits the operator's Codex configuration, but disables the inherited `1password` MCP server for each background call because connector startup can trigger repeated macOS App Data permission prompts. A bounded, read-only Codex configuration lookup first checks whether that server exists in the call's configuration home. Absent servers stay absent; an inconclusive lookup stops the call without exposing configuration contents. Other personal shell, app, and MCP capabilities remain inherited. A temporary working directory is not tool isolation. Research lanes intentionally request web access.
- The chief-of-staff driver supports the saved provider. Codex uses its own configuration home with explicit disabled tools; Claude uses bounded no-tool calls. Both use the same separate action validator.
- Claude workers pass lane-specific tool and MCP restrictions. Buddy's session seed disables model tools and inherited MCP, but does not explicitly disable user or project hooks.
- Selected Codex Buddy uses a separate configuration home, disabled shell/web/app tools, and the stdio `scripts/cove-buddy-mcp.ts` bridge. The bridge invokes the existing validated data CLI directly, without a shell. Its app URL must be explicit; it never defaults to the live server. Permanent deletion still requires an exact confirmation token. Native model text cannot mint a confirmed receipt. Provider switches do not transfer prior chat history. Same-provider compaction never transfers chat to a different provider. Live client capability acceptance is still required.

The September 4 review identified the shared-runner and session-seed gaps. The operator chose to document them and leave execution unchanged. These are configuration risks, not evidence of compromise. Do not describe all model subprocesses as tool-free or isolated until those paths have been hardened and verified.

## TypeSafe Jev judgments (optional, off by default)

Cove can ask TypeSafe's Jev model for small typed judgments (for example, who
owns a quoted promise, or whether two tasks describe the same work). The code
ships in `src/lib/jev/`, but nothing runs unless two things are both true:
`data/cove-jev.json` exists with `enabled: true` and at least one feature set
to `shadow` or `assist`, and `COVE_TYPESAFE_API_KEY` is present in the ignored
mode-0600 `.env.local`. A standard client install has neither, so no request
is ever made. There is no in-app switch; enabling it is an explicit operator
change to that file and that key.

When it is on, every call posts only the named evidence for that feature (for
example one email message plus one quoted sentence, or two task titles) to
`https://api.typesafe.ai/v1/systemone` over HTTPS with the key as a bearer
token. Redirects are refused, the endpoint cannot be changed by configuration,
requests are capped at 24 KiB and 32 questions, responses at 64 KiB, and every
attempt is recorded in the `cove_jev_attempts` table with hashes, references,
answers and token counts, never the evidence text or the key. Budgets (120
calls an hour, 800 a day, two at a time) and a breaker (five failures in ten
minutes pauses calls for five minutes; a rejected key disables calls until the
key changes) are enforced from that table. The key is never passed to Claude
or Codex child processes, which build their environment from an allowlist.

Shadow mode still sends data to TypeSafe. Confirm the account's retention and
client-data terms before enabling any feature against real mail or tasks.
Public TypeSafe documentation states customer inputs are not used for
training; it does not establish this account's retention setting. In v1 a
Jev answer may annotate, ask, or route a review; it never closes, merges,
suppresses or reorders anything on its own.

## Secrets

Never place secrets in Git, prompts, task descriptions, STATUS files, or client exports. Evidence sent to the progress-reconcile model passes through that lane's redactor. Supported secret storage is macOS Keychain or an ignored mode-0600 local environment file.

## External actions

Cove prepares drafts and proposals. Sending email, publishing, purchasing, changing repository visibility, and other public or hard-to-reverse actions remain explicit operator actions.


Codex task launches save conversations in the operator's desktop-visible Codex
home. They ignore personal config and project rules and explicitly disable apps,
web search, multi-agent tools and workspace network access. Cove does not modify
the personal configuration. Planning is read-only; Auto may edit the selected
workspace and output directory, with on-request approvals. The full saved brief
is sent as fenced context when the process starts. A task can override the saved
provider without changing the background agent settings.

Completed Codex sessions reopen through their native desktop URL. Cove does not
open a session while its headless child is running or still stopping. Older
sessions in Cove's isolated home keep their original terminal recovery path.
Desktop continuation is an operator-controlled session. This task path is
separate from the shared background Codex runner described above.

Native follow-through uses bounded calendar observations and task records, not
model judgment. It stores minimal meeting timing/title data, skips stale sources,
and sends only native banners. It does not enable text messaging or edit a
calendar. Notification timeout is an uncertain outcome, visible for review.

Buddy's selected Codex path retains read-only filesystem access and only Cove's
validated data MCP tool. It uses on-request approval with automatic review,
so tool calls can be reviewed instead of silently failing under `never`.
A denial is reported; there is no shell fallback. This configuration is separate
from the shared background runner whose isolation change was explicitly deferred.

## Optional Apple Reminders phone beta

Installation requires explicit consent for full macOS Reminders access. Apple
cannot scope that grant to one list. The helper narrows its own operations to
the selected writable iCloud Cove list and items linked to Cove task IDs. It
does not import or change other lists. User-facing notes contain useful context;
internal task IDs are carried in the approved conversation URL fragment.

LaunchServices starts the helper with its own privacy identity. Bounded JSON
requests and responses use private temporary files. A helper-owned native lock
serializes EventKit operations even if the launcher times out. Existing items
require exact ID and revision checks, while creation recovery uses the linked
task identity. A missing or moved reminder is not silently recreated.

The mobile connector uses only Cove's loopback API and keeps the CSRF token
inside the process. The six-tool allowlist does not grant shell, browser, email
sending or other external actions. Explicit user reminder preferences outrank
automatic judgments. Ordinary notifications and unconfirmed Urgent requests
must remain distinguishable in tool receipts and user-facing claims.
