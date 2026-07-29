export const COVE_REST_TABLES = [
  "tasks",
  "task_columns",
  "companies",
  "email_items",
  "drafts",
  "email_action_log",
  "email_triage_runs",
  "commitments",
  "inbound_events",
] as const;

export type CoveRestTable = typeof COVE_REST_TABLES[number];

export const COVE_CRM_COMPAT_TABLES = [
  "contacts",
  "contact_activities",
] as const;
