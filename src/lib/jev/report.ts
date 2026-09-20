/**
 * Turns the shadow ledger into the numbers that decide whether Jev is allowed
 * to act.
 *
 * Shadow mode produces two answers for the same question: Cove's existing one
 * and Jev's. On its own that is a pile of rows. What a decision needs is the
 * rate at which they agree, where they disagree, whether the probability Jev
 * reports tracks how often it is right, and what the lane cost to run.
 *
 * One deliberate omission: this reports agreement with Cove's current owner,
 * not accuracy. The existing classifier is not ground truth, so a disagreement
 * is a case to read, never a Jev error. Calling it accuracy would be the exact
 * mistake the evaluation plan warns about.
 */
import type Database from "better-sqlite3";
import { readJevAssessments, type JevAssessmentRow } from "./ledger";

export type JevCalibrationBucket = {
  /** Lower edge of the reported-probability band, e.g. 0.8 for 0.8 to 0.9. */
  from: number;
  to: number;
  count: number;
  /** How often the answer in this band matched Cove's existing decision. */
  agreementRate: number;
};

export type JevQuestionReport = {
  questionKey: string;
  feature: string;
  answerKind: "choice" | "noul";
  total: number;
  comparable: number;
  agreed: number;
  agreementRate: number;
  /** Present for choice questions, which are the only ones with confidence. */
  medianConfidence: number | null;
  calibration: JevCalibrationBucket[];
  disagreements: {
    refId: string;
    jev: string;
    cove: string;
    reportedProbability: number | null;
    createdAt: string;
  }[];
};

export type JevAttemptReport = {
  attempts: number;
  succeeded: number;
  failuresByCode: Record<string, number>;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  estimatedCostUsd: number;
  /** Attempts whose usage never came back, whose spend is reserved not measured. */
  unknownUsage: number;
};

export type JevReport = {
  since: string;
  questions: JevQuestionReport[];
  attempts: JevAttemptReport;
};

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
}

/** The probability Jev reported for the answer it gave, on a 0 to 1 scale. */
function reportedProbability(row: JevAssessmentRow): number | null {
  if (row.answerKind === "noul") return row.noul;
  return row.confidence;
}

function calibration(rows: JevAssessmentRow[]): JevCalibrationBucket[] {
  const buckets: JevCalibrationBucket[] = [];
  for (let edge = 0; edge < 10; edge += 1) {
    const from = edge / 10;
    const to = (edge + 1) / 10;
    const inBucket = rows.filter((row) => {
      const probability = reportedProbability(row);
      if (probability === null || row.agreed === null) return false;
      // The top bucket is closed so a reported 1.0 has somewhere to land.
      return edge === 9
        ? probability >= from && probability <= to
        : probability >= from && probability < to;
    });
    if (inBucket.length === 0) continue;
    buckets.push({
      from,
      to,
      count: inBucket.length,
      agreementRate: inBucket.filter((row) => row.agreed).length / inBucket.length,
    });
  }
  return buckets;
}

