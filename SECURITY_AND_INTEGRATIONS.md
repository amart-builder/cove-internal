# Cove Security and Integrations

## Local access

Cove binds to `127.0.0.1:3200`. Mutation routes require the local request boundary plus Cove's CSRF token. The token is a bearer credential and must never be logged, committed, or sent to a remote host.

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

Brief writing, progress reconciliation, and email classification send the relevant text (task text, email bodies, meeting notes, Git evidence) to the model providers, Anthropic and OpenAI, through their CLIs; that is the second place data leaves the Mac besides Google. Prompt content, email text, documents, task text, Git evidence, and transcripts are untrusted data. Workers use structured output validation, bounded input and output, explicit tools, strict MCP isolation, private settings, minimal environment variables, spend limits, and timeouts. They cannot widen their own permissions.

## Secrets

Never place secrets in Git, prompts, task descriptions, STATUS files, or client exports. Evidence sent to the progress-reconcile model passes through that lane's redactor. Supported secret storage is macOS Keychain or an ignored mode-0600 local environment file.

## External actions

Cove prepares drafts and proposals. Sending email, publishing, purchasing, changing repository visibility, and other public or hard-to-reverse actions remain explicit operator actions.
