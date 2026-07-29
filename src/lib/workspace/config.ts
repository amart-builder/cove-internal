import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { coveEnv } from "../env";
import { WorkspaceGatewayError } from "./errors";

export const GOOGLE_SCOPE_SET_VERSION = 1;

export const GOOGLE_SCOPES = Object.freeze({
  mail: "https://www.googleapis.com/auth/gmail.modify",
  calendar: "https://www.googleapis.com/auth/calendar.events.readonly",
  documents: "https://www.googleapis.com/auth/documents.readonly",
});

export type WorkspaceConfig = {
  version: 1;
  provider: "google-api";
  profileId: string;
  accountEmail: string;
  oauthClientId: string;
  capabilities: {
    mail: true;
    calendar: boolean;
    documents: boolean;
  };
  calendarId: "primary";
  supportDraftRecipients: string[];
};

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceGatewayError({
      code: "not_configured",
      operation: "read_config",
      safeMessage: `Google Workspace config is missing ${key}.`,
    });
  }
  return value.trim();
}

export function workspaceConfigPath(dataDir?: string): string {
  return path.join(
    dataDir ?? coveEnv("DATA_DIR") ?? path.join(process.cwd(), "data"),
    "cove-workspace.json",
  );
}

export function readWorkspaceConfig(dataDir?: string): WorkspaceConfig {
  const file = workspaceConfigPath(dataDir);
  if (!existsSync(file)) {
    throw new WorkspaceGatewayError({
      code: "not_configured",
      operation: "read_config",
      safeMessage: "Google Workspace is not connected.",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new WorkspaceGatewayError({
      code: "not_configured",
      operation: "read_config",
      safeMessage: "Google Workspace config is not valid JSON.",
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceGatewayError({
      code: "not_configured",
      operation: "read_config",
      safeMessage: "Google Workspace config must be an object.",
    });
  }
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1 || row.provider !== "google-api") {
    throw new WorkspaceGatewayError({
      code: "not_configured",
      operation: "read_config",
      safeMessage: "Google Workspace config uses an unsupported version or provider.",
    });
  }
  if ("scopes" in row) {
    throw new WorkspaceGatewayError({
      code: "unsafe_operation",
      operation: "read_config",
      safeMessage: "OAuth scopes cannot be widened through config.",
    });
  }
  const capabilities = row.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new WorkspaceGatewayError({
      code: "not_configured",
      operation: "read_config",
      safeMessage: "Google Workspace capabilities are missing.",
    });
  }
  const capabilityRow = capabilities as Record<string, unknown>;
  if (capabilityRow.mail !== true) {
    throw new WorkspaceGatewayError({
      code: "not_configured",
      operation: "read_config",
      safeMessage: "Google Workspace mail access must be enabled.",
    });
  }
  const gmail = row.gmail && typeof row.gmail === "object" && !Array.isArray(row.gmail)
    ? row.gmail as Record<string, unknown>
    : {};
  const recipients = gmail.support_draft_recipients;
  const supportDraftRecipients = Array.isArray(recipients)
    ? recipients.filter((value): value is string =>
      typeof value === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
    ).map((value) => value.toLowerCase())
    : [];
  if (Array.isArray(recipients) && supportDraftRecipients.length !== recipients.length) {
    throw new WorkspaceGatewayError({
      code: "invalid_input",
      operation: "read_config",
      safeMessage: "A support draft recipient is invalid.",
    });
  }
  return {
    version: 1,
    provider: "google-api",
    profileId: requiredText(row, "profile_id"),
    accountEmail: requiredText(row, "account_email").toLowerCase(),
    oauthClientId: requiredText(row, "oauth_client_id"),
    capabilities: {
      mail: true,
      calendar: capabilityRow.calendar === true,
      documents: capabilityRow.documents === true,
    },
    calendarId: "primary",
    supportDraftRecipients,
  };
}

export function scopesForConfig(config: WorkspaceConfig): string[] {
  return [
    GOOGLE_SCOPES.mail,
    ...(config.capabilities.calendar ? [GOOGLE_SCOPES.calendar] : []),
    ...(config.capabilities.documents ? [GOOGLE_SCOPES.documents] : []),
  ];
}
