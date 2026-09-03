import { existsSync, readFileSync } from "node:fs";

export type MeetingToolPattern = {
  tool: string;
  senderRegex?: string;
  subjectRegex?: string;
  gmailQuery?: string;
};

export type MeetingDetectionConfig = {
  enabled: boolean;
  activeTools: string[];
  patterns: MeetingToolPattern[];
  query: string;
  window: string;
  processedLabel: string;
  granola: {
    enabled: boolean;
    ownerEmails: string[];
  };
};

export type MeetingDetection = {
  matched: boolean;
  tool?: string;
};

export const KNOWN_MEETING_TOOL_PATTERNS: readonly MeetingToolPattern[] = [
  {
    tool: "gemini",
    senderRegex: String.raw`(?:^|<)gemini-noreply@google\.com>?$`,
    subjectRegex: String.raw`\bnotes\b`,
    gmailQuery:
      'from:(gemini-noreply@google.com) OR subject:("Notes:" OR "Meeting notes")',
  },
  {
    tool: "granola",
    senderRegex: String.raw`@(?:mail\.)?granola\.ai>?$`,
    subjectRegex: String.raw`(?:granola).*(?:notes|summary)|(?:notes|summary).*(?:granola)`,
    gmailQuery:
      'from:(granola.ai) OR subject:(Granola AND (notes OR summary))',
  },
  {
    tool: "fathom",
    senderRegex: String.raw`@fathom\.video>?$`,
    subjectRegex: String.raw`(?:fathom).*(?:summary|recording|notes)|(?:summary|notes).*(?:fathom)`,
    gmailQuery:
      'from:(fathom.video) OR subject:(Fathom AND (summary OR notes))',
  },
  {
    tool: "otter",
    senderRegex: String.raw`@(?:email\.)?otter\.ai>?$`,
    subjectRegex: String.raw`(?:otter).*(?:meeting summary|notes|transcript)|(?:meeting summary).*(?:otter)`,
    gmailQuery:
      'from:(otter.ai) OR subject:(Otter AND ("Meeting Summary" OR notes))',
  },
] as const;

export const NOTIFICATION_ONLY_MEETING_PATTERNS: readonly MeetingToolPattern[] = [
  {
    tool: "granola",
    senderRegex: String.raw`(?:^|<)notifications@mail\.granola\.ai>?$`,
  },
  {
    tool: "gemini",
    subjectRegex: String.raw`(?:couldn['’]?t|could not|unable to) take notes|no notes were generated`,
  },
] as const;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function patternFromConfig(value: unknown): MeetingToolPattern | undefined {
  const row = objectValue(value);
  const tool = nonEmptyString(row?.tool) ?? nonEmptyString(row?.name);
  const senderRegex = nonEmptyString(row?.sender_regex);
  const subjectRegex = nonEmptyString(row?.subject_regex);
  if (!tool || (!senderRegex && !subjectRegex)) return undefined;
  return {
    tool: tool.toLowerCase(),
    senderRegex,
    subjectRegex,
    gmailQuery: nonEmptyString(row?.gmail_query),
  };
}

function compilePattern(source: string | undefined): RegExp | undefined {
  if (!source) return undefined;
  if (source.length > 1_000) {
    throw new Error("Meeting detection regex exceeds 1000 characters.");
  }
  return new RegExp(source, "i");
}

function assertPatterns(patterns: MeetingToolPattern[]): void {
  for (const pattern of patterns) {
    if (!pattern.tool.trim()) throw new Error("Meeting tool name is required.");
    compilePattern(pattern.senderRegex);
    compilePattern(pattern.subjectRegex);
  }
}

