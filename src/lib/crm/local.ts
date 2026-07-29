import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Contact, ContactActivity } from "../data/types";
import { openLocalDatabase } from "../local/database";
import {
  isPlausibleFullName,
  normalizeContactEmail,
  normalizeContactName,
} from "./identity";
import type {
  AppendContactActivityInput,
  ContactCandidate,
  ContactResolution,
  ContactWithActivities,
  CRMBackend,
  ExplicitContactCreation,
  ExplicitCreateContactInput,
  MeetingContactActivityInput,
  MeetingContactActivityResult,
  ResolveContactInput,
} from "./types";

type ContactRow = Record<string, unknown> & {
  id: string;
  company_id: string | null;
  name: string;
  email: string | null;
  tags: string | null;
};

type ActivityRow = Record<string, unknown> & {
  id: string;
  contact_id: string | null;
  company_id: string | null;
  activity_type: string;
  title: string | null;
  content: string | null;
  direction: "inbound" | "outbound" | "internal" | null;
  metadata: string | null;
  created_at: string;
};

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function decodeContact(row: ContactRow): Contact {
  return {
    ...(row as unknown as Contact),
    tags: parseStringArray(row.tags),
  };
}

function decodeActivity(row: ActivityRow): ContactActivity {
  return {
    ...(row as unknown as ContactActivity),
    metadata: parseObject(row.metadata),
  };
}

function candidate(row: ContactRow): ContactCandidate {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    companyId: row.company_id,
  };
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function validSource(
  value: unknown,
): value is ResolveContactInput["source"] {
  return value === "meeting-notes" || value === "email" || value === "manual";
}

