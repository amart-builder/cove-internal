import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COVE_CRM_COMPAT_TABLES,
  COVE_REST_TABLES,
} from "../src/lib/data/cove-tables";
import {
  runCoveIntake,
  type CoveIntakeInput,
} from "../src/lib/intake/run";
import { coveEnv } from "../src/lib/env";
import { getRuntimeMode } from "../src/lib/runtime/mode";
import { parseBuddyKnowledgeArgs, runBuddyKnowledge, type BuddyKnowledgeCommand } from "../src/lib/buddy/knowledge";
import type { WorkspaceGateway } from "../src/lib/workspace";
import { buddyDataPaths } from "../src/lib/buddy/environment";
import { taskEditMatches } from "../src/lib/tasks/edit-conflict";

export const COVE_BUDDY_REPO_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const COVE_BUDDY_TABLES = [
  ...COVE_REST_TABLES,
  ...COVE_CRM_COMPAT_TABLES,
] as const;
type Table = (typeof COVE_BUDDY_TABLES)[number];
type Action = "query" | "insert" | "update" | "delete";

type TableCommand = {
  action: Action;
  table: Table;
  filters: string[];
  limit?: number;
  order?: string;
  id?: string;
  json?: Record<string, unknown>;
  confirmToken?: string;
  select?: string;
  offset?: number;
};
type DayPlanCommand = {
  action: "day-plan-get" | "day-plan-apply";
  json?: { expectedVersion?: unknown; operations?: unknown };
};
type SpawnSessionCommand = {
  action: "spawn-session";
  prompt: string;
  title?: string;
} & ({ dir: string; project?: never } | { dir?: never; project: string });
type IntakeCommand = {
  action: "intake";
  input: CoveIntakeInput;
};
type RecurrenceCommand =
  | {
  action: "recurrence-confirm";
  taskId: string;
  cadence?: string;
} | {
  action: "recurrence-update";
  templateId: string;
  operation: "pause" | "resume" | "stop";
};
export type BuddyDataCommand =
  | { action: 'planning-question'; json?: Record<string, unknown> }
  | BuddyKnowledgeCommand
  | { action: "agent-status" }
  | { action: "agent-primary"; provider: "claude" | "codex" }
  | TableCommand
  | DayPlanCommand
  | SpawnSessionCommand
  | IntakeCommand
  | RecurrenceCommand;

function fail(message: string): never {
  throw new Error(message);
}

function option(
  args: string[],
  name: string,
  options: { allowLeadingDash?: boolean } = {},
): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || (!options.allowLeadingDash && value.startsWith("--"))) {
    fail(`${name} requires a value`);
  }
  return value;
}

