export type {
  CalendarEvent,
  MailHeader,
  MailListPage,
  MailMessage,
  MailThread,
  ReadonlyCalendarGateway,
  ReadonlyDocumentsGateway,
  RestrictedMailGateway,
  WorkspaceGateway,
} from "./contracts";
export {
  GOOGLE_SCOPES,
  GOOGLE_SCOPE_SET_VERSION,
  readWorkspaceConfig,
  scopesForConfig,
  workspaceConfigPath,
  type WorkspaceConfig,
} from "./config";
export {
  safeWorkspaceFailure,
  WorkspaceGatewayError,
  type WorkspaceErrorCode,
} from "./errors";
export { createGoogleWorkspaceGateway } from "./google/gateway";