export function loadMeetingDetectionConfig(
  file: string,
): MeetingDetectionConfig {
  if (!existsSync(file)) {
    throw new Error(`Meeting config does not exist: ${file}`);
  }
  const parsed = objectValue(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed || typeof parsed.enabled !== "boolean") {
    throw new Error("cove-meetings.json is missing enabled.");
  }
  const configuredTools = Array.isArray(parsed.active_tools)
    ? parsed.active_tools
    : Array.isArray(parsed.tools)
      ? parsed.tools
      : ["gemini"];
  const activeTools = configuredTools
    .filter((tool): tool is string => typeof tool === "string" && Boolean(tool.trim()))
    .map((tool) => tool.trim().toLowerCase());
  if (parsed.enabled && activeTools.length === 0) {
    throw new Error("cove-meetings.json must enable at least one meeting tool.");
  }
  const customPatterns = Array.isArray(parsed.custom_patterns)
    ? parsed.custom_patterns.flatMap((value) => {
        const pattern = patternFromConfig(value);
        return pattern ? [pattern] : [];
      })
    : [];
  const knownByTool = new Map(
    KNOWN_MEETING_TOOL_PATTERNS.map((pattern) => [pattern.tool, pattern]),
  );
  const customByTool = new Map(
    customPatterns.map((pattern) => [pattern.tool, pattern]),
  );
  const patterns = activeTools.map((tool) => {
    const pattern = customByTool.get(tool) ?? knownByTool.get(tool);
    if (!pattern) {
      throw new Error(
        `Meeting tool "${tool}" needs a custom sender_regex or subject_regex.`,
      );
    }
    return pattern;
  });
  assertPatterns(patterns);

  const configuredQuery = nonEmptyString(parsed.query);
  const generatedQuery = patterns
    .flatMap((pattern) => pattern.gmailQuery ? [pattern.gmailQuery] : [])
    .map((query) => `(${query})`)
    .join(" OR ");
  const query = configuredQuery ?? generatedQuery;
  if (parsed.enabled && !query) {
    throw new Error(
      "cove-meetings.json needs query or gmail_query for custom-only tools.",
    );
  }
  const window = nonEmptyString(parsed.window);
  const processedLabel = nonEmptyString(parsed.processed_label);
  if (!window || !processedLabel) {
    throw new Error(
      "cove-meetings.json is missing window or processed_label.",
    );
  }
  const granolaConfig = objectValue(parsed.granola);
  const granolaOwnerEmails = Array.isArray(granolaConfig?.owner_emails)
    ? granolaConfig.owner_emails.flatMap((value) => {
        const email = nonEmptyString(value)?.toLowerCase();
        return email ? [email] : [];
      })
    : [];
  return {
    enabled: parsed.enabled,
    activeTools,
    patterns,
    query: query ?? "",
    window,
    processedLabel,
    granola: {
      enabled: granolaConfig?.enabled === true,
      ownerEmails: granolaOwnerEmails,
    },
  };
}

export function isNotificationOnlyMeetingMessage(input: {
  sender?: string;
  subject?: string;
}): boolean {
  const sender = input.sender?.trim() ?? "";
  const subject = input.subject?.trim() ?? "";
  return NOTIFICATION_ONLY_MEETING_PATTERNS.some((pattern) =>
    Boolean(
      compilePattern(pattern.senderRegex)?.test(sender) ||
      compilePattern(pattern.subjectRegex)?.test(subject),
    )
  );
}

export function detectMeetingNotes(
  input: { sender?: string; subject?: string },
  config: Pick<MeetingDetectionConfig, "patterns">,
): MeetingDetection {
  const sender = input.sender?.trim() ?? "";
  const subject = input.subject?.trim() ?? "";
  const subjectPatterns = [...config.patterns].sort((left, right) =>
    Number(left.tool === "gemini") - Number(right.tool === "gemini")
  );
  for (const pattern of config.patterns) {
    const senderPattern = compilePattern(pattern.senderRegex);
    if (senderPattern?.test(sender) ?? false) {
      return { matched: true, tool: pattern.tool };
    }
  }
  for (const pattern of subjectPatterns) {
    const subjectPattern = compilePattern(pattern.subjectRegex);
    if (subjectPattern?.test(subject) ?? false) {
      return { matched: true, tool: pattern.tool };
    }
  }
  return { matched: false };
}
