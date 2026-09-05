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

Brief writing, progress reconciliation, and email classification send the relevant text (task text, email bodies, meeting notes, Git evidence) to the model providers, Anthropic and OpenAI, through their CLIs; that is the second place data leaves the Mac besides Google. Prompt content, email text, documents, task text, Git evidence, and transcripts are untrusted data. The execution lanes have different controls; do not assume they all have the same isolation:

- The shared background runner validates structured output, bounds output and elapsed time, and starts Codex with a read-only filesystem sandbox. It currently inherits the operator's Codex configuration and does not explicitly disable personal shell, app, or MCP capabilities. A temporary working directory is not tool isolation. Research lanes intentionally request web access.
- The chief-of-staff driver supports the saved provider. Codex uses its own configuration home with explicit disabled tools; Claude uses bounded no-tool calls. Both use the same separate action validator.
- Claude workers pass lane-specific tool and MCP restrictions. Buddy's session seed disables model tools and inherited MCP, but does not explicitly disable user or project hooks.
- Selected Codex Buddy uses a separate configuration home, disabled shell/web/app tools, and the stdio `scripts/cove-buddy-mcp.ts` bridge. The bridge invokes the existing validated data CLI directly, without a shell. Its app URL must be explicit; it never defaults to the live server. Permanent deletion still requires an exact confirmation token. Native model text cannot mint a confirmed receipt. Provider switches do not transfer prior chat history. Same-provider compaction never transfers chat to a different provider. Live client capability acceptance is still required.

The September 4 review identified the shared-runner and session-seed gaps. The operator chose to document them and leave execution unchanged. These are configuration risks, not evidence of compromise. Do not describe all model subprocesses as tool-free or isolated until those paths have been hardened and verified.

## Secrets

Never place secrets in Git, prompts, task descriptions, STATUS files, or client exports. Evidence sent to the progress-reconcile model passes through that lane's redactor. Supported secret storage is macOS Keychain or an ignored mode-0600 local environment file.

## External actions

Cove prepares drafts and proposals. Sending email, publishing, purchasing, changing repository visibility, and other public or hard-to-reverse actions remain explicit operator actions.


Selected Codex task work uses a separate configuration home with on-request
approvals, no inherited personal MCP/apps and no network-enabled workspace
shell. Planning is read-only; task work may edit its approved workspace and
output directory. Resume uses stored provider/model/session metadata and literal
shell quoting. Cove does not open an interactive resume while its headless
child is still stopping. This task path is separate from the unchanged shared
background Codex runner described above.

Native follow-through uses bounded calendar observations and task records, not
model judgment. It stores minimal meeting timing/title data, skips stale sources,
and sends only native banners. It does not enable text messaging or edit a
calendar. Notification timeout is an uncertain outcome, visible for review.

Buddy's selected Codex path retains read-only filesystem access and only Cove's
validated data MCP tool. It uses on-request approval with automatic review,
so tool calls can be reviewed instead of silently failing under `never`.
A denial is reported; there is no shell fallback. This configuration is separate
from the shared background runner whose isolation change was explicitly deferred.
