export const FORGE_REST_TABLES = [
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
] as const;

export type ForgeRestTable = typeof FORGE_REST_TABLES[number];
