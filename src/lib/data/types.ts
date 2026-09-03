export type CoveId = string;

export type TaskColumn = {
  id: CoveId;
  name: string;
  position: number;
  is_default: boolean;
};

export type Task = {
  id: CoveId;
  column_id: CoveId | null;
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  due_at: string | null;
  brief?: string | null;
  remind_at?: string | null;
  nudged_at?: string | null;
  engaged_at?: string | null;
  notification_policy?: "none" | "predeadline" | "due" | "both" | null;
  tags: string[];
  project?: string;
  position: number;
  status: "open" | "done" | "archived";
  source_type?: string;
  archived_at?: string | null;
  archived_from_status?: "open" | "done" | null;
  proposed_recurrence_cadence?: string | null;
  recurring_template_id?: string | null;
  occurrence_local_date?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Company = {
  id: CoveId;
  name: string;
  domain: string | null;
  website: string | null;
  industry?: string | null;
  location?: string | null;
  linkedin?: string | null;
  description?: string | null;
  tags: string[];
  notes: string;
  last_interaction_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Contact = {
  id: CoveId;
  company_id: CoveId | null;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  linkedin?: string | null;
  location?: string | null;
  how_we_met?: string | null;
  tier: string;
  tags: string[];
  notes: string;
  last_interaction_at?: string | null;
  provenance_source?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type ContactActivity = {
  id: CoveId;
  contact_id: CoveId | null;
  company_id: CoveId | null;
  source_ref?: string | null;
  activity_type: string;
  title: string | null;
  content: string | null;
  direction: "inbound" | "outbound" | "internal" | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
};

export type EmailItem = {
  id: CoveId;
  contact_id: CoveId | null;
  company_id: CoveId | null;
  message_id: string | null;
  thread_id: string | null;
  classification: "action_item" | "tiding" | "log_only";
  status:
    | "pending"
    | "archiving"
    | "reviewed"
    | "actioned"
    | "dismissed"
    | "archived";
  workflow_state?:
    | "legacy"
    | "observed"
    | "classifying"
    | "open"
    | "finalizing"
    | "terminal"
    | "failed";
  bucket?: "reply" | "action" | "fyi" | "noise" | null;
  thread_version?: number;
  latest_inbound_message_id?: string | null;
  gmail_draft_id?: string | null;
  sender_name: string | null;
  sender_email: string | null;
  subject: string | null;
  body_excerpt: string | null;
  summary: string | null;
  context: string | null;
  source_payload?: unknown;
  recommended_action: string | null;
  priority: number;
  received_at?: string | null;
  account_email?: string | null;
  actioned_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Draft = {
  id: CoveId;
  email_item_id: CoveId | null;
  subject?: string | null;
  body: string;
  status: "needs_review" | "edited" | "approved" | "sent" | "dismissed";
  voice_version: string | null;
  humanizer_version: string | null;
  created_at?: string;
  updated_at?: string;
};

export type EmailActionLog = {
  id: CoveId;
  email_item_id: CoveId | null;
  action_type: string;
  description: string;
  created_at: string;
};

export type EmailTriageRun = {
  id: CoveId;
  summary: string | null;
  created_at: string;
};

export type CommitmentKind =
  | "follow_up"
  | "promise"
  | "waiting_on"
  | "open_decision"
  | "overnight_request"
  | "idea";

export type CommitmentSourceKind =
  | "brain_dump"
  | "manual"
  | "chat"
  | "detector"
  | "brief";

export type Commitment = {
  id: CoveId;
  kind: CommitmentKind;
  title: string;
  details: string | null;
  counterparty: string | null;
  contact_id: CoveId | null;
  source_kind: CommitmentSourceKind;
  source_quote: string | null;
  source_ref: string | null;
  due_at: string | null;
  review_at: string | null;
  confidence: "high" | "medium" | "low";
  confirmed: boolean;
  status: "open" | "done" | "dropped" | "expired";
  evidence: string | null;
  created_at: string;
  updated_at: string;
};

export type InboundEventState =
  | "pending"
  | "triaged"
  | "failed"
  | "dismissed";

export type InboundEvent = {
  id: CoveId;
  source: string;
  source_id: string;
  raw_text: string;
  machine: string | null;
  state: InboundEventState;
  task_id: CoveId | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  spooled?: boolean;
};
