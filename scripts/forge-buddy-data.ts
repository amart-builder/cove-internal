import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORGE_REST_TABLES } from "../src/lib/data/forge-tables";

export const FORGE_BUDDY_TABLES = FORGE_REST_TABLES;
type Table = typeof FORGE_BUDDY_TABLES[number];
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
export type BuddyDataCommand = TableCommand | DayPlanCommand | SpawnSessionCommand;

function fail(message: string): never {
  throw new Error(message);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

export function parseBuddyDataArgs(args: string[]): BuddyDataCommand {
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
  if (!(FORGE_BUDDY_TABLES as readonly string[]).includes(table)) fail("table is not allowed");
  const filters: string[] = [];
  args.forEach((value, index) => {
    if (value === "--filter" && args[index + 1]) filters.push(args[index + 1]);
  });
  const rawLimit = option(args, "--limit");
  const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 1000)) fail("--limit is invalid");
  const rawJson = option(args, "--json");
  let json: Record<string, unknown> | undefined;
  if (rawJson) {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("--json must be an object");
    json = parsed as Record<string, unknown>;
  }
  const command: BuddyDataCommand = {
    action, table, filters,
    ...(limit ? { limit } : {}),
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
    if (first <= 0 || second <= first + 1 || second === filter.length - 1) fail(`invalid filter: ${filter}`);
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
  } = {},
): Promise<number> {
  const request = options.fetch ?? fetch;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const appUrl = (options.appUrl ?? process.env.FORGE_BUDDY_APP_URL ?? "http://127.0.0.1:3200").replace(/\/$/, "");
  if (command.action === "spawn-session") {
    const state = await responseJson(await request(`${appUrl}/api/day-plan`, { cache: "no-store" }));
    if (!state || typeof state !== "object" || Array.isArray(state) ||
      typeof (state as Record<string, unknown>).csrfToken !== "string") {
      fail("Forge request token is unavailable");
    }
    const created = await responseJson(await request(`${appUrl}/api/buddy/spawn-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forge-CSRF": (state as Record<string, unknown>).csrfToken as string,
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
      ? (created as Record<string, unknown>).dir as string
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
    if (typeof stateRecord.csrfToken !== "string") fail("Forge request token is unavailable");
    const applied = await responseJson(await request(`${appUrl}/api/day-plan/assistant-apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forge-CSRF": stateRecord.csrfToken },
      body: JSON.stringify(command.json),
    }));
    if (!applied || typeof applied !== "object" || Array.isArray(applied)) fail("day plan apply response is invalid");
    const changes = (applied as Record<string, unknown>).changes;
    if (!Array.isArray(changes) || changes.length === 0) fail("day plan apply returned no changes");
    for (const change of changes) write(`RECEIPT ${JSON.stringify(change)}`);
    return 0;
  }
  const tableCommand = command as TableCommand;
  const base = `${appUrl}/api/forge-rest/${tableCommand.table}`;
  if (tableCommand.action === "query") {
    const params = filterParams(tableCommand.filters);
    if (tableCommand.limit) params.set("limit", String(tableCommand.limit));
    if (tableCommand.order) params.set("order", tableCommand.order);
    const data = await responseJson(await request(`${base}?${params}`));
    write(JSON.stringify(data));
    return 0;
  }
  if (tableCommand.action === "delete" && !tableCommand.confirmToken) {
    fail("Permanent delete requires a confirm token. Emit a pendingDeletes forge-receipts entry and wait for the user to confirm.");
  }
  const state = await responseJson(await request(`${appUrl}/api/day-plan`, { cache: "no-store" }));
  if (!state || typeof state !== "object" || Array.isArray(state) ||
    typeof (state as Record<string, unknown>).csrfToken !== "string") {
    fail("Forge request token is unavailable");
  }
  const csrfToken = (state as Record<string, unknown>).csrfToken as string;
  let existingRow: unknown;
  if (tableCommand.action === "delete") {
    const lookup = await responseJson(await request(`${base}?id=${encodeURIComponent(`eq.${tableCommand.id}`)}&limit=1`));
    if (!Array.isArray(lookup) || lookup.length === 0) fail(`${tableCommand.table} row ${tableCommand.id} was not found`);
    existingRow = lookup[0];
    await responseJson(await request(`${appUrl}/api/buddy/confirm-delete/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tableCommand.confirmToken, table: tableCommand.table, id: tableCommand.id }),
    }));
  }
  const params = new URLSearchParams();
  if (tableCommand.id) params.set("id", `eq.${tableCommand.id}`);
  const response = await request(`${base}${params.size ? `?${params}` : ""}`, {
    method: tableCommand.action === "insert" ? "POST" : tableCommand.action === "update" ? "PATCH" : "DELETE",
    headers: {
      "Content-Type": "application/json",
      "X-Forge-CSRF": csrfToken,
      Prefer: "return=representation",
    },
    ...(tableCommand.json ? { body: JSON.stringify(tableCommand.json) } : {}),
  });
  const data = await responseJson(response);
  if ((tableCommand.action === "insert" || tableCommand.action === "update") &&
    (!Array.isArray(data) || data.length === 0)) {
    fail(`${tableCommand.table} mutation did not change a row`);
  }
  const row = tableCommand.action === "delete" ? existingRow : Array.isArray(data) ? data[0] : data;
  const id = tableCommand.id ?? (row && typeof row === "object" ? String((row as Record<string, unknown>).id ?? "") : "");
  const verb = tableCommand.action === "insert" ? "Inserted" : tableCommand.action === "update" ? "Updated" : "Deleted";
  const summary = `${verb} ${labelFor(row, `${tableCommand.table} row ${id}`)}`;
  write(`RECEIPT ${JSON.stringify({ table: tableCommand.table, action: tableCommand.action, id, summary })}`);
  if (tableCommand.action === "delete") {
    try {
      const remaining = await responseJson(await request(
        `${base}?id=${encodeURIComponent(`eq.${tableCommand.id}`)}&limit=1`,
      ));
      if (!Array.isArray(remaining) || remaining.length > 0) {
        write("WARN: post-delete verification found the row still present");
      }
    } catch {
      write("WARN: post-delete verification read failed");
    }
  }
  return 0;
}

export async function main(
  args = process.argv.slice(2),
  options: Parameters<typeof runBuddyDataCommand>[1] & { writeError?: (line: string) => void } = {},
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => { process.exitCode = code; });
}
