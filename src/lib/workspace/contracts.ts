export type MailHeader = { name: string; value: string };

export type MailMessage = {
  id: string;
  threadId: string;
  historyId: string | null;
  labelIds: string[];
  internalDate: string | null;
  headers: MailHeader[];
  snippet: string;
  text: string;
};

export type MailThread = {
  id: string;
  historyId: string | null;
  messages: MailMessage[];
};

export type MailListPage = {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
};

export type CalendarEvent = {
  id: string;
  status: string;
  summary: string;
  description: string;
  location: string;
  htmlLink: string;
  meetingUrl: string;
  start: string;
  end: string;
  attendees: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
  }>;
};

export interface RestrictedMailGateway {
  readonly accountEmail: string;
  getProfile(): Promise<{ emailAddress: string }>;
  listMessages(input: {
    query: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<MailListPage>;
  getMessage(input: {
    messageId: string;
    format?: "metadata" | "full";
  }): Promise<MailMessage>;
  getThread(input: {
    threadId: string;
    format?: "metadata" | "full";
  }): Promise<MailThread>;
  getAttachment(input: {
    messageId: string;
    attachmentId: string;
    maxBytes?: number;
  }): Promise<Uint8Array>;
  listDrafts(input?: {
    pageToken?: string;
    maxResults?: number;
  }): Promise<{
    drafts: Array<{ id: string; messageId: string; threadId: string }>;
    nextPageToken?: string;
  }>;
  ensureCoveLabel(input: { name: string }): Promise<{ id: string; name: string }>;
  modifyThreadLabels(input: {
    threadId: string;
    addNames?: string[];
    removeNames?: string[];
  }): Promise<void>;
  archiveMessages(input: { messageIds: string[] }): Promise<void>;
  createReplyDraft(input: {
    threadId: string;
    sourceMessageId: string;
    body: string;
    htmlBody?: string;
    idempotencyKey: string;
    existingDraftId?: string;
  }): Promise<{ id: string; messageId: string; threadId: string }>;
  createSupportDraft(input: {
    recipient: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ id: string; messageId: string }>;
}

export interface ReadonlyCalendarGateway {
  listEvents(input: {
    timeMin: string;
    timeMax: string;
    timeZone: string;
    maxResults?: number;
  }): Promise<CalendarEvent[]>;
}

export interface ReadonlyDocumentsGateway {
  getDocumentPlainText(input: {
    documentId: string;
    maxChars?: number;
  }): Promise<string>;
}

export type WorkspaceGateway = {
  mail: RestrictedMailGateway;
  calendar?: ReadonlyCalendarGateway;
  documents?: ReadonlyDocumentsGateway;
};
