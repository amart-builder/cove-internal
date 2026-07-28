export const COVE_REST_TABLES = [
  "tasks",
  "task_columns",
  "contacts",
  "companies",
  "contact_activities",
  "email_items",
  "drafts",
  "email_action_log",
  "email_triage_runs",
  "commitments",
  "inbound_events",
] as const;

export type ForgeRestTable = typeof COVE_REST_TABLES[number];
