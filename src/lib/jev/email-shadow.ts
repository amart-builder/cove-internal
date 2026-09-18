/**
 * The boundary between email classification and Jev.
 *
 * Email classification is a durable job with a claim, a retry count and a
 * visible failure inbox. Jev is an optional third-party lane that is off on
 * every install until someone turns it on. Nothing that happens here may fail
 * that job, slow it in a way the operator notices, or leave a connection open,
 * so this module owns the connection, swallows every error into a reason, and
 * returns.
 *
 * It is also the one place that reads the credential on this path, which keeps
 * the key out of the classification job's own inputs and out of anything that
 * job logs.
 */
import { openLocalDatabase } from "../local/database";
import { coveDataDir } from "../operator";
import { readJevCredential, readJevSettings } from "./settings";
import { assessEmailWithJev, type JevEmailAssessment, type JevEmailBaseline, type JevEmailEvidence } from "./email";
import type { CoveEnvironment } from "../env";

export async function runJevEmailShadow(input: {
  evidence: JevEmailEvidence;
  baseline: JevEmailBaseline;
  refId: string;
  dbPath?: string;
  dataDir?: string;
  env?: CoveEnvironment;
  now?: () => Date;
}): Promise<JevEmailAssessment> {
  const env = input.env ?? process.env;
  // The cheapest checks first, so a install that has never heard of Jev does
  // no file reads and opens no connection on every single email.
  if (!readJevCredential(env)) {
    return { ran: false, reason: "No TypeSafe credential is configured." };
  }
  let settings;
  try {
    settings = readJevSettings({ dataDir: coveDataDir(input.dataDir), env });
  } catch {
    return { ran: false, reason: "Jev settings could not be read." };
  }
  if (settings.mode === "off") return { ran: false, reason: "Jev is off." };
  if (!settings.features.emailTriage && !settings.features.commitmentAudit) {
    return { ran: false, reason: "No Jev email feature is enabled." };
  }

  const db = openLocalDatabase(input.dbPath);
  try {
    return await assessEmailWithJev({
      db,
      settings,
      evidence: input.evidence,
      baseline: input.baseline,
      refId: input.refId,
      env,
      now: input.now,
    });
  } catch (error) {
    // A shadow lane that breaks email triage would be worse than no shadow
    // lane. Every failure becomes a reason string and stops here.
    const detail = error instanceof Error ? error.message : String(error);
    return { ran: false, reason: `The Jev shadow pass failed: ${detail.slice(0, 200)}` };
  } finally {
    db.close();
  }
}
