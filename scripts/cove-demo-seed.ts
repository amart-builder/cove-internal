import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDayPlanCandidates,
  eligibleNotTodayTasks,
} from "../src/lib/day-plan/candidates";
import {
  MORNING_BRIEF_PROMPT_VERSION,
  MORNING_BRIEF_SCHEMA_VERSION,
  morningBriefFromArtifact,
  validateMorningBrief,
} from "../src/lib/day-plan/brief";
import { focusBandItems } from "../src/lib/day-plan/presentation";
import {
  createDayPlanStore,
  type DayPlanStore,
} from "../src/lib/day-plan/store";
import { coveEnv } from "../src/lib/env";
import { resolveEmailRuntimePaths } from "../src/lib/email/runtime-paths";
import {
  openLocalDatabase,
  openSqliteDatabase,
} from "../src/lib/local/database";
import {
  coveDataDir,
  operatorProfilePath,
} from "../src/lib/operator";
import {
  readTaskSettings,
  taskSettingsPath,
} from "../src/lib/tasks/settings";
import { TASK_COLUMNS } from "../src/lib/tasks/columns";
import { workspaceConfigPath } from "../src/lib/workspace/config";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realDataDir = path.join(repoDir, "data");
const realDbPath = path.join(realDataDir, "cove.db");
const realDataGuardPaths = [
  realDbPath,
  path.join(realDataDir, "cove.db-wal"),
  path.join(realDataDir, "cove.db-shm"),
  path.join(realDataDir, "cove-profile.json"),
  path.join(realDataDir, "cove-task-settings.json"),
  path.join(realDataDir, "cove-workspace.json"),
] as const;
const demoDataDir = path.join(realDataDir, "demo");
const demoDbPath = path.join(demoDataDir, "cove.db");
const demoProfilePath = path.join(demoDataDir, "cove-profile.json");
const demoExecutionConfigPath = path.join(demoDataDir, "cove-execution.json");
const demoBriefDir = path.join(demoDataDir, "brief");
const demoGoalsPath = path.join(demoBriefDir, "goals.md");
const demoSprintMemoPath = path.join(demoBriefDir, "sprint-memo.md");
const demoOperatorBriefPath = path.join(demoBriefDir, "operator-profile.md");
const demoLeadupPath = path.join(demoBriefDir, "leadup.md");
const demoMemoryPath = path.join(demoBriefDir, "memory.md");
const demoTimezone = "America/Los_Angeles";

type SeedTask = {
  id: string;
  title: string;
  description: string;
  project: string;
  priority: "low" | "medium" | "high";
  dueLocalDate: string;
  columnKey: "not-started" | "today" | "done";
  status: "open" | "done";
  position: number;
};

type ColumnRow = {
  id: string;
  name: string;
  position: number;
};

type TaskRow = {
  id: string;
  column_id: string;
  due_at: string | null;
  position: number;
  priority: "low" | "medium" | "high";
  tags: string;
  status: "open" | "done" | "archived";
  updated_at: string;
  recurring_template_id: string | null;
};

function resolvedPath(file: string): string {
  return existsSync(file) ? realpathSync(file) : path.resolve(file);
}

