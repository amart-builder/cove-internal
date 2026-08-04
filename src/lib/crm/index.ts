import { readFileSync } from "node:fs";
import { coveConfigPath } from "../env";
import { localDatabasePath } from "../local/database";
import { coveDataDir } from "../operator";
import { LocalCRMBackend } from "./local";
import type {
  AppendContactActivityInput,
  ContactResolution,
  ContactWithActivities,
  CRMBackend,
  CRMBackendKind,
  ExplicitContactCreation,
  ExplicitCreateContactInput,
  MeetingContactActivityInput,
  MeetingContactActivityResult,
  ResolveContactInput,
} from "./types";
import type { Contact, ContactActivity } from "../data/types";

export const EXTERNAL_CRM_MESSAGE =
  "External CRM adapters are wired per client at setup";

class ExternalCRMBackend implements CRMBackend {
  readonly kind = "external" as const;

  close(): void {}

  private unavailable(): never {
    throw new Error(EXTERNAL_CRM_MESSAGE);
  }

  resolveOrCreateContact(_input: ResolveContactInput): ContactResolution {
    void _input;
    return this.unavailable();
  }

  createContact(_input: ExplicitCreateContactInput): ExplicitContactCreation {
    void _input;
    return this.unavailable();
  }

  findByNormalizedEmail(_email: string): Contact[] {
    void _email;
    return this.unavailable();
  }

  appendActivity(_input: AppendContactActivityInput): ContactActivity {
    void _input;
    return this.unavailable();
  }

  getContactWithRecentActivities(
    _contactId: string,
    _limit?: number,
  ): ContactWithActivities | null {
    void _contactId;
    void _limit;
    return this.unavailable();
  }

  listContacts(_options?: { search?: string; limit?: number }): Contact[] {
    void _options;
    return this.unavailable();
  }

  updateContact(
    _contactId: string,
    _patch: Partial<Contact>,
  ): Contact | null {
    void _contactId;
    void _patch;
    return this.unavailable();
  }

  deleteContact(_contactId: string): boolean {
    void _contactId;
    return this.unavailable();
  }

  mergeContacts(_input: { winnerId: string; loserId: string }): Contact {
    void _input;
    return this.unavailable();
  }

  resolveAndAppendMeetingActivity(
    _input: MeetingContactActivityInput,
  ): MeetingContactActivityResult {
    void _input;
    return this.unavailable();
  }
}

export function configuredCRMBackend(dataDir = coveDataDir()): CRMBackendKind {
  const configPath = coveConfigPath(dataDir, "crm.json");
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("CRM config must be a JSON object.");
    }
    const backend = (parsed as Record<string, unknown>).backend;
    if (backend === "local" || backend === "external") return backend;
    throw new Error('CRM backend must be "local" or "external".');
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "local";
    }
    throw error;
  }
}

export function createCRMBackend(options: {
  dataDir?: string;
  dbPath?: string;
  now?: () => Date;
} = {}): CRMBackend {
  const kind = configuredCRMBackend(options.dataDir ?? coveDataDir());
  if (kind === "external") return new ExternalCRMBackend();
  return new LocalCRMBackend({
    dbPath: options.dbPath ?? localDatabasePath(),
    now: options.now,
  });
}

export function resolveAndAppendMeetingActivity(
  input: MeetingContactActivityInput,
  backend?: CRMBackend,
): MeetingContactActivityResult {
  const crm = backend ?? createCRMBackend();
  try {
    return crm.resolveAndAppendMeetingActivity(input);
  } finally {
    if (!backend) crm.close();
  }
}

export { LocalCRMBackend };
export type {
  AppendContactActivityInput,
  ContactCandidate,
  ContactProvenance,
  ContactResolution,
  ContactWithActivities,
  CRMBackend,
  CRMBackendKind,
  ExplicitContactCreation,
  ExplicitCreateContactInput,
  MeetingContactActivityInput,
  MeetingContactActivityResult,
  ResolveContactInput,
} from "./types";
