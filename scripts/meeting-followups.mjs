#!/usr/bin/env node
/**
 * Turn a finished meeting into follow-ups on the Forge board.
 *
 * Google Meet's Gemini notes already end with a structured "Next steps" section
 * that names an owner per item, so this does not have to infer follow-ups from a
 * raw transcript. It parses that section, asks Claude which items it can finish
 * on its own and which genuinely need a human, writes them in, and fires one
 * native notification.
 *
 * Three sources:
 *   --file <path>   a notes document saved as text (used by the demo)
 *   --doc  <id>     a Google Doc id, fetched through the Composio CLI
 *   --text "..."    a sentence someone just said out loud, with no notes behind it
 *
 * Usage:
 *   node scripts/meeting-followups.mjs --file notes.txt
 *   node scripts/meeting-followups.mjs --doc 18B9k0eL7dta... --notify
 *   node scripts/meeting-followups.mjs --text "Valley Fresh needs three forklift operators Thursday" --notify
 *
 * Writes to FORGE_DB_PATH, so pointing it at the demo database keeps it entirely
 * clear of real work.
 */
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DB_PATH =
  process.env.FORGE_DB_PATH || path.join(process.cwd(), "data", "forge.db");
const CLAUDE_BIN = process.env.FORGE_CLAUDE_BIN || "claude";
const TERMINAL_NOTIFIER = "/opt/homebrew/bin/terminal-notifier";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(name);

/* -- 1. get the notes ----------------------------------------------------- */

/**
 * Gemini puts the meeting's own name on the first line, which reads far better
 * in a notification than a filename. Fall back to the filename only if the first
 * line looks like prose rather than a title.
 */
function titleFromText(text, fallback) {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first || first.length > 120 || /[.!?]$/.test(first)) return fallback;
  return first;
}

async function loadNotes() {
  const file = arg("--file");
  if (file) {
    const text = readFileSync(file, "utf8");
    return { title: titleFromText(text, path.basename(file)), text };
  }

  const docId = arg("--doc");
  if (!docId) {
    throw new Error('Pass --file <path>, --doc <googleDocId>, or --text "what was said".');
  }
  const { stdout } = await execFileAsync(
    "composio",
    ["execute", "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT", "--params", JSON.stringify({ document_id: docId })],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const payload = JSON.parse(stdout);
  const data = payload?.data ?? payload;
  return { title: data.title ?? docId, text: data.plain_text ?? "" };
}

/* -- 2. parse Gemini's Next steps ----------------------------------------- */

/**
 * Gemini writes the section as:
 *   Next steps
 *   - [Owner] Short label: the actual commitment.
 * It ends at the next top-level heading ("Details", "Summary", "Decisions").
 */
export function parseNextSteps(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*next steps\s*$/i.test(line));
  if (start === -1) return [];

  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(details|summary|decisions|transcript|attachments)\s*$/i.test(line)) break;

    const match = line.match(/^\s*[-•*]\s*\[([^\]]+)\]\s*(.+?)\s*$/);
    if (!match) continue;

    const owner = match[1].trim();
    const body = match[2].trim();
    // "Prepare use cases: Define 3 to 5 key product use cases." -> label + detail
    const split = body.match(/^([^:]{3,60}):\s*(.+)$/);
    items.push({
      owner,
      title: split ? split[1].trim() : body,
      detail: split ? split[2].trim() : "",
    });
  }
  return items;
}

/* -- 2b. turn a spoken sentence into the same items ----------------------- */

/**
 * A sentence someone says out loud has no "Next steps" section to parse, so
 * Claude stands in for the parser and produces the same {owner, title, detail}
 * items parseNextSteps returns. Everything downstream is untouched: the same
 * classifier decides who takes each one, and the same writer puts them up.
 */
const EXTRACT_PROMPT = `Someone just said this out loud about their own business. Turn it into the
follow-ups it implies, the way a person would write them onto a task board.

Rules:
- Pull out every distinct commitment or piece of work in what was said. Do not fold
  two commitments into one item, and do not invent work nobody mentioned.
- Give an item to a person the speaker named as owning it. Everything else belongs
  to the speaker, who is called Alex: he is talking about his own business, so at
  least one item is his to do.
- Keep the title short and imperative, the way a person writes a task: "Confirm the
  Thursday crew with Denise", not "Confirmation of crew availability".
- Put the surrounding context in detail, or leave detail empty when there is none.
- Return between 2 and 4 items. A real sentence about a business carries more than one.

Return ONLY a JSON array, one object per follow-up:
[{"owner":"who owns it","title":"short imperative task","detail":"one sentence of context, or empty"}]`;

