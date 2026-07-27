export type ForgeId = string;

export type TaskColumn = {
  id: ForgeId;
  name: string;
  position: number;
  is_default: boolean;
};

export type Task = {
  id: ForgeId;
  column_id: ForgeId | null;
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  due_at: string | null;
  tags: string[];
  position: number;
  status: "open" | "done" | "archived";
  source_type?: string;
  created_at?: string;
  updated_at?: string;
};

export type Company = {
  id: ForgeId;
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
  id: ForgeId;
  company_id: ForgeId | null;
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
  created_at?: string;
  updated_at?: string;
};

export type ContactActivity = {
  id: ForgeId;
  contact_id: ForgeId | null;
  company_id: ForgeId | null;
  activity_type: string;
  title: string | null;
  content: string | null;
  direction: "inbound" | "outbound" | "internal" | null;
  created_at: string;
};

export type EmailItem = {
  id: ForgeId;
  contact_id: ForgeId | null;
  company_id: ForgeId | null;
  message_id: string | null;
  thread_id: string | null;
  classification: "action_item" | "tiding" | "log_only";
  status: "pending" | "reviewed" | "actioned" | "dismissed" | "archived";
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
  created_at?: string;
  updated_at?: string;
};

export type Draft = {
  id: ForgeId;
  email_item_id: ForgeId | null;
  subject?: string | null;
  body: string;
  status: "needs_review" | "edited" | "approved" | "sent" | "dismissed";
  voice_version: string | null;
  humanizer_version: string | null;
  created_at?: string;
  updated_at?: string;
};

export type EmailActionLog = {
  id: ForgeId;
  email_item_id: ForgeId | null;
  action_type: string;
  description: string;
  created_at: string;
};

export type EmailTriageRun = {
  id: ForgeId;
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
  id: ForgeId;
  kind: CommitmentKind;
  title: string;
  details: string | null;
  counterparty: string | null;
  contact_id: ForgeId | null;
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
