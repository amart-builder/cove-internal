#!/usr/bin/env node
/**
 * Meeting-note Gmail watcher.
 *
 * Matcher settings live in the operator's data/cove-meetings.json (falling
 * back to data/forge-meetings.json on pre-rename installs):
 * {
 *   "enabled": true,
 *   "query": "from:(gemini-noreply@google.com) OR subject:(\"Notes:\" OR \"Meeting notes\")",
 *   "window": "newer_than:2d",
 *   "processed_label": "Cove/Meeting-Processed"
 * }
 *
 * Known tool patterns and custom overrides feed one shared detector.
 * `--once --dry-run` reads Gmail and
 * parses matches but writes no labels, intake rows, commitments, state, or
 * heartbeat.
 */
import { execFile } from "node:child_process";
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
import { normalizeMachineIdentity } from "../src/lib/machine-identity.mjs";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const {
  detectMeetingNotes,
  loadMeetingDetectionConfig,
} = require("../src/lib/intake/meeting-detection.ts");
const {
  processMeetingNotesEmail,
  writeWaitingCommitment,
} = require("../src/lib/intake/meeting-pipeline.ts");
const {
  recordFailure,
} = require("../src/lib/reliability/failures.ts");
const {
  recordReceipt,
} = require("../src/lib/reliability/receipts.ts");

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
  return loadMeetingDetectionConfig(file);
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
  const sender = row.sender ?? row.from ?? row.sender_email ?? row.senderEmail;
  if (typeof id !== "string" || !id) return undefined;
  return {
    id,
    threadId: typeof threadId === "string" && threadId ? threadId : id,
    sender: typeof sender === "string" ? sender : "",
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

export { writeWaitingCommitment };

export async function runMeetingWatch(options = {}) {
  const now = options.now ?? (() => new Date());
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const emailConfigPath = options.emailConfigPath ?? DEFAULT_EMAIL_CONFIG_PATH;
  const statePath = options.statePath ?? DEFAULT_STATE_PATH;
  const heartbeatPath = options.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH;
  const runtimeDataDir = options.dataDir ?? path.dirname(configPath);
  const dbPath = options.dbPath ||
    coveEnvTrimmed("DB_PATH") ||
    path.join(runtimeDataDir, "forge.db");
  const dryRun = options.dryRun === true;
  let disabled = false;
  let machineIdentity = options.machineIdentity
    ? normalizeMachineIdentity(options.machineIdentity)
    : undefined;
  const composio = options.composio ?? createComposioExecutor({
    cwd: options.repoDir ?? repoDir,
  });
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
  const heartbeat = () => ({
    last_run_at: now().toISOString(),
    examined: summary.examined,
    matched: summary.matched,
    processed: summary.processed,
    detection_gaps: summary.detection_gaps,
    errors: summary.errors,
    dead_letters: summary.dead_letters,
    disabled,
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
    const config = loadMeetingConfig(configPath);
    const state = readMeetingState(statePath);
    summary.dead_letters = state.dead_letters.length;
    if (!config.enabled) {
      disabled = true;
      if (!dryRun) writeMeetingHeartbeat(heartbeatPath, heartbeat(), machineIdentity);
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
        sender: typeof failure?.sender === "string" ? failure.sender : "",
        raw: {},
      });
    }
    summary.examined = messages.length;
    const candidates = messages.filter((message) =>
      !processed.has(message.id) && !deadLetterIds.has(message.id)
    );
    let labelId;
    let composioFailed = false;

    for (const message of candidates) {
      let zeroItems = false;
      let observedSender = message.sender ?? "";
      let observedSubject = message.subject ?? "";
      try {
        const priorFailure = objectValue(failures[message.id]);
        const fetchedMessage = await fetchMessageBody(
          composio,
          emailConfig.accountEmail,
          message.id,
        );
        const body = bodyFromThread(fetchedMessage);
        const meetingTitle = titleFromThread(message, fetchedMessage);
        observedSubject = meetingTitle;
        const sender = senderFromThread(message, fetchedMessage);
        observedSender = sender;
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

        if (dryRun) {
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

        const pipeline = await (options.processMeetingEmail ??
          processMeetingNotesEmail)(
          {
            messageId: message.id,
            threadId: message.threadId,
            sender,
            subject: meetingTitle,
            body,
            detectedTool: detection.tool,
          },
          {
            sourceDoor: options.sourceDoor ??
              (coveEnv("MEETING_SOURCE_DOOR") === "triage"
                ? "triage"
                : "watcher"),
            dbPath,
            repoDir: options.repoDir ?? repoDir,
            dataDir: runtimeDataDir,
            baseUrl: emailConfig.forgeUrl,
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
          pipeline.reason === "lease-active"
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
        if (error?.composio === true) {
          composioFailed = true;
          break;
        }
      }
    }

    if (!dryRun) {
      persistState();
      writeMeetingHeartbeat(heartbeatPath, heartbeat(), machineIdentity);
    }
    return { exitCode: composioFailed ? 1 : 0, summary };
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

export async function main(args = process.argv.slice(2), options = {}) {
  const unknown = args.filter((arg) => arg !== "--once" && arg !== "--dry-run");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown[0]}\n`);
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const startedAt = new Date().toISOString();
  const result = await (options.runMeetingWatchImpl ?? runMeetingWatch)({
    ...(options.runOptions ?? {}),
    dryRun,
  });
  if (!dryRun) {
    const outcome = result.exitCode !== 0
      ? "failed"
      : result.summary.errors > 0
        ? "partial"
        : "success";
    try {
      (options.recordRunReceiptImpl ?? recordReceipt)({
        dbPath: options.dbPath ||
          coveEnvTrimmed("DB_PATH") ||
          path.join(defaultDataDir, "forge.db"),
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
        failureMessage: result.summary.error_messages
          .map((entry) => entry.error)
          .filter(Boolean)
          .join("; ") ||
          "Meeting watcher run failed.",
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