export class LocalCRMBackend implements CRMBackend {
  readonly kind = "local" as const;
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: { dbPath?: string; now?: () => Date } = {}) {
    this.db = openLocalDatabase(options.dbPath);
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  private findRowsByNormalizedEmail(email: string): ContactRow[] {
    return this.db.prepare(
      `SELECT *
       FROM contacts
       WHERE normalized_email = ?
       ORDER BY COALESCE(created_at, ''), id`,
    ).all(email) as ContactRow[];
  }

  private findByNormalizedName(name: string): ContactRow[] {
    return this.db.prepare(
      `SELECT *
       FROM contacts
       WHERE normalized_name = ?
       ORDER BY COALESCE(created_at, ''), id`,
    ).all(name) as ContactRow[];
  }

  private partialNameCandidates(token: string): ContactRow[] {
    const queryTokens = token
      .split(" ")
      .filter((part) => /\p{L}/u.test(part));
    if (queryTokens.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT *
       FROM contacts
       WHERE normalized_name IS NOT NULL
       ORDER BY COALESCE(created_at, ''), id`,
    ).all() as ContactRow[];
    return rows.filter((row) => {
      const rowTokens = String(row.normalized_name ?? "").split(" ");
      return queryTokens.some((part) => rowTokens.includes(part));
    });
  }

  findByNormalizedEmail(email: string): Contact[] {
    const normalizedEmail = normalizeContactEmail(email);
    if (!normalizedEmail) return [];
    return this.findRowsByNormalizedEmail(normalizedEmail).map(decodeContact);
  }

  resolveOrCreateContact(input: ResolveContactInput): ContactResolution {
    if (!validSource(input.source)) {
      throw new Error("Contact provenance source is invalid.");
    }
    return this.db.transaction(
      () => this.resolveOrCreateContactInTransaction(input),
    ).immediate();
  }

  private resolveOrCreateContactInTransaction(
    input: ResolveContactInput,
  ): ContactResolution {
    const name = input.name.trim().replace(/\s+/g, " ");
    const normalizedName = normalizeContactName(name);
    const normalizedEmail = normalizeContactEmail(input.email);

    if (normalizedEmail) {
      const emailMatches = this.findRowsByNormalizedEmail(normalizedEmail);
      if (emailMatches.length === 1) {
        return {
          status: "matched",
          contact: decodeContact(emailMatches[0]),
        };
      }
      if (emailMatches.length > 1) {
        return {
          status: "ambiguous",
          candidates: emailMatches.map(candidate),
        };
      }
    }

    if (!isPlausibleFullName(name)) {
      const candidates = normalizedName
        ? this.partialNameCandidates(normalizedName).map(candidate)
        : [];
      return { status: "ambiguous", candidates };
    }

    const nameMatches = this.findByNormalizedName(normalizedName);
    if (nameMatches.length === 1) {
      const existingEmail = normalizeContactEmail(
        nameMatches[0].email ?? undefined,
      );
      if (
        normalizedEmail &&
        existingEmail &&
        normalizedEmail !== existingEmail
      ) {
        return {
          status: "ambiguous",
          candidates: nameMatches.map(candidate),
        };
      }
      if (normalizedEmail && !existingEmail) {
        const now = this.now().toISOString();
        this.db.prepare(
          `UPDATE contacts
           SET email = ?, normalized_email = ?, updated_at = ?
           WHERE id = ?
             AND (email IS NULL OR trim(email) = '')
             AND (normalized_email IS NULL OR normalized_email = '')`,
        ).run(
          normalizedEmail,
          normalizedEmail,
          now,
          nameMatches[0].id,
        );
        const locked = this.db.prepare(
          "SELECT * FROM contacts WHERE id = ?",
        ).get(nameMatches[0].id) as ContactRow;
        return {
          status: "matched",
          contact: decodeContact(locked),
        };
      }
      return {
        status: "matched",
        contact: decodeContact(nameMatches[0]),
      };
    }
    if (nameMatches.length > 1) {
      return {
        status: "ambiguous",
        candidates: nameMatches.map(candidate),
      };
    }

    return {
      status: "created",
      contact: this.insertContact(input, name, normalizedName, normalizedEmail),
    };
  }

  createContact(input: ExplicitCreateContactInput): ExplicitContactCreation {
    if (input.source !== "manual") {
      throw new Error("Explicit contact creation requires manual provenance.");
    }
    return this.db.transaction(() => {
      const name = input.name.trim().replace(/\s+/g, " ");
      if (!isPlausibleFullName(name, { explicit: true })) {
        throw new Error("A contact name is required.");
      }
      const normalizedName = normalizeContactName(name);
      const normalizedEmail = normalizeContactEmail(input.email);
      const emailMatches = normalizedEmail
        ? this.findRowsByNormalizedEmail(normalizedEmail)
        : [];
      if (emailMatches.length > 0) {
        throw new Error("That email already belongs to another contact.");
      }
      const nameMatches = this.findByNormalizedName(normalizedName);
      return {
        contact: this.insertContact(input, name, normalizedName, normalizedEmail),
        candidates: nameMatches.map(candidate),
      };
    }).immediate();
  }

  private insertContact(
    input: ResolveContactInput | ExplicitCreateContactInput,
    name: string,
    normalizedName: string,
    normalizedEmail: string | null,
  ): Contact {
    const now = this.now().toISOString();
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO contacts
         (id, company_id, name, normalized_name, email, normalized_email,
          phone, role, linkedin, location, how_we_met, tier, tags, notes,
          provenance_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId ?? null,
      name,
      normalizedName,
      normalizedEmail,
      normalizedEmail,
      input.phone?.trim() || null,
      input.role?.trim() || null,
      input.linkedin?.trim() || null,
      input.location?.trim() || null,
      input.howWeMet?.trim() || null,
      input.tier?.trim() || "C",
      JSON.stringify(input.tags ?? []),
      input.notes?.trim() || "",
      input.source,
      now,
      now,
    );
    const created = this.db.prepare(
      "SELECT * FROM contacts WHERE id = ?",
    ).get(id) as ContactRow;
    return decodeContact(created);
  }

  appendActivity(input: AppendContactActivityInput): ContactActivity {
    if (!validSource(input.source)) {
      throw new Error("Activity provenance source is invalid.");
    }
    const contactId = input.contactId.trim();
    const activityType = input.activityType.trim();
    const title = input.title.trim();
    if (!contactId) throw new Error("Contact id is required.");
    if (!activityType) throw new Error("Activity type is required.");
    if (!title) throw new Error("Activity title is required.");
    return this.db.transaction(
      () => this.appendActivityInTransaction(input),
    ).immediate();
  }

  private appendActivityInTransaction(
    input: AppendContactActivityInput,
  ): ContactActivity {
    const contactId = input.contactId.trim();
    const contact = this.db.prepare(
      "SELECT company_id FROM contacts WHERE id = ?",
    ).get(contactId) as { company_id: string | null } | undefined;
    if (!contact) throw new Error("Contact was not found.");

    const now = this.now().toISOString();
    const occurredAt = input.occurredAt ?? now;
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO contact_activities
         (id, contact_id, company_id, activity_type, title, content,
          direction, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      contactId,
      input.companyId ?? contact.company_id,
      input.activityType.trim(),
      input.title.trim(),
      input.content?.trim() || null,
      input.direction ?? "internal",
      JSON.stringify({ ...input.metadata, source: input.source }),
      occurredAt,
      now,
    );
    this.db.prepare(
      `UPDATE contacts
       SET last_interaction_at = CASE
             WHEN last_interaction_at IS NULL OR last_interaction_at < ?
               THEN ?
             ELSE last_interaction_at
           END,
           last_contact_date = CASE
             WHEN last_contact_date IS NULL OR last_contact_date < ?
               THEN ?
             ELSE last_contact_date
           END,
           updated_at = ?
       WHERE id = ?`,
    ).run(occurredAt, occurredAt, occurredAt, occurredAt, now, contactId);
    const row = this.db.prepare(
      "SELECT * FROM contact_activities WHERE id = ?",
    ).get(id) as ActivityRow;
    return decodeActivity(row);
  }

  resolveAndAppendMeetingActivity(
    input: MeetingContactActivityInput,
  ): MeetingContactActivityResult {
    if (!input.title.trim()) throw new Error("Activity title is required.");
    return this.db.transaction(() => {
      const resolution = this.resolveOrCreateContactInTransaction({
        ...input.contact,
        source: "meeting-notes",
      });
      if (resolution.status === "ambiguous") {
        return {
          status: "ambiguous" as const,
          contactId: null,
          candidates: resolution.candidates,
        };
      }
      const activity = this.appendActivityInTransaction({
        contactId: resolution.contact.id,
        companyId: resolution.contact.company_id ?? undefined,
        activityType: "meeting",
        title: input.title,
        content: input.content,
        direction: "internal",
        source: "meeting-notes",
        occurredAt: input.occurredAt,
        metadata: input.metadata,
      });
      return {
        status: resolution.status,
        contact: resolution.contact,
        contactId: resolution.contact.id,
        activity,
      };
    }).immediate();
  }

  getContactWithRecentActivities(
    contactId: string,
    limit = 20,
  ): ContactWithActivities | null {
    const row = this.db.prepare(
      "SELECT * FROM contacts WHERE id = ?",
    ).get(contactId) as ContactRow | undefined;
    if (!row) return null;
    const activities = this.db.prepare(
      `SELECT *
       FROM contact_activities
       WHERE contact_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(contactId, boundedLimit(limit, 20, 1_000)) as ActivityRow[];
    return {
      contact: decodeContact(row),
      activities: activities.map(decodeActivity),
    };
  }

  listContacts(options: { search?: string; limit?: number } = {}): Contact[] {
    const limit = boundedLimit(options.limit, 1_000, 5_000);
    const search = options.search?.trim().toLowerCase();
    const rows = search
      ? this.db.prepare(
          `SELECT contacts.*
           FROM contacts
           LEFT JOIN companies ON companies.id = contacts.company_id
           WHERE lower(contacts.name) LIKE ?
              OR lower(COALESCE(contacts.email, '')) LIKE ?
              OR lower(COALESCE(contacts.tags, '')) LIKE ?
              OR lower(COALESCE(companies.name, '')) LIKE ?
           ORDER BY contacts.name COLLATE NOCASE, contacts.id
           LIMIT ?`,
        ).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, limit)
      : this.db.prepare(
          `SELECT *
           FROM contacts
           ORDER BY name COLLATE NOCASE, id
           LIMIT ?`,
        ).all(limit);
    return (rows as ContactRow[]).map(decodeContact);
  }

  updateContact(contactId: string, patch: Partial<Contact>): Contact | null {
    const allowed = new Set([
      "company_id",
      "name",
      "email",
      "phone",
      "role",
      "linkedin",
      "location",
      "how_we_met",
      "tier",
      "tags",
      "notes",
      "last_interaction_at",
    ]);
    const updates: string[] = [];
    const values: unknown[] = [];
    for (const [key, rawValue] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      let value: unknown = rawValue;
      if (key === "tags") value = JSON.stringify(rawValue ?? []);
      if (key === "name" && typeof rawValue === "string") {
        const name = rawValue.trim().replace(/\s+/g, " ");
        if (!isPlausibleFullName(name)) {
          throw new Error("A plausible full name is required.");
        }
        value = name;
        updates.push("normalized_name = ?");
        values.push(normalizeContactName(name));
      }
      if (key === "email") {
        value = typeof rawValue === "string"
          ? normalizeContactEmail(rawValue)
          : null;
        if (value) {
          const duplicate = this.db.prepare(
            `SELECT id FROM contacts
             WHERE normalized_email = ? AND id <> ?
             LIMIT 1`,
          ).get(value, contactId);
          if (duplicate) {
            throw new Error("That email already belongs to another contact.");
          }
        }
        updates.push("normalized_email = ?");
        values.push(value);
      }
      updates.push(`"${key}" = ?`);
      values.push(value ?? null);
    }
    if (updates.length === 0) {
      const current = this.db.prepare(
        "SELECT * FROM contacts WHERE id = ?",
      ).get(contactId) as ContactRow | undefined;
      return current ? decodeContact(current) : null;
    }
    updates.push("updated_at = ?");
    values.push(this.now().toISOString(), contactId);
    const row = this.db.prepare(
      `UPDATE contacts
       SET ${updates.join(", ")}
       WHERE id = ?
       RETURNING *`,
    ).get(...values) as ContactRow | undefined;
    return row ? decodeContact(row) : null;
  }

  deleteContact(contactId: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM contact_activities WHERE contact_id = ?",
      ).run(contactId);
      return this.db.prepare(
        "DELETE FROM contacts WHERE id = ?",
      ).run(contactId).changes === 1;
    }).immediate();
  }
}
