import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { localDatabasePath, openLocalDatabase } from "../local/database";
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  PipelineValidationError,
  type CreatePipelineDealInput,
  type LogPipelineTouchInput,
  type PipelineDealWithContact,
  type PipelineStage,
  validateLogPipelineTouch,
  validatePipelineNote,
  validatePipelinePatch,
  validatePipelineStage,
} from "./pipeline";

type DealRow = Record<string, unknown> & {
  id: string;
  contact_id: string;
  stage: string;
};

type ContactRow = {
  id: string;
  company_id: string | null;
};

export class PipelineCollisionError extends Error {
  readonly name = "PipelineCollisionError";
}

export class PipelineNotFoundError extends Error {
  readonly name = "PipelineNotFoundError";
}

const STAGE_ORDER_SQL = PIPELINE_STAGES.map(
  (stage, index) => `WHEN '${stage.id}' THEN ${index}`,
).join(" ");

const DEAL_WITH_CONTACT_SELECT = `
  SELECT pipeline_deals.*,
         contacts.name AS name,
         COALESCE(NULLIF(companies.name, ''), NULLIF(contacts.company, ''), '') AS company,
         contacts.email AS email,
         contacts.phone AS phone,
         contacts.last_interaction_at AS last_interaction_at
  FROM pipeline_deals
  JOIN contacts ON contacts.id = pipeline_deals.contact_id
  LEFT JOIN companies ON companies.id = contacts.company_id
`;

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableAmount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function decodeDeal(row: DealRow): PipelineDealWithContact {
  const stage = validatePipelineStage(row.stage);
  return {
    id: requiredText(row.id),
    contact_id: requiredText(row.contact_id),
    stage,
    monthly_value: nullableAmount(row.monthly_value),
    discovery_price: nullableAmount(row.discovery_price),
    next_action: requiredText(row.next_action),
    next_follow_up_at: nullableText(row.next_follow_up_at),
    source: requiredText(row.source),
    notes: requiredText(row.notes),
    last_touch_at: nullableText(row.last_touch_at),
    stage_changed_at: requiredText(row.stage_changed_at),
    created_at: requiredText(row.created_at),
    updated_at: requiredText(row.updated_at),
    name: requiredText(row.name),
    company: requiredText(row.company),
    email: nullableText(row.email),
    phone: nullableText(row.phone),
    last_interaction_at: nullableText(row.last_interaction_at),
  };
}

