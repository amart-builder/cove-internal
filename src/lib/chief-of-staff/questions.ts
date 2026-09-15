import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
export type PendingPlanningQuestion = {
  id: string;
  question: string;
  outcome_key: string;
  decision_key: string;
  ref_kind: string;
  ref_id: string;
  state: "open" | "answered" | "parked" | "expired" | "superseded";
  answer: string | null;
  answer_source: string | null;
  next_check_at: string;
  expires_at: string;
  revision: number;
  created_at: string;
  updated_at: string;
};
export function planningQuestions(
  db: Database.Database,
  now = new Date(),
  source?: { kind: string; id: string },
): PendingPlanningQuestion[] {
  db.prepare(
    "UPDATE cove_planning_questions SET state='expired',revision=revision+1,updated_at=? WHERE state='open' AND expires_at<=?",
  ).run(now.toISOString(), now.toISOString());
  return db
    .prepare(
      "SELECT * FROM cove_planning_questions WHERE state='open' AND (? IS NULL OR (ref_kind=? AND ref_id=?)) ORDER BY next_check_at,created_at LIMIT 3",
    )
    .all(
      source?.kind ?? null,
      source?.kind ?? null,
      source?.id ?? null,
    ) as PendingPlanningQuestion[];
}
/** An answer is an explicit, source-backed decision, not preference inference. */
export function answerPlanningQuestion(
  db: Database.Database,
  input: {
    id: string;
    revision: number;
    answer: string;
    source: string;
    disposition: "answered" | "parked" | "ambiguous";
  },
  now = new Date(),
): PendingPlanningQuestion {
  if (
    !input.id ||
    !Number.isInteger(input.revision) ||
    typeof input.answer !== "string" ||
    !input.answer.trim() ||
    input.answer.length > 2000 ||
    typeof input.source !== "string" ||
    !input.source.trim() ||
    input.source.length > 200
  )
    throw new Error("Invalid planning answer.");
  if (!["answered", "parked", "ambiguous"].includes(input.disposition))
    throw new Error("Invalid answer state.");
  return db
    .transaction(() => {
      const question = db
        .prepare("SELECT * FROM cove_planning_questions WHERE id=?")
        .get(input.id) as PendingPlanningQuestion | undefined;
      if (
        !question ||
        question.state !== "open" ||
        Date.parse(question.expires_at) <= +now ||
        question.revision !== input.revision
      )
        throw new Error("This question changed. Refresh before answering.");
      db.prepare(
        "UPDATE cove_planning_questions SET state=?,answer=?,answer_source=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      ).run(
        input.disposition === "ambiguous" ? "open" : input.disposition,
        input.answer.trim(),
        input.source,
        now.toISOString(),
        input.id,
        input.revision,
      );
      db.prepare(
        "INSERT INTO cove_responsibility_events VALUES(?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        question.ref_kind,
        question.ref_id,
        "question_answer",
        JSON.stringify({
          questionId: input.id,
          decisionKey: question.decision_key,
          answer: input.answer,
          source: input.source,
          disposition: input.disposition,
        }),
        now.toISOString(),
      );
      // The underlying commitment/check remains alive, even when the question is parked.
      db.prepare(
        "UPDATE cove_responsibilities SET next_check_at=?,revision=revision+1,updated_at=? WHERE ref_kind=? AND ref_id=? AND state<>'resolved'",
      ).run(
        now.toISOString(),
        now.toISOString(),
        question.ref_kind,
        question.ref_id,
      );
      return db
        .prepare("SELECT * FROM cove_planning_questions WHERE id=?")
        .get(input.id) as PendingPlanningQuestion;
    })
    .immediate();
}
