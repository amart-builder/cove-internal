"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import type { PendingPlanningQuestion } from "@/lib/chief-of-staff/questions";
import { emitDataChanged, useDataChanged } from "@/lib/data/refresh-bus";
export default function PlanningQuestion({ taskId }: { taskId?: string }) {
  const [question, setQuestion] = useState<PendingPlanningQuestion>();
  const [token, setToken] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const requestSequence = useRef(0);
  const currentTask = useRef(taskId);
  const answer = question ? (answers[question.id] ?? "") : "";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (currentTask.current !== taskId) return;
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch(
        `/api/planning-questions${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const body = await response.json();
      if (sequence !== requestSequence.current) return;
      setQuestion(body.questions?.[0]);
      setToken(body.csrfToken ?? "");
    } catch {
      /* The current question remains usable during a transient failure. */
    }
  }, [taskId]);
  useEffect(() => {
    currentTask.current = taskId;
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      clearInterval(timer);
      requestSequence.current += 1;
    };
  }, [refresh, taskId]);
  useDataChanged(["day_plan", "cove_planning_questions"], () => void refresh());
  async function submit(disposition: "answered" | "parked") {
    if (!question) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/planning-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cove-CSRF": token },
        body: JSON.stringify({
          id: question.id,
          revision: question.revision,
          answer: answer || "Park this question for now.",
          disposition,
          source: taskId ? `task-edit:${taskId}` : "planning-question-form",
        }),
      });
      const body = await response.json();
      if (currentTask.current !== taskId) return;
      if (!response.ok) throw new Error(body.error);
      setAnswers((current) => {
        const remaining = { ...current };
        delete remaining[question.id];
        return remaining;
      });
      await refresh();
      emitDataChanged(["day_plan"]);
    } catch (error) {
      if (currentTask.current !== taskId) return;
      await refresh();
      setError(
        error instanceof Error ? error.message : "Could not save your answer.",
      );
    } finally {
      if (currentTask.current === taskId) setBusy(false);
    }
  }
  if (!question) return null;
  return (
    <form
      className="mx-6 mt-5 rounded-xl border p-4 text-sm sm:mx-10 lg:mx-16"
      onSubmit={(event) => {
        event.preventDefault();
        void submit("answered");
      }}
    >
      <label className="font-medium" htmlFor={`question-${question.id}`}>
        {question.question}
      </label>
      {question.answer && (
        <p className="mt-2 text-muted-foreground">
          Your earlier reply: {question.answer}. Cove still needs clarification.
        </p>
      )}
      <textarea
        id={`question-${question.id}`}
        className="mt-2 min-h-20 w-full rounded-lg border bg-background p-3"
        maxLength={2000}
        value={answer}
        onChange={(event) =>
          setAnswers((current) => ({
            ...current,
            [question.id]: event.target.value,
          }))
        }
      />
      <div className="mt-2 flex gap-3">
        <button
          disabled={busy || !answer.trim()}
          className="min-h-10 rounded-lg bg-foreground px-4 text-background disabled:opacity-50"
          type="submit"
        >
          Save answer
        </button>
        <button
          disabled={busy}
          className="min-h-10 px-3"
          type="button"
          onClick={() => void submit("parked")}
        >
          Not now
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-accent-red">
          {error}
        </p>
      )}
    </form>
  );
}
