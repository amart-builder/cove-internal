import type { Contact, ContactActivity } from "../data/types";

export type CRMBackendKind = "local" | "external";
export type ContactProvenance = "meeting-notes" | "email" | "manual";

export type ContactCandidate = {
  id: string;
  name: string;
  email: string | null;
  companyId: string | null;
};

export type ResolveContactInput = {
  name: string;
  email?: string;
  companyId?: string;
  phone?: string;
  role?: string;
  linkedin?: string;
  location?: string;
  howWeMet?: string;
  tier?: string;
  tags?: string[];
  notes?: string;
  source: ContactProvenance;
};

export type ContactResolution =
  | {
      status: "matched" | "created";
      contact: Contact;
      candidates?: never;
    }
  | {
      status: "ambiguous";
      contact?: never;
      candidates: ContactCandidate[];
    };

export type ExplicitCreateContactInput = Omit<ResolveContactInput, "source"> & {
  source: "manual";
};

export type ExplicitContactCreation = {
  contact: Contact;
  candidates: ContactCandidate[];
};

export type AppendContactActivityInput = {
  contactId: string;
  companyId?: string;
  sourceRef?: string;
  activityType: string;
  title: string;
  content?: string;
  direction?: "inbound" | "outbound" | "internal";
  source: ContactProvenance;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
};

export type ContactWithActivities = {
  contact: Contact;
  activities: ContactActivity[];
};

export type MeetingContactActivityInput = {
  contact: Omit<ResolveContactInput, "source">;
  sourceRef?: string;
  title: string;
  content?: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
};

export type MeetingContactActivityResult =
  | {
      status: "matched" | "created";
      contact: Contact;
      contactId: string;
      activity: ContactActivity;
      candidates?: never;
    }
  | {
      status: "ambiguous";
      contact?: never;
      contactId: null;
      activity?: never;
      candidates: ContactCandidate[];
    };

export interface CRMBackend {
  readonly kind: CRMBackendKind;
  close(): void;
  resolveOrCreateContact(input: ResolveContactInput): ContactResolution;
  createContact(input: ExplicitCreateContactInput): ExplicitContactCreation;
  findByNormalizedEmail(email: string): Contact[];
  appendActivity(input: AppendContactActivityInput): ContactActivity;
  getContactWithRecentActivities(
    contactId: string,
    limit?: number,
  ): ContactWithActivities | null;
  listContacts(options?: { search?: string; limit?: number }): Contact[];
  updateContact(contactId: string, patch: Partial<Contact>): Contact | null;
  deleteContact(contactId: string): boolean;
  resolveAndAppendMeetingActivity(
    input: MeetingContactActivityInput,
  ): MeetingContactActivityResult;
}