// A spoken sentence has no title line to lift, so name the source for what it
// honestly is. The notification then reads "3 follow-ups from what you just said",
// which is exactly what happened. --title overrides it.
const SPOKEN_TITLE = "what you just said";

async function extractFromText(spoken) {
  const { stdout } = await execFileAsync(
    CLAUDE_BIN,
    ["-p", `${EXTRACT_PROMPT}\n\nWHAT WAS SAID:\n${spoken}`, "--no-session-persistence"],
    { maxBuffer: 4 * 1024 * 1024 },
  );

  const match = stdout.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Extractor did not return JSON:\n" + stdout.slice(0, 500));
  const parsed = JSON.parse(match[0]);
  // Match parseNextSteps exactly, including attributing an unowned item to the
  // speaker, because the classifier reads owner to decide what belongs to someone
  // else. Drop anything that came back without a title rather than posting a blank
  // card to the board.
  return parsed
    .filter((item) => item && typeof item.title === "string" && item.title.trim())
    .map((item) => ({
      owner: String(item.owner ?? "Alex").trim() || "Alex",
      title: item.title.trim(),
      detail: typeof item.detail === "string" ? item.detail.trim() : "",
    }));
}

/* -- 3. decide what Claude can take on its own ---------------------------- */

const CLASSIFY_PROMPT = `You are triaging follow-ups from a meeting for a busy founder called Alex.

For each follow-up, decide one thing: can an AI assistant with access to his email,
calendar, documents and task board finish this on its own, or does it genuinely
need Alex?

Rules:
- "claude" means the assistant can produce the finished artifact for Alex to approve.
  Drafting a document, pulling numbers, preparing a summary, writing a reply: those
  are all "claude", because a draft waiting for approval is a finished job.
- "alex" means it needs his judgment, his relationships, or his authority: making a
  decision, choosing a strategy, showing up to something, deciding what to charge.
- Anything owned by another person is "other". Do not invent work for Alex there.
- Be honest. Marking something "claude" that actually needs Alex is the worse error.

Return ONLY a JSON array, one object per follow-up, in the same order:
[{"assignee":"claude|alex|other","reason":"one short clause","firstStep":"the concrete first action"}]`;

async function classify(items) {
  const payload = items
    .map((item, i) => `${i + 1}. [owner: ${item.owner}] ${item.title}${item.detail ? " — " + item.detail : ""}`)
    .join("\n");

  const { stdout } = await execFileAsync(
    CLAUDE_BIN,
    ["-p", `${CLASSIFY_PROMPT}\n\nFOLLOW-UPS:\n${payload}`, "--no-session-persistence"],
    { maxBuffer: 4 * 1024 * 1024 },
  );

  const match = stdout.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Classifier did not return JSON:\n" + stdout.slice(0, 500));
  const parsed = JSON.parse(match[0]);
  // Never let a short classifier response silently drop follow-ups.
  return items.map((item, i) => ({
    ...item,
    ...(parsed[i] ?? { assignee: "alex", reason: "not classified", firstStep: "" }),
  }));
}

/* -- 4. write them in ----------------------------------------------------- */

