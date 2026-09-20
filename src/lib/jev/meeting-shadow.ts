/**
 * The boundary between meeting analysis and Jev.
 *
 * Meeting analysis is a durable job with a lease, a retry count and a visible
 * failure inbox, and by the time this runs the operator's tasks and commitments
 * have already been written. Nothing here may fail that job, delay a write the
 * operator is waiting on, or leave a connection open, so this module owns the
 * connection, swallows every error into a reason, and returns.
 *
 * It is also the one place that reads the credential on this path, which keeps
 * the key out of the analysis job's inputs and out of anything that job logs.
 */
import { openLocalDatabase } from "../local/database";
import { coveDataDir } from "../operator";
import { withJevCredential } from "./credential";
import { readJevCredential, readJevSettings } from "./settings";
import {
  assessMeetingWithJev,
  type JevMeetingAssessment,
  type JevMeetingBaseline,
  type JevMeetingEvidence,
} from "./meeting";
import type { CoveEnvironment } from "../env";

export async function runJevMeetingShadow(input: {
  evidence: JevMeetingEvidence;
  baseline: JevMeetingBaseline;
  /** The analysis job id. */
  refId: string;
  dbPath?: string;
  dataDir?: string;
  env?: CoveEnvironment;
  now?: () => Date;
}): Promise<JevMeetingAssessment> {
  const dataDir = coveDataDir(input.dataDir);
  // Cheapest checks first, so an install that has never heard of Jev opens no
  // connection after every meeting. The key may have been pasted into the
  // settings screen rather than the environment, so the one file this looks at
  // before giving up is the stored copy.
  const env = withJevCredential(input.env ?? process.env, dataDir);
  const apiKey = readJevCredential(env);
  if (!apiKey) return { ran: false, reason: "No TypeSafe credential is configured." };
  if (input.evidence.items.length === 0) {
    return { ran: false, reason: "The meeting proposed nothing to audit." };
  }
  let settings;
  try {
    settings = readJevSettings({ dataDir, env });
  } catch {
    return { ran: false, reason: "Jev settings could not be read." };
  }
  if (settings.mode === "off") return { ran: false, reason: "Jev is off." };
  if (!settings.features.meetingAudit) {
    return { ran: false, reason: "The Jev meeting audit is not enabled." };
  }

  const db = openLocalDatabase(input.dbPath);
  try {
    return await assessMeetingWithJev({
      db,
      settings,
      evidence: input.evidence,
      baseline: input.baseline,
      refId: input.refId,
      apiKey,
      env,
      now: input.now,
    });
  } catch (error) {
    // A shadow lane that breaks meeting analysis would be worse than no shadow
    // lane. Every failure becomes a reason string and stops here.
    const detail = error instanceof Error ? error.message : String(error);
    return { ran: false, reason: `The Jev meeting pass failed: ${detail.slice(0, 200)}` };
  } finally {
    db.close();
  }
}
