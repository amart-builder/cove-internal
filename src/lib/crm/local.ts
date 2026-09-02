/**
 * Transactional local CRM backend.
 *
 * Identity resolution prefers exact normalized email, then a weaker normalized
 * full name. Ambiguity is a result for the caller to resolve, never permission
 * to guess or create a duplicate. Activity append and last-contact updates share
 * one transaction.
 */
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

// activity_type, direction, and created_at are deliberately absent: the columns
// are nullable free text, so they stay `unknown` under the index signature and
// have to go through decodeActivity before anything can rely on them.
type ActivityRow = Record<string, unknown> & {
  id: string;
  contact_id: string | null;
  company_id: string | null;
  source_ref: string | null;
  title: string | null;
  content: string | null;
  metadata: string | null;
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

/**
 * SQLite is looser than the domain types. `tier`, `notes`, `activity_type`, and
 * `created_at` are nullable columns typed as required strings, `direction` is
 * free text typed as a three-member union, and any column a pending migration
 * has not added yet is simply missing from `SELECT *`. Spreading a raw row into
 * the domain type asserted all of that away, so a null or absent column reached
 * callers as a string and failed somewhere far from the cause. These decoders
 * build every field explicitly and fall back to the defaults the schema itself
 * declares.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function activityDirection(value: unknown): ContactActivity["direction"] {
  return value === "inbound" || value === "outbound" || value === "internal"
    ? value
    : null;
}

function decodeContact(row: ContactRow): Contact {
  return {
    id: text(row.id, ""),
    company_id: nullableText(row.company_id),
    name: text(row.name, ""),
    email: nullableText(row.email),
    phone: nullableText(row.phone),
    role: nullableText(row.role),
    linkedin: nullableText(row.linkedin),
    location: nullableText(row.location),
    how_we_met: nullableText(row.how_we_met),
    tier: text(row.tier, "C"),
    tags: parseStringArray(row.tags),
    notes: text(row.notes, ""),
    last_interaction_at: nullableText(row.last_interaction_at),
    provenance_source: nullableText(row.provenance_source),
    created_at: optionalText(row.created_at),
    updated_at: optionalText(row.updated_at),
  };
}

function decodeActivity(row: ActivityRow): ContactActivity {
  return {
    id: text(row.id, ""),
    contact_id: nullableText(row.contact_id),
    company_id: nullableText(row.company_id),
    source_ref: nullableText(row.source_ref),
    activity_type: text(row.activity_type, "note"),
    title: nullableText(row.title),
    content: nullableText(row.content),
    direction: activityDirection(row.direction),
    metadata: parseObject(row.metadata),
    created_at: text(row.created_at, ""),
    updated_at: optionalText(row.updated_at),
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

  // contact_emails is the source of truth for email resolution; the union
  // with contacts.normalized_email keeps legacy rows (including duplicate
  // legacy addresses, which must stay ambiguous) resolvable.
  private findRowsByNormalizedEmail(email: string): ContactRow[] {
    return this.db.prepare(
      `SELECT *
       FROM contacts
       WHERE normalized_email = ?
          OR id IN (
            SELECT contact_id FROM contact_emails WHERE normalized_email = ?
          )
       ORDER BY COALESCE(created_at, ''), id`,
    ).all(email, email) as ContactRow[];
  }

  private hasKnownEmail(contactId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM contact_emails WHERE contact_id = ? LIMIT 1",
    ).get(contactId));
  }

  private insertContactEmail(input: {
    contactId: string;
    email: string;
    normalizedEmail: string;
    isPrimary: boolean;
    now: string;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO contact_emails
         (id, contact_id, email, normalized_email, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.contactId,
      input.email,
      input.normalizedEmail,
      input.isPrimary ? 1 : 0,
      input.now,
    );
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
      const hasKnownEmail =
        Boolean(normalizeContactEmail(nameMatches[0].email ?? undefined)) ||
        this.hasKnownEmail(nameMatches[0].id);
      if (normalizedEmail && hasKnownEmail) {
        // The incoming email did not match at step 1, so it is a DIFFERENT
        // address than every known one. A new address never auto-attaches to
        // an existing contact: that is what the explicit merge action is for.
        return {
          status: "ambiguous",
          candidates: nameMatches.map(candidate),
        };
      }
      if (normalizedEmail && !hasKnownEmail) {
        const now = this.now().toISOString();
        const locked = this.db.prepare(
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
        ).changes === 1;
        if (locked) {
          this.insertContactEmail({
            contactId: nameMatches[0].id,
            email: normalizedEmail,
            normalizedEmail,
            isPrimary: true,
            now,
          });
        }
        const row = this.db.prepare(
          "SELECT * FROM contacts WHERE id = ?",
        ).get(nameMatches[0].id) as ContactRow;
        return {
          status: "matched",
          contact: decodeContact(row),
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
    if (normalizedEmail) {
      this.insertContactEmail({
        contactId: id,
        email: normalizedEmail,
        normalizedEmail,
        isPrimary: true,
        now,
      });
    }
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
    const sourceRef = input.sourceRef?.trim() || null;
    if (sourceRef) {
      const existing = this.db.prepare(
        "SELECT * FROM contact_activities WHERE source_ref = ?",
      ).get(sourceRef) as ActivityRow | undefined;
      if (existing) {
        if (existing.contact_id !== contactId) {
          throw new Error("Activity source reference belongs to another contact.");
        }
        return decodeActivity(existing);
      }
    }
    const contact = this.db.prepare(
      "SELECT company_id FROM contacts WHERE id = ?",
    ).get(contactId) as { company_id: string | null } | undefined;
    if (!contact) throw new Error("Contact was not found.");

    const now = this.now().toISOString();
    const occurredAt = input.occurredAt ?? now;
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO contact_activities
         (id, contact_id, company_id, source_ref, activity_type, title,
          content, direction, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      contactId,
      input.companyId ?? contact.company_id,
      sourceRef,
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
        sourceRef: input.sourceRef,
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
    return this.db.transaction(
      () => this.updateContactInTransaction(contactId, patch),
    ).immediate();
  }

  private updateContactInTransaction(
    contactId: string,
    patch: Partial<Contact>,
  ): Contact | null {
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
    let newEmail: string | null | undefined;
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
          const duplicate = this.findRowsByNormalizedEmail(value as string)
            .find((row) => row.id !== contactId);
          if (duplicate) {
            throw new Error(
              "That email already belongs to another contact. If both rows are the same person, use the CRM merge action instead.",
            );
          }
        }
        newEmail = value as string | null;
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
    const now = this.now().toISOString();
    values.push(now, contactId);
    const row = this.db.prepare(
      `UPDATE contacts
       SET ${updates.join(", ")}
       WHERE id = ?
       RETURNING *`,
    ).get(...values) as ContactRow | undefined;
    if (!row) return null;
    if (newEmail !== undefined) {
      if (newEmail === null) {
        // Clearing the primary address forgets it; other known addresses stay.
        this.db.prepare(
          "DELETE FROM contact_emails WHERE contact_id = ? AND is_primary = 1",
        ).run(contactId);
      } else {
        // The old primary stays known as a secondary address.
        this.db.prepare(
          "UPDATE contact_emails SET is_primary = 0 WHERE contact_id = ?",
        ).run(contactId);
        this.insertContactEmail({
          contactId,
          email: newEmail,
          normalizedEmail: newEmail,
          isPrimary: true,
          now,
        });
        this.db.prepare(
          `UPDATE contact_emails
           SET is_primary = 1
           WHERE contact_id = ? AND normalized_email = ?`,
        ).run(contactId, newEmail);
      }
    }
    return decodeContact(row);
  }

  deleteContact(contactId: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM contact_activities WHERE contact_id = ?",
      ).run(contactId);
      this.db.prepare(
        "DELETE FROM contact_emails WHERE contact_id = ?",
      ).run(contactId);
      return this.db.prepare(
        "DELETE FROM contacts WHERE id = ?",
      ).run(contactId).changes === 1;
    }).immediate();
  }

  // A human-only repair action reached through the CRM API. The email lane
  // and the classifier never call this: automated resolution stays ambiguous
  // instead of merging.
  mergeContacts(input: { winnerId: string; loserId: string }): Contact {
    const winnerId = input.winnerId.trim();
    const loserId = input.loserId.trim();
    if (!winnerId || !loserId) {
      throw new Error("Merge requires a winner and a loser contact id.");
    }
    if (winnerId === loserId) {
      throw new Error("A contact cannot be merged into itself.");
    }
    return this.db.transaction(() => {
      const winner = this.db.prepare(
        "SELECT * FROM contacts WHERE id = ?",
      ).get(winnerId) as ContactRow | undefined;
      if (!winner) throw new Error("Merge winner contact was not found.");
      const loser = this.db.prepare(
        "SELECT * FROM contacts WHERE id = ?",
      ).get(loserId) as ContactRow | undefined;
      if (!loser) throw new Error("Merge loser contact was not found.");
      const now = this.now().toISOString();

      // Legacy rows may predate contact_emails; represent both primaries.
      for (const [row, isPrimary] of [
        [winner, true],
        [loser, false],
      ] as const) {
        const normalizedEmail = normalizeContactEmail(row.email ?? undefined);
        if (normalizedEmail) {
          this.insertContactEmail({
            contactId: row.id,
            email: row.email!.trim(),
            normalizedEmail,
            isPrimary,
            now,
          });
        }
      }

      // The winner keeps its primary address; the loser's addresses become
      // secondary addresses of the winner.
      this.db.prepare(
        `UPDATE contact_emails
         SET contact_id = ?, is_primary = 0
         WHERE contact_id = ?`,
      ).run(winnerId, loserId);
      this.db.prepare(
        "UPDATE contact_activities SET contact_id = ? WHERE contact_id = ?",
      ).run(winnerId, loserId);
      this.db.prepare(
        "UPDATE commitments SET contact_id = ? WHERE contact_id = ?",
      ).run(winnerId, loserId);
      this.db.prepare(
        "UPDATE email_items SET contact_id = ? WHERE contact_id = ?",
      ).run(winnerId, loserId);
      this.db.prepare(
        "UPDATE meeting_notes SET contact_id = ? WHERE contact_id = ?",
      ).run(winnerId, loserId);

      // Fill empty winner fields from the loser; never overwrite winner data.
      const empty = (value: unknown) =>
        value === null || value === undefined || String(value).trim() === "";
      const fills: string[] = [];
      const fillValues: unknown[] = [];
      for (const field of [
        "company_id",
        "company",
        "phone",
        "role",
        "linkedin",
        "location",
        "how_we_met",
        "notes",
      ]) {
        if (empty(winner[field]) && !empty(loser[field])) {
          fills.push(`"${field}" = ?`);
          fillValues.push(loser[field]);
        }
      }
      if (empty(winner.email) && !empty(loser.email)) {
        const promoted = normalizeContactEmail(loser.email ?? undefined);
        fills.push("email = ?", "normalized_email = ?");
        fillValues.push(promoted, promoted);
        this.db.prepare(
          `UPDATE contact_emails
           SET is_primary = 1
           WHERE contact_id = ? AND normalized_email = ?`,
        ).run(winnerId, promoted);
      }
      const recency = (field: string) => {
        const winnerValue = String(winner[field] ?? "");
        const loserValue = String(loser[field] ?? "");
        return loserValue > winnerValue ? loserValue : winnerValue;
      };
      fills.push("last_interaction_at = ?", "last_contact_date = ?", "updated_at = ?");
      fillValues.push(
        recency("last_interaction_at") || null,
        recency("last_contact_date") || null,
        now,
      );
      this.db.prepare(
        `UPDATE contacts SET ${fills.join(", ")} WHERE id = ?`,
      ).run(...fillValues, winnerId);

      // Only the loser row itself is removed; its history was moved above,
      // so this must never cascade into activity deletion.
      this.db.prepare("DELETE FROM contacts WHERE id = ?").run(loserId);

      const merged = this.db.prepare(
        "SELECT * FROM contacts WHERE id = ?",
      ).get(winnerId) as ContactRow;
      return decodeContact(merged);
    }).immediate();
  }
}