export function parseBuddyDataArgs(args: string[]): BuddyDataCommand {
  if (args[0] === 'planning-question')
    return {
      action: 'planning-question',
      ...(args[1] === 'answer' ? { json: JSON.parse(option(args, '--json') ?? '{}') } : {}),
    };
  const knowledge = parseBuddyKnowledgeArgs(args);
  if (knowledge) return knowledge;
  if (args[0] === "agent") {
    if (args.length === 2 && args[1] === "status") return { action: "agent-status" };
    if (args.length === 4 && args[1] === "primary" && args[2] === "--provider" &&
        (args[3] === "claude" || args[3] === "codex")) return { action: "agent-primary", provider: args[3] };
    fail("Use agent status or agent primary --provider claude|codex.");
  }
  if (args[0] === "recurrence") {
    if (args[1] === "confirm") {
      const taskId = option(args, "--task-id");
      if (!taskId) fail("recurrence confirm requires --task-id");
      const cadence = option(args, "--cadence");
      return {
        action: "recurrence-confirm",
        taskId,
        ...(cadence ? { cadence } : {}),
      };
    }
    if (args[1] === "pause" || args[1] === "resume" || args[1] === "stop") {
      const templateId = option(args, "--template-id");
      if (!templateId) fail(`recurrence ${args[1]} requires --template-id`);
      return {
        action: "recurrence-update",
        templateId,
        operation: args[1],
      };
    }
    fail("recurrence requires confirm, pause, resume, or stop");
  }
  if (args[0] === "intake") {
    const text = option(args, "--text", { allowLeadingDash: true });
    if (!text) fail("intake requires --text");
    return {
      action: "intake",
      input: {
        text,
        source: "buddy",
        ...(option(args, "--source-id")
          ? { sourceId: option(args, "--source-id") }
          : {}),
        dryRun: args.includes("--dry-run"),
      },
    };
  }
  if (args[0] === "spawn-session") {
    const dir = option(args, "--dir");
    const project = option(args, "--project");
    const prompt = option(args, "--prompt");
    if (Boolean(dir) === Boolean(project)) {
      fail("spawn-session requires exactly one of --dir or --project");
    }
    if (!prompt) fail("spawn-session requires --prompt");
    const title = option(args, "--title");
    return {
      action: "spawn-session",
      ...(dir ? { dir } : { project: project! }),
      prompt,
      ...(title ? { title } : {}),
    };
  }
  if (args[0] === "day-plan") {
    if (args[1] === "get") return { action: "day-plan-get" };
    if (args[1] !== "apply") fail("day-plan requires get or apply");
    const rawJson = option(args, "--json");
    if (!rawJson) fail("day-plan apply requires --json");
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("--json must be an object");
    }
    return { action: "day-plan-apply", json: parsed as DayPlanCommand["json"] };
  }
  const action = args[0] as Action;
  const table = args[1] as Table;
  if (!["query", "insert", "update", "delete"].includes(action)) fail("unknown subcommand");
  if (!(COVE_BUDDY_TABLES as readonly string[]).includes(table)) fail("table is not allowed. Calendar is a connector, not a table: use calendar list --from <timestamp> --to <timestamp>. Run help for all Cove sources.");
  if (action === "insert" && table === "tasks") {
    fail("New tasks must use the intake subcommand.");
  }
  const filters: string[] = [];
  args.forEach((value, index) => {
    if (value === "--filter" && args[index + 1]) filters.push(args[index + 1]);
  });
  const rawLimit = option(args, "--limit");
  const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 1000)) fail("--limit is invalid");
  const rawJson = option(args, "--json");
  const select = option(args, "--select");
  if (select && select !== "*" && !/^[a-z_][a-z0-9_]*(?:,[a-z_][a-z0-9_]*)*$/.test(select)) fail("--select requires comma-separated column names.");
  const rawOffset = option(args, "--offset");
  if (rawOffset !== undefined && (!/^\d+$/.test(rawOffset) || Number(rawOffset) > 1_000_000)) fail("--offset is invalid");
  let json: Record<string, unknown> | undefined;
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("--json must be an object");
    json = parsed as Record<string, unknown>;
  }
  const command: BuddyDataCommand = {
    action, table, filters,
    ...(limit ? { limit } : {}),
    ...(select ? { select } : {}),
    ...(rawOffset !== undefined ? { offset: Number(rawOffset) } : {}),
    ...(option(args, "--order") ? { order: option(args, "--order") } : {}),
    ...(option(args, "--id") ? { id: option(args, "--id") } : {}),
    ...(json ? { json } : {}),
    ...(option(args, "--confirm-token") ? { confirmToken: option(args, "--confirm-token") } : {}),
  };
  if (action === "insert" && !command.json) fail("insert requires --json");
  if (action === "update" && (!command.id || !command.json)) fail("update requires --id and --json");
  if (action === "delete" && !command.id) fail("delete requires --id");
  return command;
}

function filterParams(filters: string[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const filter of filters) {
    const first = filter.indexOf(".");
    const second = filter.indexOf(".", first + 1);
    if (first <= 0 || second <= first + 1 || second === filter.length - 1) fail(`invalid filter: ${filter}. Use field.operator.value, for example status.eq.open or contact_id.eq.<id>. Repeat --filter for AND.`);
    params.append(filter.slice(0, first), `${filter.slice(first + 1, second)}.${filter.slice(second + 1)}`);
  }
  return params;
}

