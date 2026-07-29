'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  launchTaskSessionRun,
  listTaskSessionRuns,
  subscribeTaskSessionChanges,
  TASK_SESSION_POLL_INTERVAL_MS,
} from '@/lib/data/task-sessions';
import type {
  LaunchTaskSessionInput,
  TaskSessionRun,
} from '@/lib/task-sessions/types';

export default function useTaskSessionRuns(taskIds: readonly string[]) {
  const taskIdKey = [...new Set(taskIds)].sort().join('\u0000');
  const stableTaskIds = useMemo(
    () => taskIdKey ? taskIdKey.split('\u0000') : [],
    [taskIdKey],
  );
  const [runs, setRuns] = useState<TaskSessionRun[]>([]);
  const [error, setError] = useState<string>();
  const [launchingTaskIds, setLaunchingTaskIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const snapshot = await listTaskSessionRuns(stableTaskIds);
      setRuns(snapshot.runs);
      setError(undefined);
      return snapshot.runs;
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Cove couldn't refresh Claude session runs.",
      );
      return undefined;
    }
  }, [stableTaskIds]);

  useEffect(() => {
    void refresh();
    return subscribeTaskSessionChanges(() => void refresh());
  }, [refresh]);

  const hasActiveRun = runs.some(
    (run) => run.status === 'running' || run.status === 'awaiting_approval',
  );
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => void refresh(), TASK_SESSION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, refresh]);

  const latestByTaskId = useMemo(
    () => new Map(runs.map((run) => [run.taskId, run])),
    [runs],
  );

  const launch = useCallback(async (input: LaunchTaskSessionInput) => {
    setLaunchingTaskIds((current) => new Set(current).add(input.taskId));
    setError(undefined);
    try {
      const run = await launchTaskSessionRun(input);
      setRuns((current) => [
        run,
        ...current.filter((candidate) => candidate.taskId !== run.taskId),
      ]);
      return run;
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Cove couldn't start the Claude session.",
      );
      throw nextError;
    } finally {
      setLaunchingTaskIds((current) => {
        const next = new Set(current);
        next.delete(input.taskId);
        return next;
      });
    }
  }, []);

  return {
    runs,
    latestByTaskId,
    launchingTaskIds,
    error,
    refresh,
    launch,
  };
}
