# Cove Configuration

The default is local SQLite with no account or cloud database. Configuration is read from `.env.local`, `COVE_*` environment variables rendered into LaunchAgents, ignored files under `data/`, and macOS Keychain.

The sales pipeline is owner-only and stays off unless both `COVE_SALES_PIPELINE=1` and `NEXT_PUBLIC_COVE_SALES_PIPELINE=1` are set in `.env.local`, followed by a rebuild. Full installs with saved agent settings default the chief-of-staff lanes on. They require the selected CLI and a nonempty private `data/cove-mandate.md`. `COVE_CHIEF_OF_STAFF=0` disables them; installs without saved settings retain the older explicit opt-in.

## Core paths and runtime

| Setting | Purpose | Default |
| --- | --- | --- |
| `COVE_DATA_DIR` | Private runtime data | `<repo>/data` |
| `COVE_DB_PATH` | SQLite database override | `<data>/cove.db` |
| `COVE_BRIEF_WEB_BASE` | Explicit HTTP loopback origin for the selected local database and server | installer saves `http://127.0.0.1:3200` |
| `COVE_CLAUDE_BIN` | Claude CLI path | discovered from PATH |
| `COVE_CODEX_BIN` | Codex CLI path for background model jobs | discovered from PATH |
| `COVE_CLAUDE_WORKER_ENABLED` | Enable supervised background execution | installer-managed |
| `COVE_BRIEF_TIMEZONE` | Morning Brief target timezone | operator timezone |
| `COVE_JOB_RUNNER` | Legacy background backend when no saved agent selection exists: `codex-sol-high` or `claude` | `codex-sol-high` |
| `COVE_MEETING_ANALYST` | Deep meeting analysis workflow. Set to `0` or `off` to use legacy extraction wholesale | on |
| `COVE_VOICE_FINGERPRINT_PATH` | Measured writing fingerprint appended to the email voice guide | unset |
| `COVE_VOICE_REVIEW` | Enable the Sunday draft-outcome review when set to `1` | off |
| `COVE_VOICE_JUDGE` | Measure each generated draft against the fingerprint when set to `1` | off |

A non-default data directory or database requires an explicit matching
`COVE_BRIEF_WEB_BASE` before task-writing CLI or background lanes can run. The
installer preserves a configured loopback origin (including its port), uses it
for the server, and saves the resolved database paths and origin in `.env.local`
for restart and direct CLI consistency. It also renders that pairing into all
installed lanes. A standalone scratch database without an explicit web base
still fails closed. `COVE_BRIEF_WEB_BASE` takes precedence over the meeting
watcher's older `cove-workspace.json` `cove_url`; on upgrade the installer adopts that older explicit loopback value
when the shared setting is absent. That file value is a fallback
only when no explicit environment origin is configured. Non-loopback origins,
HTTPS, paths, credentials, queries and fragments are rejected by the local
installer because its server binds only a local HTTP endpoint.

Saved `agent-settings.json` selects the provider, exact model and effort for
standard model jobs and takes precedence over environment-based model selection.
Without that file, `COVE_JOB_RUNNER` selects the legacy background backend.
Older installs may still set `COVE_BRIEF_WRITER`, `COVE_DUMP_WRITER`, or their
`FORGE_*` aliases as legacy per-lane overrides when `COVE_JOB_RUNNER` is absent. The
installer does not emit those older per-lane variables.

Email voice settings may also live in private `data/cove-email.json`. That file
may already exist with other keys on an older install; add these keys to it
rather than replacing it:

```json
{
  "voiceFingerprintPath": null,
  "voiceReview": {
    "enabled": false,
    "judgeEnabled": false
  }
}
```

The environment values above override this file. The per-draft judge only
records a score and short verdict. It never edits a draft, but it does run
inline during triage: each drafted email waits up to 90 seconds for its score
before the draft is enqueued, so a triage batch with N drafts can take up to
N x 90s longer with the judge on. The weekly
review writes proposals under `data/voice-reviews/` and creates a board task;
it never changes the fingerprint or writing corpus automatically.

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

## Jev typed judgments (off by default)

