#!/usr/bin/env node
/**
 * Granola API and meeting-note Gmail watcher.
 *
 * Matcher settings live in the operator's data/cove-meetings.json (falling
 * back to data/forge-meetings.json on pre-rename installs):
 * {
 *   "enabled": true,
 *   "query": "from:(gemini-noreply@google.com) OR subject:(\"Notes:\" OR \"Meeting notes\")",
 *   "window": "newer_than:4d",
 *   "processed_label": "Cove/Meeting-Processed"
 * }
 *
 * Granola notes and known Gmail tool patterns feed one shared envelope parser.
 * `--once --dry-run` reads Gmail and
 * parses matches but writes no labels, intake rows, commitments, state, or
 * heartbeat.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMeetingFollowUps,
  isOperatorConfigured,
  isOperatorOwned,
} from "../src/lib/intake/meeting-followups.mjs";
import {
  coveConfigPath,
  coveEnv,
  coveEnvTrimmed,
} from "../src/lib/env-runtime.mjs";
import {
  checkLaneOwnership,
  laneOwnerLabel,
} from "./lib/cove-lane-ownership.mjs";
import { loadLocalEnv } from "./lib/load-local-env.mjs";
import { normalizeMachineIdentity } from "../src/lib/machine-identity.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(repoDir);
const require = createRequire(import.meta.url);
require("tsx/cjs");
const {
  detectMeetingNotes,
  isNotificationOnlyMeetingMessage,
  loadMeetingDetectionConfig,
} = require("../src/lib/intake/meeting-detection.ts");
const {
  processMeetingNotesEmail,
  writeWaitingCommitment,
} = require("../src/lib/intake/meeting-pipeline.ts");
const {
  MEETING_FRAGMENT_BODY_THRESHOLD,
  meetingAnalystEnabled,
  parseMeetingEnvelope,
  queueMeetingNotesEmail,
  runMeetingAnalysisSweep,
} = require("../src/lib/intake/meeting-analysis.ts");
const { assertWebBaseMatchesDatabase } = require("../src/lib/intake/task-writer.ts");
const {
  createGranolaClient,
  granolaNoteHasSummary,
  granolaNoteRevisionHash,
  granolaNoteToMeetingInput,
} = require("../src/lib/intake/granola-source.ts");
const {
  recordFailure,
} = require("../src/lib/reliability/failures.ts");
const {
  recordReceipt,
} = require("../src/lib/reliability/receipts.ts");
const {
  createGoogleWorkspaceGateway,
} = require("../src/lib/workspace/google/gateway.ts");

const defaultDataDir = coveEnv("DATA_DIR")?.trim() ||
  path.join(repoDir, "data");
const DEFAULT_CONFIG_PATH = coveConfigPath(defaultDataDir, "meetings.json");
const DEFAULT_EMAIL_CONFIG_PATH = path.join(defaultDataDir, "cove-workspace.json");
const DEFAULT_STATE_PATH = path.join(defaultDataDir, "cove-meeting-state.json");
const DEFAULT_HEARTBEAT_PATH = path.join(defaultDataDir, "intake", "heartbeats.json");
const MAX_PROCESSED_IDS = 500;
const MAX_FAILURES = 500;
const MAX_DEAD_LETTERS = 50;
const DEAD_LETTER_AFTER = 5;
const MAX_GMAIL_PAGES = 10;
export const MAX_GRANOLA_PAGES = 20;
const MAX_GRANOLA_REVISIONS = 500;
const GRANOLA_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const GRANOLA_LOOKBACK_MS = 10 * 60_000;
const GRANOLA_INITIAL_WINDOW_MS = 4 * 24 * 60 * 60_000;
const GRANOLA_NOTIFICATION_RECEIPT =
  "granola notification skipped; notes come from the Granola API";
const NOTIFICATION_STUB_RECEIPT =
  "meeting notification skipped; message contained no meeting notes";

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function boundedError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined && !existsSync(file)) return fallback;
    throw error;
  }
}

function atomicJsonWrite(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

export function loadMeetingConfig(file = DEFAULT_CONFIG_PATH) {
  return loadMeetingDetectionConfig(file);
}

export function loadEmailConfig(file = DEFAULT_EMAIL_CONFIG_PATH) {
  const parsed = objectValue(readJson(file));
  if (
    parsed?.provider !== "google-api" ||
    typeof parsed?.account_email !== "string" ||
    !parsed.account_email.trim()
  ) {
    throw new Error("cove-workspace.json is missing a connected Google account.");
  }
  return {
    accountEmail: parsed.account_email.trim(),
    coveUrl: coveEnvTrimmed("BRIEF_WEB_BASE") ?? (typeof parsed.cove_url === "string" && parsed.cove_url.trim()
      ? parsed.cove_url.trim().replace(/\/$/, "")
      : "http://127.0.0.1:3200"),
  };
}

export function readMeetingState(file = DEFAULT_STATE_PATH) {
  const parsed = objectValue(readJson(file, {})) ?? {};
  const failures = objectValue(parsed.failures) ?? {};
  const granola = objectValue(parsed.granola) ?? {};
  const revisions = objectValue(granola.revisions) ?? {};
  const granolaFailures = objectValue(granola.failures) ?? {};
  return {
    processed_ids: Array.isArray(parsed.processed_ids)
      ? parsed.processed_ids.filter((id) => typeof id === "string").slice(-MAX_PROCESSED_IDS)
      : [],
    cursor_at: typeof parsed.cursor_at === "string" ? parsed.cursor_at : null,
    failures: Object.fromEntries(
      Object.entries(failures)
        .filter(([, value]) => {
          const row = objectValue(value);
          return Number.isInteger(row?.failed_runs) && row.failed_runs > 0;
        })
        .slice(-MAX_FAILURES),
    ),
    dead_letters: Array.isArray(parsed.dead_letters)
      ? parsed.dead_letters
        .filter((value) => {
          const row = objectValue(value);
          return typeof row?.message_id === "string" && row.message_id;
        })
        .slice(-MAX_DEAD_LETTERS)
      : [],
    granola: {
      watermark_at: typeof granola.watermark_at === "string"
        ? granola.watermark_at
        : null,
      list_cursor: typeof granola.list_cursor === "string"
        ? granola.list_cursor
        : null,
      pending_note_ids: Array.isArray(granola.pending_note_ids)
        ? [...new Set(granola.pending_note_ids.filter((id) =>
            typeof id === "string" && id.trim()
          ))]
        : [],
      revisions: Object.fromEntries(Object.entries(revisions).filter(
        ([id, hash]) => Boolean(id.trim()) && typeof hash === "string" && hash,
      ).slice(-MAX_GRANOLA_REVISIONS)),
      failures: Object.fromEntries(
        Object.entries(granolaFailures)
          .filter(([, value]) => {
            const row = objectValue(value);
            return Number.isInteger(row?.failed_runs) && row.failed_runs > 0;
          })
          .slice(-MAX_FAILURES),
      ),
      dead_letters: Array.isArray(granola.dead_letters)
        ? granola.dead_letters
          .filter((value) => {
            const row = objectValue(value);
            return typeof row?.note_id === "string" && row.note_id;
          })
          .slice(-MAX_DEAD_LETTERS)
        : [],
    },
  };
}

export function writeMeetingState(file, state) {
  const processed = [];
  const seen = new Set();
  for (const id of state.processed_ids ?? []) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    processed.push(id);
  }
  atomicJsonWrite(file, {
    processed_ids: processed.slice(-MAX_PROCESSED_IDS),
    cursor_at: state.cursor_at ?? null,
    failures: Object.fromEntries(
      Object.entries(state.failures ?? {}).slice(-MAX_FAILURES),
    ),
    dead_letters: (state.dead_letters ?? []).slice(-MAX_DEAD_LETTERS),
    granola: {
      watermark_at: state.granola?.watermark_at ?? null,
      list_cursor: state.granola?.list_cursor ?? null,
      pending_note_ids: [...new Set(state.granola?.pending_note_ids ?? [])],
      revisions: Object.fromEntries(
        Object.entries(state.granola?.revisions ?? {}).slice(-MAX_GRANOLA_REVISIONS),
      ),
      failures: Object.fromEntries(
        Object.entries(state.granola?.failures ?? {}).slice(-MAX_FAILURES),
      ),
      dead_letters: (state.granola?.dead_letters ?? []).slice(-MAX_DEAD_LETTERS),
    },
  });
}

export function writeMeetingHeartbeat(file, heartbeat, identity) {
  const machineIdentity = normalizeMachineIdentity(identity);
  const current = objectValue(readJson(file, {})) ?? {};
  const machines = { ...(objectValue(current.machines) ?? {}) };
  const machine = { ...(objectValue(machines[machineIdentity.id]) ?? {}) };
  machine.hostname = machineIdentity.hostname;
  machine.meeting_watch = heartbeat;
  machines[machineIdentity.id] = machine;
  atomicJsonWrite(file, {
    ...current,
    version: 2,
    machines,
  });
}

function arrayAt(value, keys) {
  let current = value;
  for (const key of keys) current = objectValue(current)?.[key];
  return Array.isArray(current) ? current : undefined;
}

function messageRows(payload) {
  return (Array.isArray(payload) ? payload : undefined) ??
    arrayAt(payload, ["messages"]) ??
    arrayAt(payload, ["items"]) ??
    arrayAt(payload, ["emails"]) ??
    arrayAt(payload, ["data", "messages"]) ??
    arrayAt(payload, ["data", "items"]) ??
    [];
}

function decodeBase64Url(value) {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      .toString("utf8");
  } catch {
    return "";
  }
}

function collectBodies(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) collectBodies(item, found);
    return found;
  }
  const row = value;
  for (
    const key of [
      "body",
      "text",
      "plain_text",
      "textPlain",
      "message_text",
      "messageText",
      "body_text",
      "decoded_body",
      "content",
    ]
  ) {
    if (typeof row[key] === "string" && row[key].trim()) {
      found.push(row[key].trim());
    }
  }
  if (typeof row.data === "string" && row.data.trim()) {
    const decoded = decodeBase64Url(row.data);
    if (decoded.trim()) found.push(decoded.trim());
  }
  for (const key of ["messages", "payload", "parts", "data", "email"]) {
    if (row[key] && typeof row[key] === "object") collectBodies(row[key], found);
  }
  return found;
}

function bodyFromThread(payload) {
  const bodies = collectBodies(payload);
  const unique = [...new Set(bodies)];
  const heading =
    /(?:^|\n)\s*(?:(?:suggested\s+)?next steps|action items)\s*:?\s*(?:\n|$)/i;
  const plain = unique.find((body) => heading.test(body));
  const selected = plain ?? unique.sort((a, b) => b.length - a.length)[0];
  if (!selected) throw new Error("Gmail thread contained no readable meeting-note body.");
  return selected
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(?:br|\/li|\/p|div|\/div|tr|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromThread(message, payload) {
  if (message.subject.trim()) return message.subject.trim();
  const nested = nestedHeader(payload, ["subject"]);
  if (nested) return nested;
  const rows = messageRows(payload);
  for (const candidate of rows) {
    const row = objectValue(candidate);
    if (typeof row?.subject === "string" && row.subject.trim()) {
      return row.subject.trim();
    }
  }
  return "Meeting notes";
}

function senderFromThread(message, payload) {
  if (typeof message.sender === "string" && message.sender.trim()) {
    return message.sender.trim();
  }
  const nested = nestedHeader(
    payload,
    ["sender", "from", "sender_email", "senderEmail"],
  );
  if (nested) return nested;
  const rows = messageRows(payload);
  for (const candidate of rows) {
    const row = objectValue(candidate);
    for (const key of ["sender", "from", "sender_email", "senderEmail"]) {
      if (typeof row?.[key] === "string" && row[key].trim()) {
        return row[key].trim();
      }
    }
  }
  return "";
}

function nestedHeader(value, keys, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const header = objectValue(item);
      const name = typeof header?.name === "string"
        ? header.name.trim().toLowerCase()
        : "";
      if (
        (name === "from" || name === "subject") &&
        typeof header?.value === "string" &&
        keys.some((key) => key.toLowerCase() === name)
      ) {
        return header.value.trim();
      }
      const found = nestedHeader(item, keys, seen);
      if (found) return found;
    }
    return "";
  }
  const row = objectValue(value);
  for (const key of keys) {
    if (typeof row?.[key] === "string" && row[key].trim()) {
      return row[key].trim();
    }
  }
  for (const key of ["data", "email", "message", "payload", "preview", "headers"]) {
    const found = nestedHeader(row?.[key], keys, seen);
    if (found) return found;
  }
  return "";
}

function mailHeader(message, name) {
  return message.headers?.find(
    (entry) => entry.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? "";
}

async function fetchMatchingMessages(mail, _accountEmail, query) {
  const messages = [];
  const seenTokens = new Set();
  let pageToken;
  for (let page = 0; page < MAX_GMAIL_PAGES; page += 1) {
    const payload = await mail.listMessages({
      query,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const listed of payload.messages) {
      const message = await mail.getMessage({
        messageId: listed.id,
        format: "metadata",
      });
      messages.push({
        id: message.id,
        threadId: message.threadId,
        sender: mailHeader(message, "From"),
        subject: mailHeader(message, "Subject"),
        raw: message,
      });
    }
    const nextToken = payload.nextPageToken;
    if (!nextToken) {
      pageToken = undefined;
      break;
    }
    if (seenTokens.has(nextToken)) {
      throw new Error("Gmail pagination repeated a page token.");
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
    if (page === MAX_GMAIL_PAGES - 1) {
      throw new Error(`Gmail pagination exceeded ${MAX_GMAIL_PAGES} pages.`);
    }
  }
  const unique = new Map();
  for (const message of messages) unique.set(message.id, message);
  return [...unique.values()];
}

async function fetchMessageBody(mail, _accountEmail, messageId) {
  const message = await mail.getMessage({
    messageId,
    format: "full",
  });
  return {
    id: message.id,
    threadId: message.threadId,
    body: message.text,
    headers: message.headers,
    internalDate: message.internalDate,
    sender: mailHeader(message, "From"),
    subject: mailHeader(message, "Subject"),
  };
}

async function processedLabelId(mail, _emailConfig, labelName) {
  return (await mail.ensureCoveLabel({ name: labelName })).name;
}

async function applyProcessedLabel(mail, _accountEmail, threadId, labelName) {
  await mail.modifyThreadLabels({
    threadId,
    addNames: [labelName],
  });
}

function logArchiveFailure(options, messageId, error) {
  const line = `Meeting watcher could not archive ${messageId}: ${boundedError(error)}`;
  try {
    if (options.logArchiveFailure) options.logArchiveFailure(line);
    else process.stderr.write(`${line}\n`);
  } catch {
    // Archiving and its diagnostic are both best-effort after durable ingestion.
  }
}

export { writeWaitingCommitment };

function granolaOwnerAllowed(owner, ownerEmails) {
  if (ownerEmails.length === 0) return true;
  const email = typeof owner?.email === "string"
    ? owner.email.trim().toLowerCase()
    : "";
  return ownerEmails.includes(email);
}

function noteIsPendingExpired(note, now) {
  const createdAt = Date.parse(note.created_at);
  return !Number.isFinite(createdAt) ||
    now.getTime() - createdAt > GRANOLA_PENDING_MAX_AGE_MS;
}

export async function runGranolaPoll(options) {
  const polledAt = options.now();
  const result = {
    status: "disabled",
    last_poll_at: polledAt.toISOString(),
    notes_seen: 0,
    notes_queued: 0,
    notes_pending: 0,
    notes_failed: 0,
    notes_dead_lettered: 0,
    notes_skipped_owner: 0,
    revisions_ignored: 0,
    error: null,
  };
  if (!options.enabled || !options.apiKey) {
    return { heartbeat: result, state: options.state };
  }
  result.status = "ok";
  const client = options.client ?? createGranolaClient({
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: options.baseUrl,
  });
  const working = {
    watermark_at: options.state.watermark_at,
    list_cursor: options.state.list_cursor,
    pending_note_ids: [...new Set(options.state.pending_note_ids)],
    revisions: Object.fromEntries(
      Object.entries(options.state.revisions).slice(-MAX_GRANOLA_REVISIONS),
    ),
    failures: Object.fromEntries(
      Object.entries(options.state.failures ?? {}).slice(-MAX_FAILURES),
    ),
    dead_letters: [...(options.state.dead_letters ?? [])].slice(-MAX_DEAD_LETTERS),
  };
  const watermarkTime = working.watermark_at
    ? Date.parse(working.watermark_at) - GRANOLA_LOOKBACK_MS
    : polledAt.getTime() - GRANOLA_INITIAL_WINDOW_MS;
  const updatedAfter = new Date(watermarkTime).toISOString();
  const summaries = new Map();
  const seenIds = new Set();
  const cursors = new Set();
  let cursor = working.list_cursor ?? undefined;
  let walkComplete = false;
  try {
    for (let pageNumber = 0; pageNumber < MAX_GRANOLA_PAGES; pageNumber += 1) {
      if (cursor) {
        if (cursors.has(cursor)) throw new Error("Granola pagination repeated a cursor.");
        cursors.add(cursor);
      }
      const page = await client.listNotes({
        updatedAfter,
        pageSize: 30,
        ...(cursor ? { cursor } : {}),
      });
      for (const note of page.notes) {
        seenIds.add(note.id);
        summaries.set(note.id, note);
      }
      if (!page.hasMore) {
        working.list_cursor = null;
        walkComplete = true;
        break;
      }
      cursor = page.cursor;
      working.list_cursor = cursor;
      working.pending_note_ids = [...new Set([
        ...working.pending_note_ids,
        ...summaries.keys(),
      ])];
      if (!options.dryRun && options.persistProgress) {
        options.persistProgress(working);
      }
    }
  } catch (error) {
    if (!options.dryRun && options.persistProgress) {
      options.persistProgress(options.state);
    }
    if (error && typeof error === "object") error.granolaState = options.state;
    throw error;
  }

  if (!walkComplete) {
    result.notes_seen = seenIds.size;
    result.notes_pending = working.pending_note_ids.length;
    result.notes_dead_lettered = working.dead_letters.length;
    result.note = `Granola page cap reached at ${MAX_GRANOLA_PAGES} pages; the walk will resume next poll.`;
    return { heartbeat: result, state: working };
  }

  const pending = new Set(working.pending_note_ids);
  const deadLetterIds = new Set(working.dead_letters.map((entry) => entry.note_id));
  const candidateIds = new Set(pending);
  for (const note of summaries.values()) {
    if (deadLetterIds.has(note.id)) {
      pending.delete(note.id);
      continue;
    }
    if (!granolaOwnerAllowed(note.owner, options.ownerEmails)) {
      result.notes_skipped_owner += 1;
      pending.delete(note.id);
      delete working.failures[note.id];
      continue;
    }
    candidateIds.add(note.id);
  }

  const deadLetter = (noteId, failedRuns, error) => {
    delete working.failures[noteId];
    pending.delete(noteId);
    working.dead_letters = [
      ...working.dead_letters.filter((entry) => entry.note_id !== noteId),
      {
        note_id: noteId,
        failed_runs: failedRuns,
        last_error: boundedError(error),
        dead_lettered_at: options.now().toISOString(),
      },
    ].slice(-MAX_DEAD_LETTERS);
    deadLetterIds.add(noteId);
  };
  const failNote = (noteId, error, immediate = false) => {
    result.notes_failed += 1;
    const previous = objectValue(working.failures[noteId]);
    const failedRuns = (Number.isInteger(previous?.failed_runs)
      ? previous.failed_runs
      : 0) + 1;
    if (immediate || failedRuns >= DEAD_LETTER_AFTER) {
      deadLetter(noteId, failedRuns, error);
      return;
    }
    delete working.failures[noteId];
    working.failures[noteId] = {
      failed_runs: failedRuns,
      last_error: boundedError(error),
      last_failed_at: options.now().toISOString(),
    };
    pending.add(noteId);
  };

  for (const noteId of candidateIds) {
    if (deadLetterIds.has(noteId)) continue;
    const summary = summaries.get(noteId);
    if (summary && !granolaOwnerAllowed(summary.owner, options.ownerEmails)) continue;
    if (pending.has(noteId) && summary && noteIsPendingExpired(summary, polledAt)) {
      pending.delete(noteId);
      delete working.failures[noteId];
      continue;
    }
    try {
      const note = await client.getNote(noteId);
      seenIds.add(note.id);
      if (!granolaOwnerAllowed(note.owner, options.ownerEmails)) {
        if (!summary) result.notes_skipped_owner += 1;
        pending.delete(note.id);
        delete working.failures[note.id];
        continue;
      }
      if (pending.has(note.id) && noteIsPendingExpired(note, polledAt)) {
        pending.delete(note.id);
        delete working.failures[note.id];
        continue;
      }
      if (!granolaNoteHasSummary(note)) {
        if (noteIsPendingExpired(note, polledAt)) {
          pending.delete(note.id);
          delete working.failures[note.id];
        } else {
          pending.add(note.id);
        }
        continue;
      }
      const revisionHash = granolaNoteRevisionHash(note);
      const priorRevision = working.revisions[note.id];
      if (priorRevision) {
        if (priorRevision !== revisionHash) result.revisions_ignored += 1;
        pending.delete(note.id);
        delete working.failures[note.id];
        continue;
      }
      const input = granolaNoteToMeetingInput(note);
      if (options.dryRun) continue;
      const queued = await options.queueMeetingEmail(input, {
        sourceDoor: "watcher",
        dbPath: options.dbPath,
        now: options.now,
      });
      if (
        queued.status === "processed" ||
        (queued.status === "skipped" && queued.reason === "already-processed")
      ) {
        delete working.revisions[note.id];
        working.revisions[note.id] = revisionHash;
        working.revisions = Object.fromEntries(
          Object.entries(working.revisions).slice(-MAX_GRANOLA_REVISIONS),
        );
        pending.delete(note.id);
        delete working.failures[note.id];
        if (queued.status === "processed") result.notes_queued += 1;
      } else if (queued.status === "skipped" && queued.reason === "lease-active") {
        pending.add(note.id);
      } else if (queued.status === "skipped" && queued.reason === "already-failed") {
        failNote(note.id, "meeting queue reported already-failed", true);
      } else {
        failNote(
          note.id,
          queued.status === "skipped"
            ? `meeting queue reported ${queued.reason ?? "skipped"}`
            : "meeting queue did not process the note",
        );
      }
    } catch (error) {
      failNote(noteId, error);
    }
  }
  result.notes_seen = seenIds.size;

  if (!options.dryRun) {
    working.pending_note_ids = [...pending];
    working.watermark_at = polledAt.toISOString();
    working.list_cursor = null;
  }
  working.failures = Object.fromEntries(
    Object.entries(working.failures).slice(-MAX_FAILURES),
  );
  result.notes_pending = pending.size;
  result.notes_dead_lettered = working.dead_letters.length;
  return { heartbeat: result, state: working };
}

export async function runMeetingAnalysisDrain(options = {}) {
  const now = options.now ?? (() => new Date());
  const runtimeDataDir = options.dataDir ?? defaultDataDir;
  const dbPath = options.dbPath ||
    coveEnvTrimmed("DB_PATH") ||
    path.join(runtimeDataDir, "cove.db");
  const explicitBaseUrl = options.baseUrl ?? coveEnvTrimmed("BRIEF_WEB_BASE");
  assertWebBaseMatchesDatabase({ webBaseUrl: explicitBaseUrl, dbPath });
  const baseUrl = explicitBaseUrl ?? "http://127.0.0.1:3200";
  return (options.runMeetingAnalysisSweepImpl ?? runMeetingAnalysisSweep)({
    dbPath,
    dataDir: runtimeDataDir,
    baseUrl,
    ...(options.mail ? { mail: options.mail } : {}),
    now,
    fetchImpl: options.fetchImpl ?? fetch,
    fetchTimeoutMs: options.fetchTimeoutMs ?? 10_000,
    runJobImpl: options.runJobImpl,
    crmBackend: options.crmBackend,
    legacyFallback: options.legacyFallback ?? (async (envelope) => {
      await processMeetingNotesEmail({
        messageId: envelope.gmailMessageId,
        threadId: envelope.threadId,
        sender: envelope.sender,
        subject: envelope.title,
        body: envelope.body,
        detectedTool: envelope.tool,
        receivedAt: envelope.receivedAt,
      }, {
        sourceDoor: options.sourceDoor ?? "watcher",
        dbPath,
        repoDir: options.repoDir ?? repoDir,
        dataDir: runtimeDataDir,
        baseUrl,
        now,
        fetchImpl: options.fetchImpl ?? fetch,
        fetchTimeoutMs: options.fetchTimeoutMs ?? 10_000,
        extractFollowUps: options.extractFollowUps,
        runIntakeImpl: options.runIntakeImpl,
        recordEventImpl: options.recordEventImpl,
        resolveEventImpl: options.resolveEventImpl,
        writeCommitmentImpl: options.writeCommitmentImpl,
        crmBackend: options.crmBackend,
        machine: options.machine,
      });
    }),
  });
}

export async function runMeetingWatch(options = {}) {
  const now = options.now ?? (() => new Date());
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const emailConfigPath = options.emailConfigPath ?? DEFAULT_EMAIL_CONFIG_PATH;
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const heartbeatPath = options.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH;
  const runtimeDataDir = options.dataDir ?? path.dirname(configPath);
  const dbPath = options.dbPath ||
    coveEnvTrimmed("DB_PATH") ||
    path.join(runtimeDataDir, "cove.db");
  const dryRun = options.dryRun === true;
  let disabled = false;
  let machineIdentity = options.machineIdentity
    ? normalizeMachineIdentity(options.machineIdentity)
    : undefined;
  const summary = {
    dry_run: dryRun,
    examined: 0,
    matched: 0,
    processed: 0,
    processed_message_ids: [],
    quiet_lines: [],
    parsed_items: 0,
    // With no operator name configured, ownership routing cannot distinguish
    // own items from waiting-on ones, so everything lands in the task lane.
    // The flag lets the brief say so instead of quietly overstating the split.
    operator_unconfigured: !isOperatorConfigured(),
    operator_owned: 0,
    waiting_on: 0,
    zero_item_messages: 0,
    detection_gaps: 0,
    dead_letters: 0,
    errors: 0,
    error_messages: [],
    standing_down: false,
    standing_down_owner: null,
  };
  let granolaHeartbeat = {
    status: "disabled",
    last_poll_at: now().toISOString(),
    notes_seen: 0,
    notes_queued: 0,
    notes_pending: 0,
    notes_failed: 0,
    notes_dead_lettered: 0,
    notes_skipped_owner: 0,
    revisions_ignored: 0,
    error: null,
  };
  const heartbeat = () => ({
    last_run_at: now().toISOString(),
    examined: summary.examined,
    matched: summary.matched,
    processed: summary.processed,
    detection_gaps: summary.detection_gaps,
    errors: summary.errors,
    dead_letters: summary.dead_letters,
    disabled,
    granola: granolaHeartbeat,
    ...(summary.standing_down
      ? {
          standing_down: true,
          standing_down_owner: summary.standing_down_owner,
        }
      : {}),
  });

  try {
    const ownership = checkLaneOwnership({
      dataDir: runtimeDataDir,
      lane: "meeting_watch",
      identity: machineIdentity,
      homeDir: options.homeDir,
    });
    machineIdentity = ownership.identity;
    if (!ownership.shouldRun) {
      const ownerLabel = laneOwnerLabel(ownership.owner);
      summary.standing_down = true;
      summary.standing_down_owner = ownerLabel;
      if (!dryRun) {
        writeMeetingHeartbeat(heartbeatPath, {
          standing_down: true,
          owner_id: ownership.owner.id,
          owner_hostname_at_claim: ownership.owner.hostnameAtClaim,
          observed_at: now().toISOString(),
        }, machineIdentity);
      }
      return { exitCode: 0, summary };
    }
    const state = readMeetingState(statePath);
    summary.dead_letters = state.dead_letters.length;
    if (!existsSync(configPath)) {
      disabled = true;
      if (!dryRun) writeMeetingHeartbeat(heartbeatPath, heartbeat(), machineIdentity);
      return { exitCode: 0, summary };
    }
    const config = loadMeetingConfig(configPath);
    if (!config.enabled) {
      disabled = true;
      if (!dryRun) writeMeetingHeartbeat(heartbeatPath, heartbeat(), machineIdentity);
      return { exitCode: 0, summary };
    }
    const mail = options.gateway ??
      createGoogleWorkspaceGateway({ dataDir: runtimeDataDir }).mail;
    const analystEnabled = options.meetingAnalystEnabled ?? meetingAnalystEnabled();
    const emailConfig = loadEmailConfig(emailConfigPath);
    const processed = new Set(state.processed_ids);
    const failures = { ...state.failures };
    let deadLetters = [...state.dead_letters];
    let granolaState = state.granola;
    const deadLetterIds = new Set(
      deadLetters.map((entry) => entry.message_id),
    );
    const persistState = (nextGranolaState = granolaState) => writeMeetingState(statePath, {
      processed_ids: [...processed],
      cursor_at: now().toISOString(),
      failures,
      dead_letters: deadLetters,
      granola: nextGranolaState,
    });
    const granolaApiKey = options.granolaApiKey ??
      coveEnvTrimmed("GRANOLA_API_KEY");
    const granolaApiActive = config.granola.enabled &&
      typeof granolaApiKey === "string" && Boolean(granolaApiKey.trim());
    if (granolaApiActive) {
      try {
        const granolaPoll = await runGranolaPoll({
          enabled: true,
          apiKey: granolaApiKey,
          ownerEmails: config.granola.ownerEmails,
          state: granolaState,
          dbPath,
          now,
          dryRun,
          fetchImpl: options.granolaFetchImpl ?? options.fetchImpl ?? fetch,
          baseUrl: options.granolaBaseUrl,
          client: options.granolaClient,
          queueMeetingEmail: options.queueGranolaMeetingEmail ?? queueMeetingNotesEmail,
          persistProgress: (progress) => persistState(progress),
        });
        granolaHeartbeat = granolaPoll.heartbeat;
        if (!dryRun) {
          granolaState = granolaPoll.state;
          persistState();
        }
      } catch (error) {
        const failedGranolaState = objectValue(error?.granolaState) ?? {
          ...granolaState,
          list_cursor: null,
        };
        granolaHeartbeat = {
          status: "failed",
          last_poll_at: now().toISOString(),
          notes_seen: 0,
          notes_queued: 0,
          notes_pending: failedGranolaState.pending_note_ids?.length ?? 0,
          notes_failed: 0,
          notes_dead_lettered: failedGranolaState.dead_letters?.length ?? 0,
          notes_skipped_owner: 0,
          revisions_ignored: 0,
          error: boundedError(error),
        };
        summary.errors += 1;
        summary.error_messages.push({
          source: "granola",
          error: granolaHeartbeat.error,
        });
        if (!dryRun) {
          granolaState = failedGranolaState;
          persistState();
        }
      }
    } else {
      granolaHeartbeat = {
        ...granolaHeartbeat,
        last_poll_at: now().toISOString(),
      };
    }
    const processedLabelQuery = config.processedLabel.replace(/["\\]/g, "\\$&");
    const query =
      `(${config.query}) ${config.window} -label:"${processedLabelQuery}"`;
    const messages = await fetchMatchingMessages(
      mail,
      emailConfig.accountEmail,
      query,
    );
    const knownMessageIds = new Set(messages.map((message) => message.id));
    for (const [messageId, value] of Object.entries(failures)) {
      if (
        knownMessageIds.has(messageId) ||
        processed.has(messageId) ||
        deadLetterIds.has(messageId)
      ) {
        continue;
      }
      const failure = objectValue(value);
      messages.push({
        id: messageId,
        threadId: typeof failure?.thread_id === "string"
          ? failure.thread_id
          : messageId,
        subject: typeof failure?.subject === "string" ? failure.subject : "",
        sender: typeof failure?.sender === "string" ? failure.sender : "",
        raw: {},
      });
    }
    summary.examined = messages.length;
    const candidates = messages.filter((message) =>
      !processed.has(message.id) && !deadLetterIds.has(message.id)
    );
    let labelId;
    let workspaceFailed = false;

    for (const message of candidates) {
      let zeroItems = false;
      let observedSender = message.sender ?? "";
      let observedSubject = message.subject ?? "";
      try {
        const priorFailure = objectValue(failures[message.id]);
        const fetchedMessage = await fetchMessageBody(
          mail,
          emailConfig.accountEmail,
          message.id,
        );
        const meetingTitle = titleFromThread(message, fetchedMessage);
        observedSubject = meetingTitle;
        const sender = senderFromThread(message, fetchedMessage);
        observedSender = sender;
        let body;
        try {
          body = bodyFromThread(fetchedMessage);
        } catch (error) {
          if (!isNotificationOnlyMeetingMessage({ sender, subject: meetingTitle })) {
            throw error;
          }
          body = "";
        }
        const detection = detectMeetingNotes(
          { sender, subject: meetingTitle },
          config,
        );
        if (!detection.matched || !detection.tool) {
          summary.detection_gaps += 1;
          if (!dryRun) {
            recordFailure({
              dbPath,
              source: "detection-gap",
              sourceId: message.id,
              message: `Meeting query matched but the detector did not: ${meetingTitle}.`,
              details: {
                messageId: message.id,
                threadId: message.threadId,
                sender,
                subject: meetingTitle,
              },
              occurredAt: now().toISOString(),
            });
            processed.add(message.id);
            delete failures[message.id];
            persistState();
          }
          continue;
        }
        summary.matched += 1;

        const skipReceipt = detection.tool === "granola" && granolaApiActive
          ? GRANOLA_NOTIFICATION_RECEIPT
          : body.length < MEETING_FRAGMENT_BODY_THRESHOLD &&
              isNotificationOnlyMeetingMessage({ sender, subject: meetingTitle })
            ? NOTIFICATION_STUB_RECEIPT
            : null;
        if (skipReceipt) {
          if (!dryRun) {
            labelId ??= await processedLabelId(
              mail,
              emailConfig,
              config.processedLabel,
            );
            await (options.applyLabel ?? applyProcessedLabel)(
              mail,
              emailConfig.accountEmail,
              message.threadId,
              labelId,
            );
            try {
              await mail.archiveMessages({ messageIds: [message.id] });
            } catch (error) {
              logArchiveFailure(options, message.id, error);
            }
            (options.recordSkipReceiptImpl ?? recordReceipt)({
              dbPath,
              source: "meeting-watch",
              startedAt: now().toISOString(),
              summary: skipReceipt,
              actions: {
                messageId: message.id,
                threadId: message.threadId,
                detectedTool: detection.tool,
              },
              outcome: "skipped",
              surfaceFailure: false,
            });
            processed.add(message.id);
            delete failures[message.id];
            persistState();
            summary.processed += 1;
            summary.processed_message_ids.push(message.id);
            summary.quiet_lines.push(skipReceipt);
          }
          continue;
        }

        if (dryRun) {
          if (analystEnabled) {
            parseMeetingEnvelope({
              messageId: message.id,
              threadId: message.threadId,
              detectedTool: detection.tool,
              subject: meetingTitle,
              body,
              sender,
              headers: fetchedMessage.headers,
              receivedAt: fetchedMessage.internalDate ?? undefined,
            });
          }
          const items = priorFailure?.zero_items === true
            ? []
            : await (options.extractFollowUps ?? extractMeetingFollowUps)(
              body,
              {
                repoDir: options.repoDir ?? repoDir,
                fallback: options.fallback,
              },
            );
          if (!Array.isArray(items)) {
            throw new Error("Meeting parser returned an invalid result.");
          }
          summary.parsed_items += items.length;
          zeroItems = items.length === 0;
          if (zeroItems) summary.zero_item_messages += 1;
          summary.operator_owned += items.filter((item) =>
            isOperatorOwned(item.owner)
          ).length;
          summary.waiting_on += items.filter((item) =>
            !isOperatorOwned(item.owner)
          ).length;
          continue;
        }

        const processMeeting = analystEnabled
          ? options.queueMeetingEmail ?? options.processMeetingEmail ?? queueMeetingNotesEmail
          : options.processMeetingEmail ?? processMeetingNotesEmail;
        const pipeline = await processMeeting(
          {
            messageId: message.id,
            threadId: message.threadId,
            sender,
            subject: meetingTitle,
            body,
            detectedTool: detection.tool,
            headers: fetchedMessage.headers,
            receivedAt: fetchedMessage.internalDate ?? undefined,
          },
          {
            sourceDoor: options.sourceDoor ??
              (coveEnv("MEETING_SOURCE_DOOR") === "triage"
                ? "triage"
                : "watcher"),
            dbPath,
            repoDir: options.repoDir ?? repoDir,
            dataDir: runtimeDataDir,
            baseUrl: emailConfig.coveUrl,
            now,
            fetchImpl: options.fetchImpl ?? fetch,
            fetchTimeoutMs: options.fetchTimeoutMs ?? 10_000,
            extractFollowUps: priorFailure?.zero_items === true
              ? async () => []
              : options.extractFollowUps
                ? (text, extractionOptions) =>
                  options.extractFollowUps(text, {
                    ...extractionOptions,
                    fallback: options.fallback,
                  })
                : undefined,
            runIntakeImpl: options.runIntakeImpl,
            recordEventImpl: options.recordEventImpl,
            resolveEventImpl: options.resolveEventImpl,
            writeCommitmentImpl: options.writeCommitmentImpl,
            crmBackend: options.crmBackend,
            machine: options.machine,
          },
        );
        summary.parsed_items += pipeline.summary.parsedItems;
        summary.operator_owned += pipeline.summary.tasks;
        summary.waiting_on += pipeline.summary.waitingOn;
        if (
          pipeline.status === "skipped" &&
          (pipeline.reason === "lease-active" ||
            pipeline.reason === "already-failed")
        ) {
          continue;
        }
        if (pipeline.status === "processed") {
          zeroItems = pipeline.summary.parsedItems === 0;
          if (zeroItems) {
            summary.zero_item_messages += 1;
          }
          if (pipeline.quietLine) {
            summary.quiet_lines.push(pipeline.quietLine);
          }
        }

        labelId ??= await processedLabelId(
          mail,
          emailConfig,
          config.processedLabel,
        );
        await (options.applyLabel ?? applyProcessedLabel)(
          mail,
          emailConfig.accountEmail,
          message.threadId,
          labelId,
        );
        try {
          await mail.archiveMessages({ messageIds: [message.id] });
        } catch (error) {
          logArchiveFailure(options, message.id, error);
        }
        processed.add(message.id);
        delete failures[message.id];
        persistState();
        summary.processed += 1;
        summary.processed_message_ids.push(message.id);
      } catch (error) {
        summary.errors += 1;
        summary.error_messages.push({
          message_id: message.id,
          error: boundedError(error),
        });
        if (!dryRun) {
          const previous = objectValue(failures[message.id]);
          const failedRuns = (
            Number.isInteger(previous?.failed_runs)
              ? previous.failed_runs
              : 0
          ) + 1;
          if (failedRuns >= DEAD_LETTER_AFTER) {
            delete failures[message.id];
            deadLetters = [
              ...deadLetters.filter((entry) => entry.message_id !== message.id),
              {
                message_id: message.id,
                thread_id: message.threadId,
                subject: observedSubject,
                sender: observedSender,
                failed_runs: failedRuns,
                last_error: boundedError(error),
                dead_lettered_at: now().toISOString(),
              },
            ].slice(-MAX_DEAD_LETTERS);
            deadLetterIds.add(message.id);
          } else {
            delete failures[message.id];
            failures[message.id] = {
              failed_runs: failedRuns,
              last_error: boundedError(error),
              last_failed_at: now().toISOString(),
              thread_id: message.threadId,
              subject: observedSubject,
              sender: observedSender,
              zero_items: zeroItems,
            };
          }
          summary.dead_letters = deadLetters.length;
          persistState();
        }
        if (error?.name === "WorkspaceGatewayError") {
          workspaceFailed = true;
          break;
        }
      }
    }

    if (!dryRun && analystEnabled) {
      const sweep = await runMeetingAnalysisDrain({
        dbPath,
        dataDir: runtimeDataDir,
        baseUrl: emailConfig.coveUrl,
        mail,
        now,
        fetchImpl: options.fetchImpl ?? fetch,
        fetchTimeoutMs: options.fetchTimeoutMs ?? 10_000,
        runMeetingAnalysisSweepImpl: options.runMeetingAnalysisSweepImpl,
        runJobImpl: options.runJobImpl,
        crmBackend: options.crmBackend,
        extractFollowUps: options.extractFollowUps,
        runIntakeImpl: options.runIntakeImpl,
        recordEventImpl: options.recordEventImpl,
        resolveEventImpl: options.resolveEventImpl,
        writeCommitmentImpl: options.writeCommitmentImpl,
        machine: options.machine,
      });
      if (sweep.failed || sweep.dead) {
        summary.errors += sweep.failed + sweep.dead;
        summary.error_messages.push({
          error: `Meeting analysis jobs failed=${sweep.failed} dead=${sweep.dead}.`,
        });
      }
    }

    if (!dryRun) {
      persistState();
      writeMeetingHeartbeat(heartbeatPath, heartbeat(), machineIdentity);
    }
    return { exitCode: workspaceFailed ? 1 : 0, summary };
  } catch (error) {
    summary.errors += 1;
    summary.error_messages.push({ error: boundedError(error) });
    if (!dryRun) {
      try {
        if (machineIdentity) {
          writeMeetingHeartbeat(heartbeatPath, heartbeat(), machineIdentity);
        }
      } catch (heartbeatError) {
        summary.error_messages.push({
          error: `heartbeat: ${boundedError(heartbeatError)}`,
        });
      }
    }
    return { exitCode: 1, summary };
  }
}

// What the person reads on the Issues screen when a pass does not finish.
//
// recordReceipt stores `failureMessage ?? summary`, so whatever this returns
// replaces the sentence written above it. It used to return every entry's
// boundedError joined with "; " -- the thrown message, verbatim -- so a
// Granola outage or a locked database was printed to the person on the screen
// Cove uses to tell them something needs them. The diagnostics are already
// kept in the receipt's actions.errorMessages, which is where whoever has to
// fix it looks.
//
// One string is forwarded rather than replaced. reliability/failures.ts
// recognises "Meeting analysis jobs failed=N dead=M." and turns it into a
// sentence about reviews that did not finish. Restating that sentence here
// would be a second copy of it, and two copies is how copy drifts.
const MEETING_JOB_SWEEP = /^Meeting analysis jobs failed=\d+ dead=\d+\.$/;

function meetingWatchFailureMessage(entries) {
  const errors = (entries ?? []).map((entry) => entry.error).filter(Boolean);
  if (errors.length === 0) return "Meeting watcher run failed.";
  if (errors.every((error) => MEETING_JOB_SWEEP.test(error))) return errors[0];
  return "Cove could not finish reading some of your meeting notes on this pass. " +
    "It keeps checking, and anything it already read is saved. If this keeps " +
    "appearing, ask your Cove setup agent to look at the details on this item.";
}

export function shouldRecordMeetingWatchReceipt(summary) {
  return summary.processed !== 0 || summary.errors !== 0;
}

export async function main(args = process.argv.slice(2), options = {}) {
  const unknown = args.filter((arg) =>
    arg !== "--once" && arg !== "--dry-run" && arg !== "--drain-only"
  );
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown[0]}\n`);
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const drainOnly = args.includes("--drain-only");
  if (drainOnly) {
    if (dryRun) {
      process.stderr.write("--drain-only cannot be combined with --dry-run.\n");
      return 2;
    }
    try {
      const result = await (
        options.runMeetingAnalysisDrainImpl ?? runMeetingAnalysisDrain
      )(options.runOptions ?? {});
      if (result.processed || result.failed || result.dead) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
      return 0;
    } catch (error) {
      process.stderr.write(`Meeting analysis drain failed: ${boundedError(error)}\n`);
      return 1;
    }
  }
  const startedAt = new Date().toISOString();
  const result = await (options.runMeetingWatchImpl ?? runMeetingWatch)({
    ...(options.runOptions ?? {}),
    dryRun,
  });
  if (!dryRun && shouldRecordMeetingWatchReceipt(result.summary)) {
    const outcome = result.exitCode !== 0
      ? "failed"
      : result.summary.errors > 0
        ? "partial"
        : "success";
    try {
      (options.recordRunReceiptImpl ?? recordReceipt)({
        dbPath: options.dbPath ||
          coveEnvTrimmed("DB_PATH") ||
          path.join(defaultDataDir, "cove.db"),
        source: "meeting-watch",
        startedAt,
        summary: outcome === "success"
          ? `Meeting notes processed ${result.summary.processed} message(s).`
          : `Meeting notes processing finished with ${result.summary.errors} error(s).`,
        actions: {
          ...result.summary,
          errorMessages: result.summary.error_messages,
        },
        outcome,
        failureKey: "meeting-watch-run",
        failureMessage: meetingWatchFailureMessage(result.summary.error_messages),
      });
    } catch (error) {
      result.summary.error_messages.push({
        error: `run receipt: ${boundedError(error)}`,
      });
    }
  }
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
  return result.exitCode;
}

if (
  process.argv[1] &&
  realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
