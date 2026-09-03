import type { ScheduledJob } from "../reliability/jobs";
import type { MailMessage, RestrictedMailGateway } from "../workspace";
import { localDatabasePath, openLocalDatabase } from "../local/database";
import { classifyEmail, type EmailClassification } from "./classifier";
import { parseFromHeader } from "./from-header";
import { applyEmailClassification } from "./state-machine";
import {
  captureEmailCommitments,
  formatEmailCRMContext,
  getEmailCRMContext,
  recordCRMResolutionFailure,
  recordEmailCorrespondence,
  type EmailCommitmentInput,
} from "./automation";
import { handleUrgentEmail } from "../attention/email-urgency";
import { recordFailure } from "../reliability/failures";
import type { runJob } from "../model-runner";
import { readCoveEmailSettings } from "./settings";
import { readVoiceFingerprint } from "./voice-guide";
import { judgeDraftVoice } from "./voice-judge";
import { coveDataDir } from "../operator";
import { formatOperatorPolicy, readOperatorPolicy } from "../operator-policy";
import { detectCalendarNotice, summarizeCalendarNotice } from "./calendar-notice";

function header(message: MailMessage, name: string): string {
  return message.headers.find((item) => item.name.toLowerCase() === name.toLowerCase())
    ?.value ?? "";
}

function normalizedEvidence(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function payload(job: ScheduledJob): {
  messageId: string;
  emailItemId: string;
  threadVersion: number;
} {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new Error("Email classification job payload is invalid.");
  }
  const row = job.payload as Record<string, unknown>;
  if (
    typeof row.messageId !== "string" ||
    typeof row.emailItemId !== "string" ||
    typeof row.threadVersion !== "number"
  ) {
    throw new Error("Email classification job payload is incomplete.");
  }
  return {
    messageId: row.messageId,
    emailItemId: row.emailItemId,
    threadVersion: row.threadVersion,
  };
}