function samePath(left: string, right: string): boolean {
  return resolvedPath(left) === resolvedPath(right);
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function localDateInTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftLocalDate(localDate: string, days: number): string {
  const value = new Date(`${localDate}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function statMtimeNs(file: string): bigint | undefined {
  return existsSync(file) ? statSync(file, { bigint: true }).mtimeNs : undefined;
}

function assertSafeDemoPaths(): void {
  assert.equal(path.dirname(demoDataDir), realDataDir);
  assert.equal(path.basename(demoDataDir), "demo");
  assert.notEqual(path.resolve(demoDbPath), path.resolve(realDbPath));
  assert.equal(samePath(demoDbPath, realDbPath), false);

  if (existsSync(demoDataDir)) {
    assert.equal(
      lstatSync(demoDataDir).isSymbolicLink(),
      false,
      "Refusing to replace a symlinked demo data directory.",
    );
  }

  const configuredDbPath = coveEnv("DB_PATH")?.trim();
  if (configuredDbPath) {
    assert.equal(
      path.resolve(configuredDbPath),
      path.resolve(demoDbPath),
      `Refusing to seed with COVE_DB_PATH outside ${demoDbPath}.`,
    );
  }
  const configuredDataDir = coveEnv("DATA_DIR")?.trim();
  if (configuredDataDir) {
    assert.equal(
      path.resolve(configuredDataDir),
      path.resolve(demoDataDir),
      `Refusing to seed with COVE_DATA_DIR outside ${demoDataDir}.`,
    );
  }
}

function configureDemoEnvironment(): void {
  process.env.COVE_DB_PATH = demoDbPath;
  process.env.COVE_DATA_DIR = demoDataDir;
  process.env.COVE_PROFILE_PATH = demoProfilePath;
  process.env.COVE_EXECUTION_CONFIG = demoExecutionConfigPath;
  process.env.COVE_TIMEZONE = demoTimezone;
  process.env.COVE_OPERATOR_NAME = "Alex";
  process.env.COVE_BRIEF_TIMEZONE = demoTimezone;
  process.env.COVE_BRIEF_WEB_BASE = "http://127.0.0.1:3300";
  process.env.COVE_BRIEF_GOALS_PATH = demoGoalsPath;
  process.env.COVE_BRIEF_SPRINT_MEMO_PATH = demoSprintMemoPath;
  process.env.COVE_BRIEF_OPERATOR_PROFILE_PATH = demoOperatorBriefPath;
  process.env.COVE_BRIEF_LEADUP_PATH = demoLeadupPath;
  process.env.COVE_BRIEF_MEMORY_PATH = demoMemoryPath;
  process.env.COVE_BRIEF_JARVIS_URL = "";
  process.env.COVE_BRIEF_JARVIS_TOKEN_PATH = path.join(demoBriefDir, "jarvis-disabled");
  process.env.COVE_SUPERNOVA_DIR = path.join(demoDataDir, "supernova");
  process.env.ATTIO_API_KEY = "";
  process.env.ATTIO_TOKEN = "";
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
}

function seedTasks(
  localDate: string,
  yesterday: string,
): SeedTask[] {
  return [
    {
      id: "demo-horizon-one-pager",
      title: "Draft the partner one-pager for the Horizon pilot",
      description:
        "Turn the pilot scope, success measures, and implementation sequence into a partner-ready one-pager.",
      project: "Horizon Pilot",
      priority: "high",
      dueLocalDate: localDate,
      columnKey: "today",
      status: "open",
      position: 0,
    },
    {
      id: "demo-pricing-experiment",
      title: "Decide on the Q3 pricing experiment",
      description:
        "Choose the test audience, package boundary, and success threshold so the experiment can launch next week.",
      project: "Growth",
      priority: "high",
      dueLocalDate: localDate,
      columnKey: "today",
      status: "open",
      position: 1,
    },
    {
      id: "demo-ops-review",
      title: "Prep Thursday's ops review",
      description:
        "Pull the delivery risks, decisions, and owner asks into a short agenda for the operating review.",
      project: "Operations",
      priority: "medium",
      dueLocalDate: localDate,
      columnKey: "today",
      status: "open",
      position: 2,
    },
    {
      id: "demo-meridian-intro",
      title: "Follow up with the Meridian intro",
      description:
        "Send the promised context and offer two times for a first conversation about the partner opportunity.",
      project: "Partnerships",
      priority: "medium",
      dueLocalDate: shiftLocalDate(localDate, 1),
      columnKey: "not-started",
      status: "open",
      position: 0,
    },
    {
      id: "demo-onboarding-sequence",
      title: "Outline the onboarding email sequence",
      description:
        "Sketch the five-message arc from welcome through first value, with one clear action in each email.",
      project: "Lifecycle",
      priority: "low",
      dueLocalDate: shiftLocalDate(localDate, 2),
      columnKey: "not-started",
      status: "open",
      position: 1,
    },
    {
      id: "demo-pilot-feedback",
      title: "Consolidate pilot workshop feedback",
      description:
        "Group the workshop notes into product, process, and commercial themes.",
      project: "Horizon Pilot",
      priority: "medium",
      dueLocalDate: yesterday,
      columnKey: "done",
      status: "done",
      position: 0,
    },
    {
      id: "demo-delivery-scorecard",
      title: "Publish the weekly delivery scorecard",
      description:
        "Share the final delivery metrics and flag the two items that need an owner this week.",
      project: "Operations",
      priority: "medium",
      dueLocalDate: yesterday,
      columnKey: "done",
      status: "done",
      position: 1,
    },
  ];
}

function seedBoard(tasks: SeedTask[], now: Date, yesterday: string): void {
  const db = openLocalDatabase(demoDbPath);
  try {
    const columns = db.prepare(
      "SELECT id, name, position FROM task_columns ORDER BY position, id",
    ).all() as ColumnRow[];
    const columnIdByKey = new Map(
      TASK_COLUMNS.map((canonical) => [
        canonical.key,
        columns.find((column) => column.name === canonical.name)?.id,
      ]),
    );
    for (const canonical of TASK_COLUMNS) {
      assert.ok(columnIdByKey.get(canonical.key), `Missing ${canonical.name} column.`);
    }

    const insert = db.prepare(
      `INSERT INTO tasks
        (id, column_id, title, description, priority, due_at, due_date, tags,
         project, position, status, source_type, remind_native, remind_text,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0, 0, ?, ?)`,
    );
    const createdAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const openUpdatedAt = now.toISOString();
    const doneUpdatedAt = `${yesterday}T18:00:00.000Z`;
    const transaction = db.transaction(() => {
      for (const task of tasks) {
        insert.run(
          task.id,
          columnIdByKey.get(task.columnKey),
          task.title,
          task.description,
          task.priority,
          task.dueLocalDate,
          task.dueLocalDate,
          JSON.stringify(["demo"]),
          task.project,
          task.position,
          task.status,
          createdAt,
          task.status === "done" ? doneUpdatedAt : openUpdatedAt,
        );
      }
    });
    transaction();
  } finally {
    db.close();
  }
}

function insertBrief(
  tasks: SeedTask[],
  localDate: string,
  now: Date,
  noClaude: boolean,
): string {
  const focusOwners = noClaude
    ? (["me", "me", "me"] as const)
    : (["me", "together", "me"] as const);
  const focusTaskIds = [
    "demo-horizon-one-pager",
    "demo-pricing-experiment",
    "demo-ops-review",
  ];
  const { brief } = validateMorningBrief(
    {
      headline: "Lock the Horizon pilot story before the day fragments.",
      narrative_paragraphs: [
        "The Horizon one-pager is the decisive move today. The scope and success measures are already clear enough to write, and a finished draft gives the partner something concrete to react to instead of another planning conversation.",
        "The Q3 pricing experiment needs one contained decision: who sees the test, where the package boundary sits, and what result earns a wider rollout. Work through that choice together, then leave the final call recorded on the task.",
        "Use the ops review to protect delivery, not to retell the week. Bring the two real risks, the decisions they need, and the owner for each next step. The Meridian follow-up and onboarding sequence can wait until the core three are moving.",
      ],
      existing_task_candidates: focusTaskIds.map((taskId, index) => ({
        task_id: taskId,
        why_today: [
          "A partner-ready draft turns the Horizon pilot from a conversation into a concrete next step.",
          "The experiment cannot launch until its audience, package boundary, and success threshold are decided.",
          "The ops review needs a decision-led agenda before the team meets.",
        ][index],
        suggested_owner: focusOwners[index],
        what_claude_can_start:
          index === 1 && !noClaude
            ? "Draft a concise pricing-test decision frame with options, tradeoffs, and a recommended threshold."
            : "",
        evidence_refs: [`demo_tasks:${taskId}`],
      })),
      watch_items: [
        {
          label: "Horizon scope",
          evidence:
            "The one-pager still needs one crisp success measure and a clear boundary around what the pilot does not include.",
          last_seen_state: "Draft structure agreed; partner version not written.",
          evidence_refs: ["demo_tasks:demo-horizon-one-pager"],
        },
        {
          label: "Pricing decision",
          evidence:
            "The test audience and success threshold remain open, so the experiment cannot be scheduled yet.",
          last_seen_state: "Three options captured; decision pending.",
          evidence_refs: ["demo_tasks:demo-pricing-experiment"],
        },
        {
          label: "Meridian introduction",
          evidence:
            "The promised context is ready, but the follow-up can wait until today's three commitments are underway.",
          last_seen_state: "Introduction received; reply not sent.",
          evidence_refs: ["demo_tasks:demo-meridian-intro"],
        },
      ],
      board_actions: [],
    },
    {
      knownTaskIds: new Set(tasks.map((task) => task.id)),
      sourceIds: new Set(["demo_tasks"]),
    },
  );

  const briefId = `demo-brief-${localDate}`;
  const briefJson = JSON.stringify({ writer: "codex", ...brief });
  const createdAt = new Date(now.getTime() - 5_000).toISOString();
  const startedAt = new Date(now.getTime() - 3_000).toISOString();
  const finishedAt = new Date(now.getTime() - 1_000).toISOString();
  const db = openSqliteDatabase(demoDbPath);
  try {
    db.prepare(
      `INSERT INTO day_plan_briefs
        (id, target_local_date, status, input_hash, prompt_version, schema_version,
         source_manifest_json, model_alias, effort, budget_usd, brief_json,
         error_code, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, 'succeeded', ?, ?, ?, ?, 'sonnet', 'medium', 0, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      briefId,
      localDate,
      `demo-seed:${localDate}:${noClaude ? "no-claude" : "one-together"}`,
      MORNING_BRIEF_PROMPT_VERSION,
      MORNING_BRIEF_SCHEMA_VERSION,
      JSON.stringify({
        sources: [
          {
            id: "demo_tasks",
            required: true,
            freshness: "current",
            asOf: now.toISOString(),
            hash: `demo-tasks-${localDate}`,
            chars: tasks.reduce(
              (total, task) => total + task.title.length + task.description.length,
              0,
            ),
            trimmed: false,
          },
        ],
        coverage: { tasks: "included" },
        trims: [],
        totalChars: tasks.reduce(
          (total, task) => total + task.title.length + task.description.length,
          0,
        ),
      }),
      briefJson,
      createdAt,
      finishedAt,
      startedAt,
      finishedAt,
    );
  } finally {
    db.close();
  }
  return briefId;
}

function buildPlan(
  store: DayPlanStore,
  tasks: SeedTask[],
  localDate: string,
  now: Date,
  noClaude: boolean,
) {
  const focusTaskIds = new Set([
    "demo-horizon-one-pager",
    "demo-pricing-experiment",
    "demo-ops-review",
  ]);
  const ownerByTaskId = new Map<string, "me" | "together">([
    ["demo-horizon-one-pager", "me"],
    ["demo-pricing-experiment", noClaude ? "me" : "together"],
    ["demo-ops-review", "me"],
  ]);
  const candidates = buildDayPlanCandidates(
    {
      localDate,
      timezone: demoTimezone,
      tasks: tasks
        .filter((task) => focusTaskIds.has(task.id))
        .map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          dueAt: task.dueLocalDate,
          position: task.position,
          column: "today" as const,
          status: "open" as const,
          updatedAt: now.toISOString(),
          refreshedAt: now.toISOString(),
          owner: ownerByTaskId.get(task.id) ?? "me",
          outcome: task.description,
          definitionOfDone: `A review-ready result is attached to ${task.title}.`,
          project: task.project,
        })),
    },
    3,
  );
  assert.equal(candidates.length, 3, "The demo needs exactly three arrival candidates.");
  const ensured = store.ensureDayPlan({
    localDate,
    timezone: demoTimezone,
    mutationId: `demo-seed:ensure:${localDate}`,
    candidates,
    creation: "manual",
  });
  assert.equal("weekendGate" in ensured, false, "Manual demo seed must work on weekends.");
  if ("weekendGate" in ensured) throw new Error("Demo plan was unexpectedly weekend-gated.");
  return ensured.plan;
}