export class LocalPipelineStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: {
    dataDir?: string;
    dbPath?: string;
    now?: () => Date;
  } = {}) {
    const dbPath = options.dbPath ?? (
      options.dataDir ? path.join(options.dataDir, "cove.db") : localDatabasePath()
    );
    this.db = openLocalDatabase(dbPath);
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  list(): PipelineDealWithContact[] {
    const rows = this.db.prepare(`
      ${DEAL_WITH_CONTACT_SELECT}
      ORDER BY CASE pipeline_deals.stage ${STAGE_ORDER_SQL} ELSE 999 END,
               CASE WHEN pipeline_deals.next_follow_up_at IS NULL THEN 1 ELSE 0 END,
               pipeline_deals.next_follow_up_at ASC,
               contacts.name COLLATE NOCASE ASC,
               pipeline_deals.id ASC
    `).all() as DealRow[];
    return rows.map(decodeDeal);
  }

  get(contactId: string): PipelineDealWithContact | null {
    const normalized = contactId.trim();
    if (!normalized) throw new PipelineValidationError("Contact id is required.");
    const row = this.db.prepare(`
      ${DEAL_WITH_CONTACT_SELECT}
      WHERE pipeline_deals.contact_id = ?
    `).get(normalized) as DealRow | undefined;
    return row ? decodeDeal(row) : null;
  }

  create(input: CreatePipelineDealInput): PipelineDealWithContact {
    const contactId = input.contactId?.trim();
    if (!contactId) throw new PipelineValidationError("Contact id is required.");
    const stage = validatePipelineStage(input.stage);
    const raw = input as CreatePipelineDealInput & Record<string, unknown>;
    const patch = validatePipelinePatch(Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "contactId" && key !== "stage"),
    ));
    return this.db.transaction(() => {
      const contact = this.contact(contactId);
      if (this.dealRow(contactId)) {
        throw new PipelineValidationError("This contact already has a pipeline deal.");
      }
      const now = this.now().toISOString();
      this.db.prepare(
        `INSERT INTO pipeline_deals
           (id, contact_id, stage, monthly_value, discovery_price, next_action,
            next_follow_up_at, source, notes, last_touch_at, stage_changed_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        randomUUID(),
        contactId,
        stage,
        patch.monthlyValue ?? null,
        patch.discoveryPrice ?? null,
        patch.nextAction ?? "",
        patch.nextFollowUpAt ?? null,
        patch.source ?? "",
        patch.notes ?? "",
        now,
        now,
        now,
      );
      this.insertStageActivity(contact, null, stage, undefined, now);
      return this.requiredDeal(contactId);
    }).immediate();
  }

  update(contactId: string, value: unknown): PipelineDealWithContact {
    const normalized = contactId.trim();
    if (!normalized) throw new PipelineValidationError("Contact id is required.");
    const patch = validatePipelinePatch(value);
    return this.db.transaction(() => {
      this.requireContactAndDeal(normalized);
      const fields: string[] = [];
      const values: unknown[] = [];
      const add = (column: string, fieldValue: unknown) => {
        fields.push(`${column} = ?`);
        values.push(fieldValue);
      };
      if (Object.hasOwn(patch, "monthlyValue")) add("monthly_value", patch.monthlyValue);
      if (Object.hasOwn(patch, "discoveryPrice")) add("discovery_price", patch.discoveryPrice);
      if (Object.hasOwn(patch, "nextAction")) add("next_action", patch.nextAction);
      if (Object.hasOwn(patch, "nextFollowUpAt")) {
        add("next_follow_up_at", patch.nextFollowUpAt);
      }
      if (Object.hasOwn(patch, "source")) add("source", patch.source);
      if (Object.hasOwn(patch, "notes")) add("notes", patch.notes);
      if (fields.length > 0) {
        add("updated_at", this.now().toISOString());
        this.db.prepare(
          `UPDATE pipeline_deals SET ${fields.join(", ")} WHERE contact_id = ?`,
        ).run(...values, normalized);
      }
      return this.requiredDeal(normalized);
    }).immediate();
  }

  move(
    contactId: string,
    stageValue: unknown,
    noteValue?: unknown,
  ): PipelineDealWithContact {
    const normalized = contactId.trim();
    if (!normalized) throw new PipelineValidationError("Contact id is required.");
    const stage = validatePipelineStage(stageValue);
    const note = validatePipelineNote(noteValue);
    return this.db.transaction(() => {
      const { contact, deal } = this.requireContactAndDeal(normalized);
      const from = validatePipelineStage(deal.stage);
      if (from === stage) return this.requiredDeal(normalized);
      const now = this.now().toISOString();
      this.db.prepare(
        `UPDATE pipeline_deals
         SET stage = ?, stage_changed_at = ?, updated_at = ?
         WHERE contact_id = ?`,
      ).run(stage, now, now, normalized);
      this.insertStageActivity(contact, from, stage, note, now);
      return this.requiredDeal(normalized);
    }).immediate();
  }

  logTouch(
    contactId: string,
    value: unknown,
  ): PipelineDealWithContact {
    const normalized = contactId.trim();
    if (!normalized) throw new PipelineValidationError("Contact id is required.");
    const input = validateLogPipelineTouch(value);
    return this.db.transaction(() => {
      const { contact, deal } = this.requireContactAndDeal(normalized);
      const from = validatePipelineStage(deal.stage);
      const now = this.now().toISOString();
      this.insertTouchActivity(contact, input, now);
      this.db.prepare(
        `UPDATE contacts
         SET last_interaction_at = ?, last_contact_date = ?, updated_at = ?
         WHERE id = ?`,
      ).run(now, now, now, normalized);

      const fields = ["last_touch_at = ?", "updated_at = ?"];
      const values: unknown[] = [now, now];
      if (Object.hasOwn(input, "nextAction")) {
        fields.push("next_action = ?");
        values.push(input.nextAction);
      }
      if (Object.hasOwn(input, "nextFollowUpAt")) {
        fields.push("next_follow_up_at = ?");
        values.push(input.nextFollowUpAt);
      }
      const stageChanged = input.stage !== undefined && input.stage !== from;
      if (stageChanged) {
        fields.push("stage = ?", "stage_changed_at = ?");
        values.push(input.stage, now);
      }
      this.db.prepare(
        `UPDATE pipeline_deals SET ${fields.join(", ")} WHERE contact_id = ?`,
      ).run(...values, normalized);
      if (stageChanged) {
        this.insertStageActivity(contact, from, input.stage!, undefined, now);
      }
      return this.requiredDeal(normalized);
    }).immediate();
  }

  reparent(
    fromContactId: string,
    toContactId: string,
  ): PipelineDealWithContact | null {
    const from = fromContactId.trim();
    const to = toContactId.trim();
    if (!from || !to) throw new PipelineValidationError("Both contact ids are required.");
    if (from === to) return this.get(from);
    return this.db.transaction(() => {
      const source = this.dealRow(from);
      if (!source) return null;
      this.contact(to);
      if (this.dealRow(to)) {
        throw new PipelineCollisionError(
          "Both contacts already have pipeline deals. Move or close one deal before merging.",
        );
      }
      this.db.prepare(
        `UPDATE pipeline_deals SET contact_id = ?, updated_at = ? WHERE contact_id = ?`,
      ).run(to, this.now().toISOString(), from);
      return this.requiredDeal(to);
    }).immediate();
  }

  remove(contactId: string): boolean {
    const normalized = contactId.trim();
    if (!normalized) throw new PipelineValidationError("Contact id is required.");
    return this.db.prepare(
      "DELETE FROM pipeline_deals WHERE contact_id = ?",
    ).run(normalized).changes === 1;
  }

  private contact(contactId: string): ContactRow {
    const row = this.db.prepare(
      "SELECT id, company_id FROM contacts WHERE id = ?",
    ).get(contactId) as ContactRow | undefined;
    if (!row) throw new PipelineNotFoundError("Contact was not found.");
    return row;
  }

  private dealRow(contactId: string): DealRow | undefined {
    return this.db.prepare(
      "SELECT * FROM pipeline_deals WHERE contact_id = ?",
    ).get(contactId) as DealRow | undefined;
  }

  private requireContactAndDeal(contactId: string): {
    contact: ContactRow;
    deal: DealRow;
  } {
    const contact = this.contact(contactId);
    const deal = this.dealRow(contactId);
    if (!deal) throw new PipelineNotFoundError("Pipeline deal was not found.");
    return { contact, deal };
  }

  private requiredDeal(contactId: string): PipelineDealWithContact {
    const deal = this.get(contactId);
    if (!deal) throw new PipelineNotFoundError("Pipeline deal was not found.");
    return deal;
  }

  private insertStageActivity(
    contact: ContactRow,
    from: PipelineStage | null,
    to: PipelineStage,
    note: string | undefined,
    now: string,
  ): void {
    this.db.prepare(
      `INSERT INTO contact_activities
         (id, contact_id, company_id, activity_type, title, content, direction,
          metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'pipeline_stage', ?, ?, 'internal', ?, ?, ?)`,
    ).run(
      randomUUID(),
      contact.id,
      contact.company_id,
      from === null
        ? `Added to pipeline: ${PIPELINE_STAGE_LABELS[to]}`
        : `Moved to ${PIPELINE_STAGE_LABELS[to]}`,
      note ?? null,
      JSON.stringify({ from, to, source: "pipeline" }),
      now,
      now,
    );
  }

  private insertTouchActivity(
    contact: ContactRow,
    input: LogPipelineTouchInput,
    now: string,
  ): void {
    this.db.prepare(
      `INSERT INTO contact_activities
         (id, contact_id, company_id, activity_type, title, content, direction,
          metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      contact.id,
      contact.company_id,
      input.activityType,
      input.title,
      input.content?.trim() || null,
      input.direction ?? "outbound",
      JSON.stringify({ source: "pipeline" }),
      now,
      now,
    );
  }
}