export function buildJevReport(input: {
  db: Database.Database;
  since: string;
  maxDisagreementExamples?: number;
}): JevReport {
  const examples = input.maxDisagreementExamples ?? 5;
  const all = readJevAssessments({ db: input.db, limit: 2_000 })
    .filter((row) => row.createdAt >= input.since);

  const byQuestion = new Map<string, JevAssessmentRow[]>();
  for (const row of all) {
    // Commitment and meeting-item questions are keyed per candidate within one
    // source. They are the same question, so they are reported together rather
    // than as one single-row group per email or meeting.
    const key = row.questionKey
      .replace(/^commitment_\d+_/, "commitment_")
      .replace(/^item_\d+_/, "item_");
    const group = byQuestion.get(key);
    if (group) group.push(row);
    else byQuestion.set(key, [row]);
  }

  const questions: JevQuestionReport[] = [];
  for (const [questionKey, rows] of [...byQuestion.entries()].sort()) {
    const comparable = rows.filter((row) => row.agreed !== null);
    const agreed = comparable.filter((row) => row.agreed).length;
    const confidences = rows
      .map((row) => row.confidence)
      .filter((value): value is number => value !== null);
    questions.push({
      questionKey,
      feature: rows[0].feature,
      answerKind: rows[0].answerKind,
      total: rows.length,
      comparable: comparable.length,
      agreed,
      agreementRate: comparable.length === 0 ? 0 : agreed / comparable.length,
      medianConfidence: percentile(confidences, 0.5),
      calibration: calibration(rows),
      disagreements: comparable
        .filter((row) => row.agreed === false)
        .slice(0, examples)
        .map((row) => ({
          refId: row.refId,
          jev: row.answerKind === "choice"
            ? String(row.choice)
            : String(row.noul?.toFixed(2) ?? ""),
          cove: String(row.baseline ?? ""),
          reportedProbability: reportedProbability(row),
          createdAt: row.createdAt,
        })),
    });
  }

  const attemptRows = input.db.prepare(
    `SELECT outcome, latency_ms, estimated_cost_usd, usage_known
       FROM cove_jev_attempts WHERE created_at >= ?`,
  ).all(input.since) as {
    outcome: string;
    latency_ms: number | null;
    estimated_cost_usd: number;
    usage_known: number;
  }[];
  const latencies = attemptRows
    .map((row) => row.latency_ms)
    .filter((value): value is number => typeof value === "number");
  const failuresByCode: Record<string, number> = {};
  for (const row of attemptRows) {
    if (row.outcome === "ok") continue;
    failuresByCode[row.outcome] = (failuresByCode[row.outcome] ?? 0) + 1;
  }

  return {
    since: input.since,
    questions,
    attempts: {
      attempts: attemptRows.length,
      succeeded: attemptRows.filter((row) => row.outcome === "ok").length,
      failuresByCode,
      medianLatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      estimatedCostUsd: attemptRows.reduce(
        (total, row) => total + (Number(row.estimated_cost_usd) || 0),
        0,
      ),
      unknownUsage: attemptRows.filter((row) => Number(row.usage_known) !== 1).length,
    },
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatJevReport(report: JevReport): string {
  const lines: string[] = [];
  lines.push(`Jev shadow readout since ${report.since}`);
  lines.push("");
  if (report.questions.length === 0) {
    lines.push("No assessments were recorded in this window.");
  }
  for (const question of report.questions) {
    lines.push(`${question.questionKey} (${question.feature}, ${question.answerKind})`);
    lines.push(
      `  agreed with Cove on ${question.agreed} of ${question.comparable}` +
        ` (${percent(question.agreementRate)})`,
    );
    if (question.medianConfidence !== null) {
      lines.push(`  median confidence ${question.medianConfidence.toFixed(2)}`);
    }
    if (question.calibration.length > 0) {
      const bands = question.calibration
        .map((bucket) =>
          `${bucket.from.toFixed(1)}-${bucket.to.toFixed(1)}: ` +
          `${percent(bucket.agreementRate)} of ${bucket.count}`
        )
        .join(", ");
      lines.push(`  reported probability against agreement: ${bands}`);
    }
    for (const example of question.disagreements) {
      lines.push(`  Jev said ${example.jev}, Cove said ${example.cove} (${example.refId})`);
    }
    lines.push("");
  }
  const attempts = report.attempts;
  lines.push(
    `${attempts.attempts} call(s), ${attempts.succeeded} answered` +
      (attempts.unknownUsage ? `, ${attempts.unknownUsage} with unknown usage` : ""),
  );
  if (attempts.medianLatencyMs !== null) {
    lines.push(
      `median ${attempts.medianLatencyMs} ms, 95th percentile ${attempts.p95LatencyMs} ms`,
    );
  }
  lines.push(`reserved spend $${attempts.estimatedCostUsd.toFixed(6)}`);
  const failures = Object.entries(attempts.failuresByCode);
  if (failures.length > 0) {
    lines.push(
      `failures: ${failures.map(([code, count]) => `${code} x${count}`).join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    "Agreement is agreement with Cove's current classifier, which is not ground",
  );
  lines.push(
    "truth. Read the disagreements before treating any of them as a Jev error.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Waiting-on resolution                                                       */
/*                                                                            */
/* This lane has no existing owner to agree with, so the report above cannot   */
/* say anything about it. What it has instead is better: the operator's own    */
/* later action on the commitment. If Jev said an email delivered the thing    */
/* and the operator went on to close that commitment, the lane could have told */
/* them sooner, and the gap between the two is how much sooner.                */
/* -------------------------------------------------------------------------- */

export type JevWaitingOutcome = {
  commitmentId: string;
  title: string;
  /** What the two atomic halves composed to at the time. */
  saidResolved: boolean | null;
  assessedAt: string;
  status: string | null;
  closedAt: string | null;
  /** Days between Jev's reading and the operator closing it, when both exist. */
  daysAhead: number | null;
};

export type JevWaitingReport = {
  since: string;
  total: number;
  /** Jev said delivered, and the operator has since closed the commitment. */
  confirmed: JevWaitingOutcome[];
  /** Jev said delivered and the commitment is still open. Read these first. */
  unconfirmed: JevWaitingOutcome[];
  /** Jev said still outstanding, and the operator closed it anyway. */
  missed: JevWaitingOutcome[];
  /** Jev said still outstanding and it is still open. The quiet, correct case. */
  consistent: JevWaitingOutcome[];
  /** Median days Jev's reading preceded the operator's own close. */
  medianDaysAhead: number | null;
};

function detailRecord(detail: unknown): Record<string, unknown> {
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? detail as Record<string, unknown>
    : {};
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function buildJevWaitingOutcomes(input: {
  db: Database.Database;
  since: string;
}): JevWaitingReport {
  const rows = readJevAssessments({
    db: input.db,
    feature: "waitingResolution",
    limit: 2_000,
  }).filter((row) =>
    row.createdAt >= input.since && row.questionKey === "waiting_delivered"
  );

  const commitments = new Map<string, { status: string; updated_at: string; title: string }>();
  if (rows.length > 0) {
    // One read of the commitments named, rather than a query per row.
    const ids = [...new Set(rows.map((row) => row.refId))];
    const placeholders = ids.map(() => "?").join(",");
    const found = input.db.prepare(
      `SELECT id, status, updated_at, title FROM commitments WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{ id: string; status: string; updated_at: string; title: string }>;
    for (const row of found) {
      commitments.set(row.id, {
        status: row.status,
        updated_at: row.updated_at,
        title: row.title,
      });
    }
  }

  const report: JevWaitingReport = {
    since: input.since,
    total: rows.length,
    confirmed: [],
    unconfirmed: [],
    missed: [],
    consistent: [],
    medianDaysAhead: null,
  };
  const aheadDays: number[] = [];

  for (const row of rows) {
    const detail = detailRecord(row.detail);
    const composed = detail.composedVerdict;
    const saidResolved = typeof composed === "boolean" ? composed : null;
    const commitment = commitments.get(row.refId);
    // A commitment Cove no longer holds cannot be scored either way.
    const status = commitment?.status ?? null;
    const closed = status === "done";
    // updated_at moves for any edit, so this is when the row last changed and
    // not provably when it was closed. It is the best Cove records and it is
    // only ever used as a lower bound on how far ahead the reading was.
    const closedAt = closed ? commitment?.updated_at ?? null : null;
    const daysAhead = closedAt && closedAt > row.createdAt
      ? (Date.parse(closedAt) - Date.parse(row.createdAt)) / 86_400_000
      : null;
    const outcome: JevWaitingOutcome = {
      commitmentId: row.refId,
      title: String(detail.title ?? commitment?.title ?? ""),
      saidResolved,
      assessedAt: row.createdAt,
      status,
      closedAt,
      daysAhead: daysAhead === null ? null : Math.round(daysAhead * 10) / 10,
    };
    if (saidResolved === null || status === null) continue;
    if (saidResolved && closed) {
      report.confirmed.push(outcome);
      if (outcome.daysAhead !== null) aheadDays.push(outcome.daysAhead);
    } else if (saidResolved && !closed) {
      report.unconfirmed.push(outcome);
    } else if (!saidResolved && closed) {
      report.missed.push(outcome);
    } else {
      report.consistent.push(outcome);
    }
  }

  report.medianDaysAhead = median(aheadDays);
  return report;
}

export function formatJevWaitingReport(report: JevWaitingReport): string {
  const lines: string[] = [];
  lines.push(`Waiting-on readings since ${report.since}: ${report.total}`);
  lines.push("");
  lines.push(`Jev said delivered, operator later closed it: ${report.confirmed.length}`);
  lines.push(`Jev said delivered, still open: ${report.unconfirmed.length}`);
  lines.push(`Jev said still owed, operator closed it anyway: ${report.missed.length}`);
  lines.push(`Jev said still owed, still open: ${report.consistent.length}`);
  if (report.medianDaysAhead !== null) {
    lines.push("");
    lines.push(
      `Median days between Jev's reading and the operator's own close: `
        + `${report.medianDaysAhead}`,
    );
  }
  if (report.unconfirmed.length > 0) {
    lines.push("");
    lines.push("Still open although Jev read the thing as delivered:");
    for (const outcome of report.unconfirmed.slice(0, 10)) {
      lines.push(`  ${outcome.title} (${outcome.commitmentId}), read ${outcome.assessedAt}`);
    }
  }
  if (report.missed.length > 0) {
    lines.push("");
    lines.push("Closed by the operator although Jev read it as still owed:");
    for (const outcome of report.missed.slice(0, 10)) {
      lines.push(`  ${outcome.title} (${outcome.commitmentId}), read ${outcome.assessedAt}`);
    }
  }
  lines.push("");
  lines.push(
    "Nothing here is accuracy. A commitment still open after Jev read the thing "
      + "as delivered may mean Jev was wrong, or may mean the operator has not "
      + "got to it yet, which is the case this lane exists to catch.",
  );
  return lines.join("\n");
}