export function createEmailClassificationHandler(input: {
  gateway: RestrictedMailGateway;
  accountEmail: string;
  dbPath?: string;
  dataDir?: string;
  repoDir?: string;
  signatureText?: string | null;
  voice?: () => string;
  classifier?: (input: {
    accountEmail: string;
    sender: string;
    subject: string;
    text: string;
    voice?: string;
    recentContext?: string;
    policy?: string;
  }) => Promise<EmailClassification>;
  now?: () => Date;
  urgentHandler?: typeof handleUrgentEmail;
  runJobImpl?: typeof runJob;
}) {
  const classifier = input.classifier ??
    ((classificationInput) => classifyEmail({
      ...classificationInput,
      repoDir: input.repoDir,
    }));
  return async (job: ScheduledJob): Promise<{
    summary: string;
    actions: unknown;
  }> => {
    const claim = payload(job);
    const db = openLocalDatabase(input.dbPath);
    try {
      const state = db.prepare(
        "SELECT state FROM cove_email_messages WHERE message_id = ?",
      ).get(claim.messageId) as { state: string } | undefined;
      if (!state) throw new Error("Email message claim was not found.");
      if (state.state === "processed") {
        const message = await input.gateway.getMessage({
          messageId: claim.messageId,
          format: "metadata",
        });
        await input.gateway.modifyThreadLabels({
          threadId: message.threadId,
          addNames: ["Cove/Triaged"],
        });
        return {
          summary: "Email classification was already complete and its ingestion marker was repaired.",
          actions: {
            messageId: claim.messageId,
            emailItemId: claim.emailItemId,
            applied: false,
            state: state.state,
            markerRepaired: true,
          },
        };
      }
      if (state.state === "superseded") {
        const item = db.prepare(
          "SELECT workflow_state, status FROM email_items WHERE id = ?",
        ).get(claim.emailItemId) as {
          workflow_state: string;
          status: string;
        } | undefined;
        const cause = !item
          ? "missing_item"
          : item.status !== "pending" || item.workflow_state !== "observed"
            ? "item_not_open"
            : "version_mismatch";
        if (cause === "version_mismatch") {
          return {
            summary: "A newer message superseded this email classification.",
            actions: {
              messageId: claim.messageId,
              emailItemId: claim.emailItemId,
              applied: false,
              state: state.state,
              cause,
              markerRepaired: false,
            },
          };
        }
        const message = await input.gateway.getMessage({
          messageId: claim.messageId,
          format: "metadata",
        });
        await input.gateway.modifyThreadLabels({
          threadId: message.threadId,
          addNames: ["Cove/Triaged"],
        });
        return {
          summary: "Email classification was permanently superseded and its ingestion marker was repaired.",
          actions: {
            messageId: claim.messageId,
            emailItemId: claim.emailItemId,
            applied: false,
            state: state.state,
            cause,
            markerRepaired: true,
          },
        };
      }
      db.prepare(
        `UPDATE cove_email_messages
         SET state = 'classifying', attempts = attempts + 1, updated_at = ?
         WHERE message_id = ? AND state IN ('observed','classifying','failed')`,
      ).run((input.now ?? (() => new Date()))().toISOString(), claim.messageId);
    } finally {
      db.close();
    }
    const message = await input.gateway.getMessage({
      messageId: claim.messageId,
      format: "full",
    });
    const from = parseFromHeader(header(message, "From"));
    const calendarNotice = detectCalendarNotice({
      sender: header(message, "From"),
      subject: header(message, "Subject"),
    });
    const calendarSummary = calendarNotice
      ? summarizeCalendarNotice(calendarNotice)
      : undefined;
    const deterministicCalendarNotice = calendarNotice?.kind === "accepted" ||
      calendarNotice?.kind === "tentative";
    // Bucketing remains useful without CRM, but drafting fails closed when
    // identity is ambiguous or Cove records cannot load.
    let recentContext: string | undefined;
    let draftBlockReason: string | undefined;
    if (!deterministicCalendarNotice) {
      try {
        const crmContext = getEmailCRMContext({
          senderName: from.displayName,
          senderEmail: from.address,
          threadId: message.threadId,
          dbPath: input.dbPath,
          dataDir: input.dataDir,
          now: input.now,
        });
        recentContext = formatEmailCRMContext(crmContext);
        if (crmContext.status === "ambiguous") {
          draftBlockReason = `contact record is ambiguous (${crmContext.candidates?.length ?? 0} candidates)`;
        }
      } catch (error) {
        recentContext = undefined;
        draftBlockReason = "Cove records were unavailable";
        recordCRMResolutionFailure({
          dbPath: input.dbPath,
          sourceId: `gmail:${message.threadId}`,
          message: "Email reply draft was withheld because Cove records were unavailable.",
          details: {
            threadId: message.threadId,
            senderEmail: from.address,
            error: error instanceof Error ? error.message : String(error),
          },
          occurredAt: (input.now ?? (() => new Date()))().toISOString(),
        });
      }
    }
    const classified: EmailClassification = deterministicCalendarNotice
      ? {
          bucket: "fyi",
          summary: calendarSummary!,
          recommendedAction: null,
          draftBody: null,
          commitments: [],
          recordCorrespondence: false,
          urgent: false,
          urgencyReason: null,
          modelVersion: "deterministic:calendar-notice-v1",
        }
      : await classifier({
          accountEmail: input.accountEmail,
          sender: header(message, "From"),
          subject: header(message, "Subject"),
          text: message.text || message.snippet,
          voice: input.voice?.(),
          recentContext,
          policy: (() => {
            const value = readOperatorPolicy({ dataDir: coveDataDir(input.dataDir) });
            return value ? formatOperatorPolicy(value) : undefined;
          })(),
        });
    const modelSummary = classified.summary.trim();
    const classifiedWithCalendarSummary = calendarNotice && !deterministicCalendarNotice
      ? {
          ...classified,
          summary: modelSummary && modelSummary !== calendarSummary
            ? `${calendarSummary}. ${modelSummary}`
            : calendarSummary!,
        }
      : classified;
    const result = classifiedWithCalendarSummary.bucket === "reply" && draftBlockReason
      ? {
          ...classifiedWithCalendarSummary,
          bucket: "action" as const,
          draftBody: null,
          recommendedAction: `Cove withheld the reply draft: ${draftBlockReason}. Fix the contact record in CRM, then rerun triage.`,
        }
      : classifiedWithCalendarSummary;
    let voiceJudgeScore: number | null = null;
    let voiceJudgeVerdict: string | null = null;
    if (result.draftBody && input.dataDir) {
      const settings = readCoveEmailSettings({ dataDir: input.dataDir });
      if (settings.voiceReview.judgeEnabled) {
        const fingerprint = readVoiceFingerprint(settings.voiceFingerprintPath);
        if (fingerprint) {
          const judged = await judgeDraftVoice({
            fingerprint,
            draftBody: result.draftBody,
            repoDir: input.repoDir,
            runJobImpl: input.runJobImpl,
          });
          voiceJudgeScore = judged?.score ?? null;
          voiceJudgeVerdict = judged?.verdict ?? null;
        }
      }
    }
    const sourceEvidence = normalizedEvidence(message.text || message.snippet);
    const groundedCommitments = (result.commitments ?? []).filter((commitment) => {
      const quote = normalizedEvidence(commitment.sourceQuote);
      return Boolean(quote) && sourceEvidence.includes(quote);
    });
    const applied = applyEmailClassification({
      messageId: claim.messageId,
      emailItemId: claim.emailItemId,
      threadVersion: claim.threadVersion,
      bucket: result.bucket,
      summary: result.summary,
      recommendedAction: result.recommendedAction,
      draftBody: result.draftBody,
      voiceJudgeScore,
      voiceJudgeVerdict,
      signatureText: input.signatureText,
      artifactPayload: {
        messageId: message.id,
        threadId: message.threadId,
        senderName: from.displayName.slice(0, 240),
        senderEmail: from.address,
        subject: header(message, "Subject").slice(0, 240) || "Email correspondence",
        summary: result.summary,
        occurredAt: message.internalDate
          ? new Date(Number(message.internalDate)).toISOString()
          : null,
        commitments: groundedCommitments,
        recordCorrespondence:
          result.recordCorrespondence === true && result.bucket !== "noise",
        accountEmail: input.accountEmail,
      },
      modelVersion: result.modelVersion,
      dbPath: input.dbPath,
      now: input.now?.(),
    });
    if (applied.applied && result.urgent === true) {
      try {
        (input.urgentHandler ?? handleUrgentEmail)({
          dbPath: input.dbPath ?? localDatabasePath(),
          repoDir: input.repoDir,
          messageId: claim.messageId,
          emailItemId: claim.emailItemId,
          fromHeader: header(message, "From"),
          urgent: result.urgent,
          urgencyReason: result.urgencyReason,
          now: input.now?.(),
        });
      } catch (error) {
        // An urgent email that fails to alert is the exact drop this system
        // exists to prevent, so it goes to the Failure Inbox, not just stderr.
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Urgent email attention handling failed:", detail);
        try {
          recordFailure({
            source: "urgent-email",
            sourceId: claim.messageId,
            message: `Cove judged an email urgent but could not alert: ${detail}`,
            details: { messageId: claim.messageId, emailItemId: claim.emailItemId },
            dbPath: input.dbPath,
          });
        } catch (recordError) {
          console.error(
            "Urgent email failure inbox write failed:",
            recordError instanceof Error ? recordError.message : String(recordError),
          );
        }
      }
    }
    const permanentlySkipped = !applied.applied && applied.cause !== "version_mismatch";
    if (applied.applied || permanentlySkipped) {
      await input.gateway.modifyThreadLabels({
        threadId: message.threadId,
        addNames: ["Cove/Triaged"],
      });
    }
    return {
      summary: applied.applied
        ? deterministicCalendarNotice
          ? "Classified one calendar response through the deterministic boundary."
          : "Classified one email through the tool-free model boundary."
        : permanentlySkipped
          ? "Email classification could no longer apply and its ingestion marker was recorded."
          : "A newer message superseded this email classification.",
      actions: {
        messageId: claim.messageId,
        emailItemId: claim.emailItemId,
        applied: applied.applied,
        cause: applied.cause,
        bucket: result.bucket,
        operationId: applied.operationId,
      },
    };
  };
}