function verifySeed(
  store: DayPlanStore,
  expectedBriefId: string,
  localDate: string,
  noClaude: boolean,
): string[] {
  const checks: string[] = [];
  const settings = readTaskSettings(demoDataDir);
  assert.deepEqual(settings, { stale_after_days: 14, focus_count: 3 });
  checks.push("focus_count is 3");

  const plan = store.getPlanForDate(localDate);
  assert.ok(plan, "The current-date day plan is missing.");
  assert.equal(plan.localDate, localDate);
  assert.equal(plan.state, "proposed");
  assert.equal(plan.arrivalState, "due");
  assert.equal(plan.settlementState, "not_due");
  assert.equal(plan.items.length, 3);
  assert.equal(plan.items.every((item) => item.decision === "preselected"), true);
  assert.equal(plan.briefId, expectedBriefId);
  const focus = focusBandItems(plan.items, settings.focus_count);
  assert.equal(focus.length, 3);
  assert.deepEqual(
    focus.map((item) => item.owner),
    noClaude ? ["me", "me", "me"] : ["me", "together", "me"],
  );
  checks.push(
    noClaude
      ? "proposed arrival has 3 Me-owned focus items"
      : "proposed arrival has owners Me, Together, Me",
  );

  const artifact = store.getMorningBrief(expectedBriefId);
  const brief = morningBriefFromArtifact(artifact);
  assert.ok(artifact && artifact.status === "succeeded");
  assert.ok(brief, "The attached demo brief does not parse.");
  assert.equal(brief.narrativeParagraphs.length, 3);
  assert.equal(brief.watchItems.length, 3);
  assert.ok(brief.lensNarrative.trim().length > 0);
  checks.push("attached brief has 3 paragraphs and 3 watch items");

  const db = openSqliteDatabase(demoDbPath);
  try {
    const taskCounts = db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count
       FROM tasks`,
    ).get() as { open_count: number; done_count: number };
    assert.deepEqual(taskCounts, { open_count: 5, done_count: 2 });

    const columns = db.prepare(
      "SELECT name, position FROM task_columns ORDER BY position, name",
    ).all();
    assert.deepEqual(
      columns,
      TASK_COLUMNS.map((column) => ({ name: column.name, position: column.position })),
    );
    checks.push("board has 4 canonical columns, 5 open tasks, and 2 done tasks");

    const taskRows = db.prepare(
      `SELECT id, column_id, due_at, position, priority, tags, status, updated_at,
              recurring_template_id
       FROM tasks
       WHERE status = 'open'`,
    ).all() as TaskRow[];
    const doneColumnId = (db.prepare(
      "SELECT id FROM task_columns WHERE name = 'Done'",
    ).pluck().get() as string | undefined);
    const bench = eligibleNotTodayTasks(
      taskRows.map((row) => ({
        id: row.id,
        columnId: row.column_id,
        dueAt: row.due_at,
        position: row.position,
        priority: row.priority,
        tags: JSON.parse(row.tags) as string[],
        status: row.status,
        updatedAt: Date.parse(row.updated_at),
        recurringTemplateId: row.recurring_template_id ?? undefined,
      })),
      plan.items,
      { doneColumnId },
    );
    assert.deepEqual(
      bench.map((task) => task.id),
      ["demo-meridian-intro", "demo-onboarding-sequence"],
    );
    checks.push("2 open tasks are eligible for the Not today bench");

    const activeBriefs = db.prepare(
      "SELECT COUNT(*) FROM day_plan_briefs WHERE status IN ('queued', 'running')",
    ).pluck().get() as number;
    assert.equal(activeBriefs, 0);
    for (const table of ["cove_receipts", "email_items"]) {
      assert.equal(
        db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?")
          .pluck().get(table),
        1,
      );
    }
    assert.equal(db.prepare("SELECT COUNT(*) FROM email_items").pluck().get(), 0);
    checks.push("brief generation queue is empty and email state is isolated and empty");
  } finally {
    db.close();
  }

  const runtimePaths = [
    ["database", demoDbPath],
    ["data directory", coveDataDir()],
    ["task settings", taskSettingsPath()],
    ["operator profile", operatorProfilePath()],
    ["workspace config", workspaceConfigPath()],
    ["email data directory", resolveEmailRuntimePaths({ repoDir }).dataDir],
    ["email database", resolveEmailRuntimePaths({ repoDir }).dbPath],
    ["execution config", coveEnv("EXECUTION_CONFIG") ?? ""],
    ["brief goals", coveEnv("BRIEF_GOALS_PATH") ?? ""],
    ["brief sprint memo", coveEnv("BRIEF_SPRINT_MEMO_PATH") ?? ""],
    ["brief operator profile", coveEnv("BRIEF_OPERATOR_PROFILE_PATH") ?? ""],
    ["brief leadup", coveEnv("BRIEF_LEADUP_PATH") ?? ""],
    ["brief memory", coveEnv("BRIEF_MEMORY_PATH") ?? ""],
    ["supernova directory", process.env.COVE_SUPERNOVA_DIR ?? ""],
  ];
  for (const [label, file] of runtimePaths) {
    assert.equal(
      pathIsInside(demoDataDir, file),
      true,
      `${label} escaped the demo directory: ${file}`,
    );
    if (label !== "workspace config") {
      assert.equal(existsSync(file), true, `${label} is missing: ${file}`);
    }
  }
  assert.equal(process.env.ATTIO_API_KEY, "");
  assert.equal(process.env.ATTIO_TOKEN, "");
  assert.equal(process.env.COVE_BRIEF_JARVIS_URL, "");
  assert.equal(existsSync(workspaceConfigPath()), false);
  checks.push(
    "database, settings, profile, execution, brief sources, workspace, receipts, and email paths are isolated",
  );

  return checks;
}

function main(): void {
  const allowedArgs = new Set(["--no-claude"]);
  const unknownArgs = process.argv.slice(2).filter((arg) => !allowedArgs.has(arg));
  assert.deepEqual(unknownArgs, [], `Unknown demo seed arguments: ${unknownArgs.join(", ")}`);
  const noClaude = process.argv.includes("--no-claude");
  const realDataMtimesBefore = new Map(
    realDataGuardPaths.map((file) => [file, statMtimeNs(file)]),
  );

  assertSafeDemoPaths();
  configureDemoEnvironment();
  rmSync(demoDataDir, { recursive: true, force: true });
  mkdirSync(demoDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(demoBriefDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(demoDataDir, "supernova"), { recursive: true, mode: 0o700 });
  writeJson(taskSettingsPath(demoDataDir), {
    stale_after_days: 14,
    focus_count: 3,
  });
  writeJson(demoProfilePath, {
    name: "Alex",
    timezone: demoTimezone,
  });
  writeJson(demoExecutionConfigPath, { workspaces: [] });
  writeFileSync(
    demoGoalsPath,
    "# Demo goals\n\nMake the Horizon pilot concrete and protect delivery focus.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    demoSprintMemoPath,
    "# Demo sprint\n\nFinish the partner narrative, pricing decision, and ops review agenda.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    demoOperatorBriefPath,
    "# Demo operator\n\nAlex is rehearsing Cove with fictional business data.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    demoLeadupPath,
    "# Demo leadup\n\nThe Horizon partner is ready for a concrete pilot proposal.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    demoMemoryPath,
    "# Demo memory\n\nKeep the pilot scope narrow and make every review decision-led.\n",
    { encoding: "utf8", mode: 0o600 },
  );

  const now = new Date();
  const localDate = localDateInTimezone(now, demoTimezone);
  const yesterday = shiftLocalDate(localDate, -1);
  const tasks = seedTasks(localDate, yesterday);
  seedBoard(tasks, now, yesterday);

  let store: DayPlanStore | undefined;
  let checks: string[] = [];
  try {
    store = createDayPlanStore({ dbPath: demoDbPath, now: () => new Date(now) });
    const briefId = insertBrief(tasks, localDate, now, noClaude);
    buildPlan(store, tasks, localDate, now, noClaude);
    checks = verifySeed(store, briefId, localDate, noClaude);
  } finally {
    store?.close();
  }

  for (const file of realDataGuardPaths) {
    assert.equal(
      statMtimeNs(file),
      realDataMtimesBefore.get(file),
      `Real data file changed or was created while seeding the demo: ${path.basename(file)}`,
    );
  }

  console.log(`Demo seed ready for ${localDate} (${demoTimezone}).`);
  console.log(`Mode: ${noClaude ? "no Claude dispatch" : "one Together-owned focus task"}.`);
  console.log(`Database: ${path.relative(repoDir, demoDbPath)}`);
  for (const check of checks) console.log(`PASS: ${check}`);
  console.log("PASS: real database, WAL, SHM, profile, task settings, and workspace mtimes are unchanged");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