function write(items, meetingTitle) {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  const now = new Date().toISOString();

  const columns = db.prepare("SELECT id, name FROM task_columns ORDER BY position").all();
  const column = (name) =>
    (columns.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? columns[0]).id;

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, column_id, title, description, priority, tags, position, status, source_type, remind_native, remind_text, created_at, updated_at)
     VALUES (@id, @column_id, @title, @description, @priority, @tags, @position, 'open', 'detector', 1, 0, @now, @now)`,
  );
  const insertCommitment = db.prepare(
    `INSERT INTO commitments (id, kind, title, details, source_kind, source_ref, confidence, confirmed, status, created_at, updated_at)
     VALUES (@id, 'follow_up', @title, @details, 'detector', @source_ref, 'high', 0, 'open', @now, @now)`,
  );

  const mine = items.filter((item) => item.assignee !== "other");
  // The board sorts each column by position ascending, so a follow-up has to sit
  // below the column's current minimum to land on top of the column, which is
  // where whoever just read the notification is looking. Read the minimums once,
  // before the transaction opens, and hand out a block of positions just under
  // each one so several follow-ups into the same column keep the meeting's order.
  const columnTop = new Map(
    db
      .prepare("SELECT column_id, MIN(position) AS p FROM tasks GROUP BY column_id")
      .all()
      .map((row) => [row.column_id, row.p]),
  );
  let placed = 0;

  const tx = db.transaction(() => {
    mine.forEach((item) => {
      const columnId = column(item.assignee === "claude" ? "Not Started" : "Must happen today");
      const position = (columnTop.get(columnId) ?? 0) - mine.length + placed;
      placed += 1;
      insertTask.run({
        id: randomUUID(),
        column_id: columnId,
        title: item.title,
        description: [item.detail, item.reason && `Why: ${item.reason}`, item.firstStep && `First step: ${item.firstStep}`]
          .filter(Boolean)
          .join("\n"),
        priority: item.assignee === "alex" ? "high" : "medium",
        // Say who owns it on the card itself. jarvis-held is the existing
        // convention and it also keeps Jarvis's own work out of the morning
        // ranking, which is exactly right for a follow-up it is handling.
        tags: JSON.stringify(item.assignee === "claude" ? ["jarvis-held"] : ["needs you"]),
        position,
        now,
      });
      insertCommitment.run({
        id: randomUUID(),
        title: item.title,
        details: item.detail || null,
        source_ref: meetingTitle,
        now,
      });
    });
  });
  tx();
  db.close();

  return {
    claude: mine.filter((i) => i.assignee === "claude").length,
    alex: mine.filter((i) => i.assignee === "alex").length,
    other: items.length - mine.length,
  };
}

/* -- 5. tell him ---------------------------------------------------------- */

async function notify(counts, meetingTitle) {
  const total = counts.claude + counts.alex;
  if (total === 0) return;

  const body =
    counts.alex > 0
      ? `${total} follow-up${total === 1 ? "" : "s"} from ${meetingTitle}. I can handle ${counts.claude}. ${counts.alex} need${counts.alex === 1 ? "s" : ""} you.`
      : `${total} follow-up${total === 1 ? "" : "s"} from ${meetingTitle}. I've got all of them.`;

  const boardUrl = process.env.FORGE_BRIEF_WEB_BASE ?? "http://127.0.0.1:3200";
  // Normally clicking the notification opens the board, and FORGE_FOLLOWUP_OPEN_URL
  // can point that at some other page. Set FORGE_FOLLOWUP_ACTIVATE to a bundle id
  // instead and a click only brings that app to the front, which is what the demo
  // wants: opening a URL starts a new tab and abandons the presentation that is
  // already on screen showing these very cards.
  const openUrl = process.env.FORGE_FOLLOWUP_OPEN_URL ?? `${boardUrl}/tasks`;
  const activate = process.env.FORGE_FOLLOWUP_ACTIVATE;
  const onClick = activate ? ["-activate", activate] : ["-open", openUrl];
  const useNotifier = existsSync(TERMINAL_NOTIFIER);
  const [bin, args] = useNotifier
    ? [TERMINAL_NOTIFIER, ["-title", "Forge", "-message", body, "-group", "forge-followups", ...onClick]]
    : ["/usr/bin/osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", "Forge", body]];

  await execFileAsync(bin, args).catch(() => {});
  console.log(`Notified: ${body}`);
}

/* ------------------------------------------------------------------------- */

// --text is the same job with the notes taken out: a sentence instead of a
// document, extraction instead of the parser. From here down the two paths are
// the same code.
const spoken = arg("--text");
let sourceTitle;
let parsed;
if (spoken) {
  sourceTitle = arg("--title") ?? SPOKEN_TITLE;
  parsed = await extractFromText(spoken);
} else {
  const notes = await loadNotes();
  sourceTitle = notes.title;
  parsed = parseNextSteps(notes.text);
}

if (parsed.length === 0) {
  console.log(
    spoken
      ? "Nothing in that sounded like a commitment. Nothing to do."
      : "No 'Next steps' section found in these notes. Nothing to do.",
  );
  process.exit(0);
}

const meetingTitle = sourceTitle.replace(/\s*-\s*\d{4}\/\d{2}\/\d{2}.*$/, "").trim();
console.log(`${parsed.length} follow-up${parsed.length === 1 ? "" : "s"} in "${meetingTitle}"`);

const classified = await classify(parsed);
for (const item of classified) {
  console.log(`  [${item.assignee.padEnd(6)}] ${item.title}`);
}

const counts = write(classified, meetingTitle);
console.log(`Wrote ${counts.claude + counts.alex} to the board (${counts.claude} for Claude, ${counts.alex} for Alex, ${counts.other} owned by someone else).`);

if (hasFlag("--notify")) await notify(counts, meetingTitle);