export function createEmailArtifactHandler(input: {
  dbPath?: string;
  dataDir?: string;
  now?: () => Date;
}) {
  return async (job: ScheduledJob): Promise<{ summary: string; actions: unknown }> => {
    if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
      throw new Error("Email artifact job payload is invalid.");
    }
    const row = job.payload as Record<string, unknown>;
    const required = (name: string, max: number): string => {
      const value = row[name];
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Email artifact ${name} is missing.`);
      }
      return value.trim().slice(0, max);
    };
    const messageId = required("messageId", 500);
    const threadId = required("threadId", 500);
    const accountEmail = required("accountEmail", 500);
    const rawCommitments = Array.isArray(row.commitments) ? row.commitments : [];
    const commitments = rawCommitments.slice(0, 5).flatMap<EmailCommitmentInput>((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const candidate = value as Record<string, unknown>;
      if (candidate.kind !== "follow_up" && candidate.kind !== "waiting_on") return [];
      if (typeof candidate.title !== "string" || typeof candidate.sourceQuote !== "string") {
        return [];
      }
      return [{
        kind: candidate.kind,
        title: candidate.title,
        sourceQuote: candidate.sourceQuote,
        dueAt: typeof candidate.dueAt === "string" ? candidate.dueAt : null,
        threadId,
        threadLink: `https://mail.google.com/mail/u/?authuser=${
          encodeURIComponent(accountEmail)
        }#all/${encodeURIComponent(threadId)}`,
      }];
    });
    if (commitments.length) {
      captureEmailCommitments({
        commitments,
        dbPath: input.dbPath,
        now: input.now?.(),
      });
    }
    let correspondenceStatus: string | undefined;
    if (row.recordCorrespondence === true) {
      correspondenceStatus = recordEmailCorrespondence({
        senderName: required("senderName", 240),
        senderEmail: required("senderEmail", 500),
        threadId,
        messageId,
        title: required("subject", 240),
        content: required("summary", 20_000),
        direction: "inbound",
        occurredAt: typeof row.occurredAt === "string" ? row.occurredAt : undefined,
        dbPath: input.dbPath,
        dataDir: input.dataDir,
        now: input.now?.(),
      }).status;
    }
    return {
      summary: "Persisted grounded email commitment and relationship candidates.",
      actions: {
        messageId,
        commitments: commitments.length,
        correspondenceStatus,
      },
    };
  };
}