function labelFor(row: unknown, fallback: string): string {
  if (!row || typeof row !== "object" || Array.isArray(row)) return fallback;
  const record = row as Record<string, unknown>;
  for (const key of ["title", "name", "subject", "summary", "id"]) {
    if (typeof record[key] === "string" && record[key]) return `'${record[key]}'`;
  }
  return fallback;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 409 && text) {
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const candidates = (payload as Record<string, unknown>).candidates;
        if (Array.isArray(candidates)) {
          const labels = candidates
            .filter(
              (value): value is Record<string, unknown> =>
                Boolean(value) &&
                typeof value === "object" &&
                !Array.isArray(value),
            )
            .map((candidate) => {
              const name = typeof candidate.name === "string"
                ? candidate.name
                : "Unnamed contact";
              const email = typeof candidate.email === "string" &&
                  candidate.email
                ? ` <${candidate.email}>`
                : "";
              const id = typeof candidate.id === "string" && candidate.id
                ? ` (${candidate.id})`
                : "";
              return `${name}${email}${id}`;
            });
          if (labels.length > 0) {
            fail(
              `Contact identity is ambiguous. Possible matches: ${
                labels.join(", ")
              }. Ask which person the user means.`,
            );
          }
        }
      }
    }
    const limit = response.status === 409 ? 24_000 : 500;
    fail(`HTTP ${response.status}: ${text.slice(0, limit) || response.statusText}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function runBuddyDataCommand(
  command: BuddyDataCommand,
  options: {
    fetch?: typeof fetch;
    appUrl?: string;
    write?: (line: string) => void;
    runIntake?: typeof runCoveIntake;
    workspaceGateway?: WorkspaceGateway;
    dataDir?: string;
    dbPath?: string;
  } = {},
): Promise<number> {
  const request = options.fetch ?? fetch;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const appUrl = (options.appUrl ?? coveEnv("BUDDY_APP_URL") ?? "http://127.0.0.1:3200").replace(/\/$/, "");
  if (command.action === 'planning-question') {
    const state = await responseJson(
      await request(`${appUrl}/api/planning-questions`, { cache: 'no-store' }),
    );
    if (!command.json) {
      write(JSON.stringify(state));
      return 0;
    }
    const token = (state as { csrfToken?: string }).csrfToken;
    if (!token) fail('Cove request token is unavailable');
    write(
      JSON.stringify(
        await responseJson(
          await request(`${appUrl}/api/planning-questions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Cove-CSRF': token,
            },
            body: JSON.stringify({
              ...command.json,
              source: 'buddy-explicit-answer',
            }),
          }),
        ),
      ),
    );
    return 0;
  }
  if (command.action === "knowledge") {
    const { dataDir, dbPath } = buddyDataPaths(COVE_BUDDY_REPO_DIR, options);
    write(JSON.stringify(await runBuddyKnowledge(command, { appUrl, dataDir, dbPath, workspaceGateway: options.workspaceGateway,
      requestJson: async (url) => responseJson(await request(url, { cache: "no-store" })) })));
    return 0;
  }
  if (command.action === "agent-status" || command.action === "agent-primary") {
    let init: RequestInit = { cache: "no-store" };
    if (command.action === "agent-primary") {
      const state = await responseJson(await request(`${appUrl}/api/day-plan`, { cache: "no-store" }));
      const token = (state as { csrfToken?: unknown } | null)?.csrfToken;
      if (typeof token !== "string") fail("Cove request token is unavailable");
      init = { method: "PATCH", headers: { "Content-Type": "application/json", "X-Cove-CSRF": token },
        body: JSON.stringify({ provider: command.provider }) };
    }
    const result = await responseJson(await request(`${appUrl}/api/agent-settings`, init));
    write(JSON.stringify(result));
    return 0;
  }
  if (command.action === "intake") {
    const result = await (options.runIntake ?? runCoveIntake)(command.input, {
      fetchImpl: request,
      webBaseUrl: appUrl,
      repoDir: COVE_BUDDY_REPO_DIR,
      write: () => undefined,
      writeError: (line) => write(`WARN ${line}`),
    });
    if (command.input.dryRun) {
      write(`DRY_RUN ${JSON.stringify({ event_id: result.event.id })}`);
    } else if (result.taskId) {
      write(`RECEIPT ${JSON.stringify({
        table: "tasks",
        action: "insert",
        id: result.taskId,
        summary: result.existed
          ? `Task already captured (${result.taskId})`
          : `Captured task (${result.taskId})`,
      })}`);
      if (result.proposedRecurrence) {
        write(`PROPOSED_RECURRENCE ${JSON.stringify({
          task_id: result.taskId,
          cadence: result.proposedRecurrence,
        })}`);
      }
    } else if (result.spooled) {
      write(`SPOOLED ${JSON.stringify({
        source: result.event.source,
        source_id: result.event.source_id,
      })}`);
    }
    return result.exitCode;
  }
  if (command.action === "recurrence-confirm") {
    const state = await responseJson(await request(`${appUrl}/api/day-plan`, {
      cache: "no-store",
    }));
    if (!state || typeof state !== "object" || Array.isArray(state) ||
      typeof (state as Record<string, unknown>).csrfToken !== "string") {
      fail("Cove request token is unavailable");
    }
    const template = await responseJson(await request(`${appUrl}/api/recurrence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cove-CSRF": (state as Record<string, unknown>).csrfToken as string,
      },
      body: JSON.stringify({
        action: "confirm",
        taskId: command.taskId,
        ...(command.cadence ? { cadence: command.cadence } : {}),
      }),
    }));
    if (!template || typeof template !== "object" || Array.isArray(template) ||
      typeof (template as Record<string, unknown>).id !== "string") {
      fail("recurrence confirmation response is invalid");
    }
    write(`RECEIPT ${JSON.stringify({
      table: "tasks",
      action: "update",
      id: command.taskId,
      summary: `Made task a ${(template as Record<string, unknown>).cadence} rhythm`,
    })}`);
    return 0;
  }
  if (command.action === "recurrence-update") {
    const state = await responseJson(await request(`${appUrl}/api/day-plan`, {
      cache: "no-store",
    }));
    if (!state || typeof state !== "object" || Array.isArray(state) ||
      typeof (state as Record<string, unknown>).csrfToken !== "string") {
      fail("Cove request token is unavailable");
    }
    const template = await responseJson(await request(`${appUrl}/api/recurrence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cove-CSRF": (state as Record<string, unknown>).csrfToken as string,
      },
      body: JSON.stringify({
        action: "update",
        id: command.templateId,
        ...(command.operation === "pause"
          ? { pausedUntil: "9999-12-31" }
          : command.operation === "resume"
            ? { pausedUntil: null }
            : { active: false }),
      }),
    }));
    if (!template || typeof template !== "object" || Array.isArray(template) ||
      typeof (template as Record<string, unknown>).id !== "string") {
      fail("recurrence update response is invalid");
    }
    write(`RECEIPT ${JSON.stringify({
      table: "recurring_templates",
      action: "update",
      id: command.templateId,
      summary: `${command.operation === "stop" ? "Stopped" : command.operation === "pause" ? "Paused" : "Resumed"} rhythm`,
    })}`);
    return 0;
  }
  if (command.action === "spawn-session") {
    const state = await responseJson(await request(`${appUrl}/api/day-plan`, { cache: "no-store" }));
    if (!state || typeof state !== "object" || Array.isArray(state) ||
      typeof (state as Record<string, unknown>).csrfToken !== "string") {
      fail("Cove request token is unavailable");
    }
    const created = await responseJson(await request(`${appUrl}/api/buddy/spawn-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cove-CSRF": (state as Record<string, unknown>).csrfToken as string,
      },
      body: JSON.stringify({
        ...(command.dir ? { dir: command.dir } : { project: command.project }),
        prompt: command.prompt,
        ...(command.title ? { title: command.title } : {}),
      }),
    }));
    if (!created || typeof created !== "object" || Array.isArray(created) ||
      typeof (created as Record<string, unknown>).sessionId !== "string") {
      fail("spawn-session response is invalid");
    }
    const resolvedDir = typeof (created as Record<string, unknown>).dir === "string"
      ? ((created as Record<string, unknown>).dir as string)
        : command.dir;
    if (!resolvedDir) fail("spawn-session response is missing the resolved directory");
    write(`SESSION ${JSON.stringify({
      sessionId: (created as Record<string, unknown>).sessionId,
      dir: resolvedDir,
      title: command.title ?? "Buddy session",
    })}`);
    return 0;
  }
  if (command.action === "day-plan-get" || command.action === "day-plan-apply") {
    const state = await responseJson(await request(`${appUrl}/api/day-plan`, { cache: "no-store" }));
    if (!state || typeof state !== "object" || Array.isArray(state)) fail("day plan response is invalid");
    const stateRecord = state as Record<string, unknown>;
    if (command.action === "day-plan-get") {
      const plan = stateRecord.currentPlan;
      if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("there is no current day plan");
      const record = plan as Record<string, unknown>;
      const items = Array.isArray(record.items) ? record.items.map((raw) => {
        const item = raw as Record<string, unknown>;
        return {
          id: item.id,
          title: item.title,
          owner: item.owner,
          position: item.position,
          decision: item.decision,
          outcome: item.outcome,
          definitionOfDone: item.definitionOfDone,
        };
      }) : [];
      write(JSON.stringify({
        id: record.id,
        version: record.version,
        steps: ["brief", "priorities", "extras"],
        items,
      }));
      return 0;
    }
    if (typeof stateRecord.csrfToken !== "string") fail("Cove request token is unavailable");
    const applied = await responseJson(await request(`${appUrl}/api/day-plan/assistant-apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cove-CSRF": stateRecord.csrfToken },
      body: JSON.stringify(command.json),
    }));
    if (!applied || typeof applied !== "object" || Array.isArray(applied)) fail("day plan apply response is invalid");
    const changes = (applied as Record<string, unknown>).changes;
    if (!Array.isArray(changes) || changes.length === 0) fail("day plan apply returned no changes");
    for (const change of changes) write(`RECEIPT ${JSON.stringify(change)}`);
    return 0;
  }
  const tableCommand = command as TableCommand;
  if (tableCommand.action === "update" && tableCommand.table === "tasks") {
    const expected = tableCommand.json?._expected;
    const guidance = "Task update requires _expected.updatedAt from the latest full task read (updated_at), plus the original title/description for either field being edited. Read the latest task, preserve the intended change, and retry with those expected values. Do not fetch a new timestamp and reuse a stale replacement.";
    if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
        typeof (expected as Record<string, unknown>).updatedAt !== "string" ||
        !(expected as Record<string, string>).updatedAt.trim()) fail(guidance);
    for (const field of ["title", "description"]) {
      if (Object.hasOwn(tableCommand.json!, field) && !Object.hasOwn(expected, field)) fail(guidance);
    }
    // Validate supported keys and values without fetching or replacing the
    // caller's read snapshot. The database compares it atomically at write time.
    try {
      for (const [key, value] of Object.entries(expected)) taskEditMatches({}, { [key]: value });
    } catch { fail(guidance); }
  }
  const base = `${appUrl}/api/cove-rest/${tableCommand.table}`;
  if (tableCommand.action === "query") {
    const params = filterParams(tableCommand.filters);
    params.set("limit", String(tableCommand.limit ?? 20));
    if (tableCommand.select) params.set("select", tableCommand.select);
    if (tableCommand.offset !== undefined) params.set("offset", String(tableCommand.offset));
    if (tableCommand.table === "contact_activities" && !params.get("contact_id")?.startsWith("eq.")) fail("Activity history requires --filter contact_id.eq.<id>. Use contacts search --search <name>, then contacts context --id <id> or contacts history --id <id>.");
    if (tableCommand.order) params.set("order", tableCommand.order);
    const data = await responseJson(await request(`${base}?${params}`));
    write(JSON.stringify(data));
    return 0;
  }
  const archivesTask = tableCommand.action === "delete" &&
    tableCommand.table === "tasks" &&
    getRuntimeMode() === "local";
  if (tableCommand.action === "delete" && !archivesTask && !tableCommand.confirmToken) {
    fail("Permanent delete requires a confirm token. Emit a pendingDeletes cove-receipts entry and wait for the user to confirm.");
  }
  const state = await responseJson(await request(`${appUrl}/api/day-plan`, { cache: "no-store" }));
  if (!state || typeof state !== "object" || Array.isArray(state) ||
    typeof (state as Record<string, unknown>).csrfToken !== "string") {
    fail("Cove request token is unavailable");
  }
  const csrfToken = (state as Record<string, unknown>).csrfToken as string;
  let existingRow: unknown;
  if (tableCommand.action === "delete") {
    const lookup = await responseJson(await request(`${base}?id=${encodeURIComponent(`eq.${tableCommand.id}`)}&limit=1`));
    if (!Array.isArray(lookup) || lookup.length === 0) fail(`${tableCommand.table} row ${tableCommand.id} was not found`);
    existingRow = lookup[0];
    if (!archivesTask) {
      await responseJson(await request(`${appUrl}/api/buddy/confirm-delete/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tableCommand.confirmToken, table: tableCommand.table, id: tableCommand.id }),
      }));
    }
  }
  const params = new URLSearchParams();
  if (tableCommand.id) params.set("id", `eq.${tableCommand.id}`);
  const response = await request(`${base}${params.size ? `?${params}` : ""}`, {
    method: tableCommand.action === "insert"
      ? "POST"
      : tableCommand.action === "update" || archivesTask
        ? "PATCH"
        : "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-Cove-CSRF": csrfToken,
      Prefer: "return=representation",
    },
    ...(archivesTask
      ? {
          body: JSON.stringify({
            status: "archived",
            archived_at: new Date().toISOString(),
            archived_from_status:
              existingRow &&
                typeof existingRow === "object" &&
                !Array.isArray(existingRow) &&
                (existingRow as Record<string, unknown>).status === "done"
                ? "done"
                : "open",
          }),
        }
      : tableCommand.json
        ? { body: JSON.stringify(tableCommand.json) }
        : {}),
  });
  if (response.status === 409 && tableCommand.action === "update" && tableCommand.table === "tasks") {
    fail("HTTP 409: This task changed after your read. Read the latest full task and rebuild the same intended change while preserving intervening edits. Retry with _expected.updatedAt and original title/description values from that read; do not reuse a stale replacement with a fresh timestamp.");
  }
  const data = await responseJson(response);
  if ((tableCommand.action === "insert" || tableCommand.action === "update") &&
    (!Array.isArray(data) || data.length === 0)) {
    fail(`${tableCommand.table} mutation did not change a row`);
  }
  const row = tableCommand.action === "delete" ? existingRow : Array.isArray(data) ? data[0] : data;
  const id = tableCommand.id ?? (row && typeof row === "object" ? String((row as Record<string, unknown>).id ?? "") : "");
  const verb = archivesTask
    ? "Archived"
    : tableCommand.action === "insert"
      ? "Inserted"
      : tableCommand.action === "update"
        ? "Updated"
        : "Deleted";
  const summary = `${verb} ${labelFor(row, `${tableCommand.table} row ${id}`)}`;
  write(`RECEIPT ${JSON.stringify({
    table: tableCommand.table,
    action: archivesTask ? "update" : tableCommand.action,
    id,
    summary,
  })}`);
  if (tableCommand.action === "delete") {
    try {
      const remaining = await responseJson(await request(
        `${base}?id=${encodeURIComponent(`eq.${tableCommand.id}`)}&limit=1`,
      ));
      if (!Array.isArray(remaining) || remaining.length > 0) {
        write(`WARN: post-${archivesTask ? "archive" : "delete"} verification found the row still present`);
      }
    } catch {
      write("WARN: post-delete verification read failed");
    }
  }
  return 0;
}

export async function main(
  args = process.argv.slice(2),
  options: Parameters<typeof runBuddyDataCommand>[1] & { writeError?: (line: string) => void;
  } = {},
): Promise<number> {
  try {
    return await runBuddyDataCommand(parseBuddyDataArgs(args), options);
  } catch (error) {
    const line = `ERROR ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}`;
    if (options.writeError) options.writeError(line);
    else process.stderr.write(`${line}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  void main().then((code) => { process.exitCode = code; });
}
