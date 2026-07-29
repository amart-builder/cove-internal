#!/usr/bin/env node
/**
 * Gemini meeting-note watcher.
 *
 * Matcher settings live in data/cove-meetings.json:
 * {
 *   "enabled": true,
 *   "query": "from:(gemini-noreply@google.com) OR subject:(\"Notes:\" OR \"Meeting notes\")",
 *   "window": "newer_than:2d",
 *   "processed_label": "Cove/Meeting-Processed"
 * }
 *
 * Edit that file if Google's sender or subject wording changes. The matcher is
 * intentionally configuration, not code. `--once --dry-run` reads Gmail and
 * parses matches but writes no labels, intake rows, commitments, state, or
 * heartbeat.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { promisify } from "node:util";
import {
  extractMeetingFollowUps,
  inboundAckState,
  isOperatorConfigured,
  isOperatorOwned,
  meetingFollowUpText,
} from "../src/lib/intake/meeting-followups.mjs";
import { coveConfigPath, coveEnv } from "../src/lib/env-runtime.mjs";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { recordEvent, resolveEvent } = require("../src/lib/intake/inbox.ts");
const { runForgeIntake } = require("../src/lib/intake/run.ts");
const { recordReceipt } = require("../src/lib/reliability/receipts.ts");

const execFileAsync = promisify(execFile);
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = coveEnv("DATA_DIR")?.trim() ||
  path.join(repoDir, "data");
const DEFAULT_CONFIG_PATH = coveConfigPath(defaultDataDir, "meetings.json");
const DEFAULT_EMAIL_CONFIG_PATH = coveConfigPath(defaultDataDir, "email.json");
const DEFAULT_STATE_PATH = path.join(defaultDataDir, "forge-meeting-state.json");
const DEFAULT_HEARTBEAT_PATH = path.join(defaultDataDir, "intake", "heartbeats.json");
const MAX_PROCESSED_IDS = 500;
const MAX_FAILURES = 500;
const MAX_DEAD_LETTERS = 50;
const DEAD_LETTER_AFTER = 5;
const MAX_GMAIL_PAGES = 10;

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
  const parsed = objectValue(readJson(file));
  if (
    typeof parsed?.enabled !== "boolean" ||
    typeof parsed.query !== "string" ||
    !parsed.query.trim() ||
    typeof parsed.window !== "string" ||
    !parsed.window.trim() ||
    typeof parsed.processed_label !== "string" ||
    !parsed.processed_label.trim()
  ) {
    throw new Error("cove-meetings.json is missing enabled, query, window, or processed_label.");
  }
  return {
    enabled: parsed.enabled,
    query: parsed.query.trim(),
    window: parsed.window.trim(),
    processedLabel: parsed.processed_label.trim(),
  };
}

function loadEmailConfig(file = DEFAULT_EMAIL_CONFIG_PATH) {
  const parsed = objectValue(readJson(file));
  if (typeof parsed?.account_email !== "string" || !parsed.account_email.trim()) {
    throw new Error("cove-email.json is missing account_email.");
  }
  return {
    accountEmail: parsed.account_email.trim(),
    forgeUrl: typeof parsed.forge_url === "string" && parsed.forge_url.trim()
      ? parsed.forge_url.trim().replace(/\/$/, "")
      : "http://127.0.0.1:3200",
    labels: objectValue(parsed.labels) ?? {},
  };
}

export function readMeetingState(file = DEFAULT_STATE_PATH) {
  const parsed = objectValue(readJson(file, {})) ?? {};
  const failures = objectValue(parsed.failures) ?? {};
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
  });
}

export function writeMeetingHeartbeat(file, heartbeat) {
  const current = objectValue(readJson(file, {})) ?? {};
  atomicJsonWrite(file, {
    ...current,
    meeting_watch: heartbeat,
  });
}

export function createComposioExecutor(options = {}) {
  const execImpl = options.execFileImpl
    ? promisify(options.execFileImpl)
    : execFileAsync;
  const executionDir = options.cwd ?? repoDir;
  return async (tool, params) => {
    try {
      const result = await execImpl(
        options.composioPath ?? "composio",
        ["execute", tool, "-d", JSON.stringify(params)],
        {
          cwd: executionDir,
          env: options.env ?? process.env,
          maxBuffer: 12 * 1024 * 1024,
          timeout: options.timeoutMs ?? 60_000,
        },
      );
      const stdout = typeof result === "string" ? result : result.stdout;
      let parsed = JSON.parse(stdout);
      const assertSuccessful = (value) => {
        if (value?.successful === false || value?.success === false) {
          throw new Error(
            `Composio ${tool} failed: ${JSON.stringify(value.error ?? value).slice(0, 500)}`,
          );
        }
      };
      assertSuccessful(parsed);
      if (parsed?.storedInFile) {
        if (
          typeof parsed.outputFilePath !== "string" ||
          !parsed.outputFilePath.trim()
        ) {
          throw new Error("Composio stored response omitted outputFilePath.");
        }
        const outputPath = path.isAbsolute(parsed.outputFilePath)
          ? parsed.outputFilePath
          : path.resolve(executionDir, parsed.outputFilePath);
        if (!existsSync(outputPath)) {
          throw new Error(`Composio output file does not exist: ${outputPath}`);
        }
        parsed = JSON.parse(readFileSync(outputPath, "utf8"));
        assertSuccessful(parsed);
      }
      return parsed?.data ?? parsed;
    } catch (error) {
      const wrapped = new Error(`Composio ${tool}: ${boundedError(error)}`);
      wrapped.composio = true;
      throw wrapped;
    }
  };
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

function nextPageToken(payload) {
  const row = objectValue(payload);
  const nested = objectValue(row?.data);
  const token = row?.nextPageToken ?? row?.next_page_token ??
    nested?.nextPageToken ?? nested?.next_page_token;
  return typeof token === "string" && token ? token : undefined;
}

function gmailMessage(value) {
  const row = objectValue(value);
  if (!row) return undefined;
  const id = row.id ?? row.message_id ?? row.messageId;
  const threadId = row.thread_id ?? row.threadId;
  if (typeof id !== "string" || !id) return undefined;
  return {
    id,
    threadId: typeof threadId === "string" && threadId ? threadId : id,
    subject: typeof row.subject === "string" ? row.subject : "",
    raw: row,
  };
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
  const rows = messageRows(payload);
  for (const candidate of rows) {
    const row = objectValue(candidate);
    if (typeof row?.subject === "string" && row.subject.trim()) {
      return row.subject.trim();
    }
  }
  return "Gemini meeting notes";
}

async function fetchMatchingMessages(composio, accountEmail, query) {
  const messages = [];
  const seenTokens = new Set();
  let pageToken;
  for (let page = 0; page < MAX_GMAIL_PAGES; page += 1) {
    const payload = await composio("GMAIL_FETCH_EMAILS", {
      user_id: accountEmail,
      query,
      verbose: true,
      include_payload: false,
      max_results: 100,
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    messages.push(...messageRows(payload).map(gmailMessage).filter(Boolean));
    const nextToken = nextPageToken(payload);
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

async function fetchMessageBody(composio, accountEmail, messageId) {
  return composio("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", {
    user_id: accountEmail,
    message_id: messageId,
    format: "full",
  });
}

async function processedLabelId(composio, emailConfig, labelName) {
  const cached = emailConfig.labels[labelName];
  if (typeof cached === "string" && cached) return cached;
  const listed = await composio("GMAIL_LIST_LABELS", {
    user_id: emailConfig.accountEmail,
  });
  const labels = arrayAt(listed, ["labels"]) ??
    arrayAt(listed, ["data", "labels"]) ??
    (Array.isArray(listed) ? listed : []);
  const existing = labels.find((value) => objectValue(value)?.name === labelName);
  const existingId = objectValue(existing)?.id;
  if (typeof existingId === "string" && existingId) return existingId;
  const created = await composio("GMAIL_CREATE_LABEL", {
    user_id: emailConfig.accountEmail,
    label_name: labelName,
  });
  const createdRow = objectValue(created);
  const id = createdRow?.id ?? objectValue(createdRow?.label)?.id ??
    objectValue(createdRow?.data)?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Could not resolve Gmail label id for ${labelName}.`);
  }
  return id;
}

async function applyProcessedLabel(composio, accountEmail, threadId, labelId) {
  await composio("GMAIL_MODIFY_THREAD_LABELS", {
    user_id: accountEmail,
    thread_id: threadId,
    add_label_ids: [labelId],
    remove_label_ids: [],
  });
}

function deterministicUuid(value) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function csrfToken(fetchImpl, baseUrl, timeoutMs) {
  const response = await fetchImpl(`${baseUrl}/api/day-plan`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`day_plan_token_${response.status}`);
  const payload = await response.json();
  if (typeof payload?.csrfToken !== "string" || !payload.csrfToken) {
    throw new Error("day_plan_token_missing");
  }
  return payload.csrfToken;
}

export async function writeWaitingCommitment(item, context, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.fetchTimeoutMs ?? 10_000;
  const id = deterministicUuid(`meeting-waiting:${context.sourceId}`);
  const lookup = await fetchImpl(
    `${context.baseUrl}/api/forge-rest/commitments?select=id&id=eq.${encodeURIComponent(id)}&limit=1`,
    { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
  );
  if (!lookup.ok) throw new Error(`forge-rest commitments lookup ${lookup.status}`);
  const rows = await lookup.json();
  if (Array.isArray(rows) && rows.length > 0) return id;
  const token = await csrfToken(fetchImpl, context.baseUrl, timeoutMs);
  const response = await fetchImpl(`${context.baseUrl}/api/forge-rest/commitments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forge-CSRF": token,
    },
    body: JSON.stringify({
      id,
      kind: "waiting_on",
      title: item.title,
      details: [
        item.detail,
        context.meetingTitle ? `Meeting: ${context.meetingTitle}` : "",
      ].filter(Boolean).join("\n") || null,
      counterparty: item.owner,
      contact_id: null,
      source_kind: "detector",
      source_quote: null,
      source_ref: `gmail:${context.sourceId}`,
      due_at: null,
      review_at: null,
      confidence: "high",
      confirmed: false,
      status: "open",
      evidence: null,
    }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    const retry = await fetchImpl(
      `${context.baseUrl}/api/forge-rest/commitments?select=id&id=eq.${encodeURIComponent(id)}&limit=1`,
      { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
    );
    if (retry.ok && (await retry.json()).length > 0) return id;
    throw new Error(`forge-rest commitments ${response.status}: ${body.slice(0, 300)}`);
  }
  return id;
}

export async function acknowledgeMeetingItem(item, context, options) {
  const text = meetingFollowUpText(item, context.meetingTitle);
  if (isOperatorOwned(item.owner)) {
    const result = await options.runIntakeImpl(
      {
        text,
        source: "meeting",
        sourceId: context.sourceId,
      },
      {
        repoDir: options.repoDir,
        dataDir: options.dataDir,
        fetchImpl: options.fetchImpl,
        webBaseUrl: context.baseUrl,
      },
    );
    const state = inboundAckState(result);
    if (result.exitCode !== 0 || state === "failed") {
      throw new Error(result.error ?? "Meeting intake did not acknowledge the event.");
    }
    return { kind: "task", ack: state };
  }
  const receipt = await options.recordEventImpl(
    {
      source: "meeting",
      sourceId: context.sourceId,
      rawText: text,
      machine: options.machine,
    },
    { dataDir: options.dataDir },
  );
  const state = inboundAckState(receipt);
  if (state === "failed") {
    throw new Error("Meeting intake could not write the database or spool.");
  }
  await options.writeCommitmentImpl(item, context, {
    fetchImpl: options.fetchImpl,
    fetchTimeoutMs: options.fetchTimeoutMs,
  });
  if (state === "db") {
    await options.resolveEventImpl(receipt.event.id, { state: "triaged" });
  }
  return { kind: "waiting_on", ack: state };
}

export async function runMeetingWatch(options = {}) {
  const now = options.now ?? (() => new Date());
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const emailConfigPath = options.emailConfigPath ?? DEFAULT_EMAIL_CONFIG_PATH;
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const heartbeatPath = options.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH;
  const dryRun = options.dryRun === true;
  let disabled = false;
  const composio = options.composio ?? createComposioExecutor({
    cwd: options.repoDir ?? repoDir,
  });
  const summary = {
    dry_run: dryRun,
    examined: 0,
    matched: 0,
    processed: 0,
    parsed_items: 0,
    // With no operator name configured, ownership routing cannot distinguish
    // own items from waiting-on ones, so everything lands in the task lane.
    // The flag lets the brief say so instead of quietly overstating the split.
    operator_unconfigured: !isOperatorConfigured(),
    operator_owned: 0,
    waiting_on: 0,
    zero_item_messages: 0,
    dead_letters: 0,
    errors: 0,
    error_messages: [],
  };
  const heartbeat = () => ({
    last_run_at: now().toISOString(),
    examined: summary.examined,
    matched: summary.matched,
    processed: summary.processed,
    errors: summary.errors,
    dead_letters: summary.dead_letters,
    disabled,
  });

  try {
    const config = loadMeetingConfig(configPath);
    const state = readMeetingState(statePath);
    summary.dead_letters = state.dead_letters.length;
    if (!config.enabled) {
      disabled = true;
      if (!dryRun) writeMeetingHeartbeat(heartbeatPath, heartbeat());
      return { exitCode: 0, summary };
    }
    const emailConfig = loadEmailConfig(emailConfigPath);
    const processed = new Set(state.processed_ids);
    const failures = { ...state.failures };
    let deadLetters = [...state.dead_letters];
    const deadLetterIds = new Set(
      deadLetters.map((entry) => entry.message_id),
    );
    const persistState = () => writeMeetingState(statePath, {
      processed_ids: [...processed],
      cursor_at: now().toISOString(),
      failures,
      dead_letters: deadLetters,
    });
    const processedLabelQuery = config.processedLabel.replace(/["\\]/g, "\\$&");
    const query =
      `(${config.query}) ${config.window} -label:"${processedLabelQuery}"`;
    const messages = await fetchMatchingMessages(
      composio,
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
        raw: {},
      });
    }
    summary.examined = messages.length;
    const candidates = messages.filter((message) =>
      !processed.has(message.id) && !deadLetterIds.has(message.id)
    );
    summary.matched = candidates.length;
    let labelId;
    let composioFailed = false;

    for (const message of candidates) {
      let zeroItems = false;
      try {
        const priorFailure = objectValue(failures[message.id]);
        let meetingTitle = message.subject || "Gemini meeting notes";
        let items;
        if (priorFailure?.zero_items === true) {
          items = [];
        } else {
          const fetchedMessage = await fetchMessageBody(
            composio,
            emailConfig.accountEmail,
            message.id,
          );
          const body = bodyFromThread(fetchedMessage);
          meetingTitle = titleFromThread(message, fetchedMessage);
          items = await (options.extractFollowUps ?? extractMeetingFollowUps)(
            body,
            {
              repoDir: options.repoDir ?? repoDir,
              fallback: options.fallback,
            },
          );
        }
        if (!Array.isArray(items)) {
          throw new Error("Meeting parser returned an invalid result.");
        }
        summary.parsed_items += items.length;
        zeroItems = items.length === 0;
        if (zeroItems) summary.zero_item_messages += 1;
        summary.operator_owned += items.filter((item) => isOperatorOwned(item.owner)).length;
        summary.waiting_on += items.filter((item) => !isOperatorOwned(item.owner)).length;

        if (dryRun) continue;
        for (let index = 0; index < items.length; index += 1) {
          const sourceId = `${message.id}:${index}`;
          await acknowledgeMeetingItem(
            items[index],
            {
              sourceId,
              meetingTitle,
              gmailMessageId: message.id,
              baseUrl: emailConfig.forgeUrl,
            },
            {
              repoDir: options.repoDir ?? repoDir,
              dataDir: options.dataDir ?? defaultDataDir,
              fetchImpl: options.fetchImpl ?? fetch,
              fetchTimeoutMs: options.fetchTimeoutMs ?? 10_000,
              recordEventImpl: options.recordEventImpl ?? recordEvent,
              resolveEventImpl: options.resolveEventImpl ?? resolveEvent,
              runIntakeImpl: options.runIntakeImpl ?? runForgeIntake,
              writeCommitmentImpl: options.writeCommitmentImpl ?? writeWaitingCommitment,
              machine: options.machine,
            },
          );
        }

        labelId ??= await processedLabelId(
          composio,
          emailConfig,
          config.processedLabel,
        );
        await (options.applyLabel ?? applyProcessedLabel)(
          composio,
          emailConfig.accountEmail,
          message.threadId,
          labelId,
        );
        processed.add(message.id);
        delete failures[message.id];
        persistState();
        summary.processed += 1;
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
                subject: message.subject,
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
              subject: message.subject,
              zero_items: zeroItems,
            };
          }
          summary.dead_letters = deadLetters.length;
          persistState();
        }
        if (error?.composio === true) {
          composioFailed = true;
          break;
        }
      }
    }

    if (!dryRun) {
      persistState();
      writeMeetingHeartbeat(heartbeatPath, heartbeat());
    }
    return { exitCode: composioFailed ? 1 : 0, summary };
  } catch (error) {
    summary.errors += 1;
    summary.error_messages.push({ error: boundedError(error) });
    if (!dryRun) {
      try {
        writeMeetingHeartbeat(heartbeatPath, heartbeat());
      } catch (heartbeatError) {
        summary.error_messages.push({
          error: `heartbeat: ${boundedError(heartbeatError)}`,
        });
      }
    }
    return { exitCode: 1, summary };
  }
}

export async function main(args = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  const unknown = args.filter((arg) => arg !== "--once" && arg !== "--dry-run");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown[0]}\n`);
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const result = await runMeetingWatch({ dryRun });
  if (!dryRun) {
    const outcome = result.exitCode !== 0
      ? "failed"
      : result.summary.errors > 0
        ? "partial"
        : "success";
    try {
      recordReceipt({
        dbPath: coveEnv("DB_PATH")?.trim() || path.join(defaultDataDir, "forge.db"),
        source: "meeting-watch",
        startedAt,
        summary: outcome === "success"
          ? `Meeting notes processed ${result.summary.processed} message(s).`
          : `Meeting notes processing finished with ${result.summary.errors} error(s).`,
        actions: result.summary,
        retryCount: 0,
        outcome,
      });
    } catch (error) {
      process.stderr.write(`Could not record meeting receipt: ${boundedError(error)}\n`);
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