Jev is TypeSafe's System One model. Cove can ask it small closed questions about
an email, about the tasks and waiting-on rows a meeting produced, or about
whether an email delivers something Cove is already waiting on, and record the
answers beside the ones its own models already gave. It is off on every install
and changes nothing the operator sees.

Three things must all be true before a single request is sent. The mode must not
be `off`, the feature must be named, and a credential must be in the
environment. A credential on its own switches nothing on.

To turn a lane on, rather than editing the file by hand:

```
node scripts/cove-jev.mjs enable emailTriage waitingResolution
node scripts/cove-jev.mjs disable
```

`enable` sets the mode to shadow and the named flags, and refuses a feature name
it does not recognise, because the reader treats anything that is not exactly
`true` as off and a typo would otherwise look enabled. `disable` with no feature
named sets the mode to off, which stops every lane in one command. The flags are
left as they were, so turning it back on does not mean naming them all again.
Neither command touches the credential.

`data/cove-jev.json`:

```json
{"mode":"shadow","features":{"emailTriage":true,"commitmentAudit":true,"meetingAudit":true,"waitingResolution":true}}
```

| Setting | Meaning | Default |
| --- | --- | --- |
| `mode` | `off`, `shadow` (record only), or `assist` (annotate an existing owner's work) | `off` |
| `features.emailTriage` | Ask for the bucket, urgency, money-out and needs-reply judgments | off |
| `features.commitmentAudit` | Ask whether a grounded quote is really an obligation, and whose | off |
| `features.meetingAudit` | Ask whether each task and waiting-on row a meeting produced is supported by the notes, still outstanding, agreed rather than floated, and owed by who the analyst said | off |
| `features.waitingResolution` | Ask whether an inbound email delivers, or ends the need for, a waiting-on commitment Cove already holds open against that sender | off |
| `model` | Pinned model id. Do not use a moving alias with tuned thresholds | `jev-1.13.0` |
| `limits.attemptsPerHour` | Calls per rolling hour, read from the ledger | 120 |
| `limits.attemptsPerDay` | Calls per rolling day | 800 |
| `limits.dailySpendUsd` | Cove's own reservation ceiling, not an invoice guarantee | 1 |
| `limits.maxConcurrent` | Calls in flight at once | 2 |
| `assessmentRetentionDays` | Days of per-answer detail kept | 30 |
| `usageRetentionDays` | Days of usage and outcome metadata kept | 90 |

| Variable | Meaning | Default |
| --- | --- | --- |
| `COVE_TYPESAFE_API_KEY` | TypeSafe credential. Put it in `.env.local` yourself | unset |
| `COVE_JEV_MODE` | Overrides `mode` for one run | file value |
| `COVE_JEV_EMAIL_TRIAGE` | `1` or `0`, overrides the feature for one run | file value |
| `COVE_JEV_COMMITMENT_AUDIT` | `1` or `0`, overrides the feature for one run | file value |
| `COVE_JEV_MEETING_AUDIT` | `1` or `0`, overrides the feature for one run | file value |
| `COVE_JEV_WAITING_RESOLUTION` | `1` or `0`, overrides the feature for one run | file value |

The key is read from the environment only. It is never written to
`cove-jev.json`, never passed to a Claude or Codex child process, and is
redacted from error text before it reaches a log or the failure inbox.

`node scripts/cove-jev.mjs status` prints the mode, which features are on,
whether a credential is present, the last day's calls and reserved spend, and
whether the breaker is open. `node scripts/cove-jev.mjs report` prints how often
Jev agreed with Cove's own classifier, where it did not, and how the reported
probability tracked that agreement.

`node scripts/cove-jev.mjs waiting` is the waiting lane's own readout, and is
scored differently because nothing in Cove answers that question today. Instead
of agreement it reports what the operator did afterwards: of the commitments Jev
read as settled, how many they went on to close, how long after, and which are
still sitting open. A commitment still open after Jev read the thing as
delivered may mean Jev was wrong, or may mean the operator has not got to it,
which is the case the lane exists to catch. The default window is 30 days
because outcomes take longer to accumulate than agreement does.

`node scripts/cove-jev-eval.mjs prepare` builds the exact request Cove would
send for every committed case and prints it, reading no credential and making no
network call. Read that before deciding what Cove is allowed to send. `run`
scores the dev split against frozen labels and refuses the held-out split. Both
take `--lane email` (the default) or `--lane meeting`.

### What each lane sends, and the decision that gates it

Shadow mode still sends text to a third party, which is the one place Cove
leaves the machine. The two lanes are not the same decision and should not be
turned on with one:

- `emailTriage` and `commitmentAudit` send one email at a time: the account
  address, the sender, the subject and the body, truncated at 6,000 characters.
- `meetingAudit` sends the meeting title, the attendee names, up to 6,000
  characters of the notes, and the analyst's own wording for each item it is
  asking about. A transcript is a longer and more sensitive artefact than an
  email, and it carries the words of people who were not asked.
- `waitingResolution` rides in the same request as the email lanes and adds the
  title and detail of each open waiting-on commitment for that sender, up to
  six. It never runs when identity is ambiguous or Cove records could not load,
  which is the same fail-closed rule drafting follows.

Nothing else goes: no goals, no operator profile, no CRM history, no voice guide.
Decide the source scope for each lane and confirm the retention terms before
turning either on. TypeSafe's published terms say customer data is not used for
training; retention is not zero without an enterprise agreement.

## Compatibility

`FORGE_*` names are accepted only for migration from older installations. New documentation, scripts, and configuration must use `COVE_*`. Supabase, Convex, and multi-machine relay settings are not part of the supported single-Mac product.


## Selected agent and background usage (client-readiness development)

`data/agent-settings.json` is an explicit selection for shared bounded model jobs
and the chief of staff, Buddy conversation/replan, and task sessions. Without this
file, existing lane settings remain active.
The saved primary is the default for new tasks. `providers` optionally maps
`claude` and/or `codex` to their verified `{provider, model, effort}` selection.
Older files register only their saved primary. Unconnected task choices are
disabled and rejected by the task manager. CLI presence is not verification.
Current supported selection fields are `version: 1`, `provider: "claude"` or
`"codex"`, the exact `model` ID, and `effort: "low"`, `"medium"` or `"high"`.
`backgroundLimits` can override the provisional limits: `callsPerHour: 12`,
`callsPerDay: 96`, `callsPerWeek: 400`, `inputBytesPerCall: 96000`,
`outputBytesPerCall: 64000`, `timeoutMs: 120000`. A provider/model mismatch or invalid limit
stops jobs instead of silently choosing another model.

For development acceptance, `node scripts/cove-agent-settings.mjs configure
--provider claude` verifies Fable 5.1/low; `--provider codex` verifies Astra/low.
Use `--model` and `--effort` for an explicitly chosen supported alternative.
Verification makes a real CLI model call. Sign into the intended subscription
first and verify the CLI's billing mode. No service is installed or restarted.
`connect --provider claude|codex` verifies an additional provider and preserves
this primary. `primary --provider claude|codex` switches to an already verified
selection without changing its exact model, effort, or background limits.
Buddy uses `agent status` and `agent primary --provider claude|codex` through
its existing data tool and the local CSRF-protected `/api/agent-settings` route.
Use primary changes only on explicit user request. New tasks and subsequent
chief/Buddy turns pick up the preference; running task sessions retain their
original provider. Both connected providers can run separate tasks concurrently.
Model verification records past access, not a guarantee that a subscription
has not expired; launch failures remain visible.

`node scripts/cove-agent-settings.mjs status` prints the saved selection and local
usage. The Issues page shows rolling call usage. Model availability is verified
only at configuration time; revoked access becomes a visible job failure.

Call limits apply independently to two pools: daily planning (Morning Brief and
closeout) and background review (including the chief). Neither pool can consume
the other's allowance. Routine background work leaves a quarter of its pool for
chief reviews. Existing saved limits remain explicit; upgrading code alone does
not replace them.

Daily planning is exempt from the small per-call input and output limits and uses
its own writing timeout. Source selection and freshness rules still apply, as do
schema/evidence validation and a 4 MiB technical response boundary. Codex progress
output is drained separately from its final brief. This is not a brief-length
instruction. Chief reviews retain the chief driver's fifteen-minute timeout
(or an explicit caller override), while retaining background call and byte limits.
Other background jobs retain all their per-call limits.

These limits cover the shared runner and selected-provider chief, including
manually requested jobs through those paths. They do not yet cover interactive
Buddy/task sessions or every legacy subprocess. Client acceptance still requires
real selected-model outputs and supervised installation checks. Output
byte limits constrain received data; they are not a hard cap on hidden reasoning
tokens. Cove does not know the remaining provider subscription allowance.

Buddy uses the exact selected model and effort, including Claude recovery
calls. Codex Buddy uses a separate `data/buddy-codex-home`, the operator's auth
file through a symlink, and only Cove's validated MCP data tool. It has no
general shell, web search, or app tools. Permanent deletion keeps the existing
confirmation-token requirement. Changing providers starts a new model
conversation; earlier chat is not transferred. Saved Cove tasks remain available
through the data tool. Both providers have same-provider context compaction.
Codex sign-in recovery opens the local CLI login and checks its status.

Interactive Buddy runs retain the five-minute execution timeout and have a
4 MiB received-output ceiling. They are not charged to the background call caps.
The turn audit stores `provider`, exact `model_id`, and `cost_known`; Codex dollar
cost is unknown, not zero. Existing aggregate cost fields sum reported costs
only. Task sessions and Buddy-spawned sessions keep provider-specific native
heads. Codex uses `data/task-codex-home`, on-request approvals, and interactive
Terminal resume. A stopping task must exit before it can be resumed.


### Native follow-through

Saved-agent Full installs enable lightweight minute checks without model calls.
`COVE_FOLLOW_THROUGH=0` disables them (set it for Basic Mode). The reminder worker
loads `.env.local`, including custom data/database paths. It checks connected
Calendar at most once every five minutes; failed or older-than-ten-minute
observations never authorize meeting banners. Cancelled, declined, all-day and
already-started events do not produce prep banners.

Advance warnings run at 3pm the day before a date-only deadline, or within one
hour of a timed deadline. Explicit `remind_at` retains the existing nudge lane.
Task notification preferences and recent engagement are respected. Overdue
follow-through uses shared cooldowns and notification caps. New native checks
respect 8am to 6pm in the profile timezone. Explicit due reminders retain their
existing timing contract. Calendar access remains a separately authorized
connection.

Your follow-through (linked from Today) and Issues > On your radar show
freshness, pending notices, missed or uncertain delivery, acknowledgement and
one-hour snooze. Ordinary banners reserve two of the existing six daily slots
for meetings or urgent email, with a separate slot kept for the noon floor. Snooze can repeat a notice only while it is still relevant;
it cannot replay a meeting after its start. An interrupted or timed-out handoff
stays uncertain instead of being silently retried. Ordinary explicit reminders
continue if this additional checker fails. No service can notify while the Mac
is asleep or powered off.


The retired day-plan execution queue remains a Claude compatibility path.
Saved Codex configurations reject queued legacy execution instead of invoking
Claude. Use the current task Planning/Auto controls for either provider. Briefs,
dumps, enabled groundwork, email and meeting jobs use the shared selected runner.

## Optional Apple Reminders phone beta

This personal beta is not enabled by the standard installer. Its private
`data/apple-reminders.json` must contain `enabled`, `allowAgentJudgment`, the
exact iCloud Cove `calendarId`, operator `timezone`, loopback `appUrl`, approved
`conversationUrl`, absolute `stateDir` and the installed app's `helperPath`.
Discover those values on the person's Mac. Do not reuse another person's file.

Automatic judgments default to two per target day, routine daytime hours of
8am to 9pm, and a six-hour repeat guard. Explicit reminder requests are exempt
from the automatic budget. Existing explicit reminders cannot be changed by
agent judgment. The model chooses whether an interruption is useful; a task's
priority alone does not decide. `urgentAlarmSupported` remains false with the
current public EventKit API. An `alarm_pending` result means an ordinary
notification was scheduled and the Urgent switch still needs a manual step.

The phone MCP process uses `COVE_MOBILE_APP_URL`, `COVE_MOBILE_STATE_DIR` and
`COVE_MOBILE_DATA_DIR`. It receives only the six named Cove tools, no shell or
browser. Real task context reaches the selected model provider only with the
operator's consent. Runtime configuration changes require restarting that MCP
process; preserve the existing saved conversation ID when resuming the chat.
