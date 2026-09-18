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
    // Commitment questions are keyed per candidate within an email. They are
    // the same question, so they are reported together rather than as one
    // single-row group per email.
    const key = row.questionKey.replace(/^commitment_\d+_/, "commitment_");
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
