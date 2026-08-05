'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  abandonTaskSessionRun,
  launchTaskSessionRun,
  listTaskSessionRuns,
  subscribeTaskSessionChanges,
  TASK_SESSION_POLL_INTERVAL_MS,
} from '@/lib/data/task-sessions';
import type {
  LaunchTaskSessionInput,
  TaskSessionRun,
} from '@/lib/task-sessions/types';

const ACTIVE_TASK_SESSION_POLL_INTERVAL_MS = 10_000;

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
    if (typeof window === 'undefined') return;
    const interval = hasActiveRun
      ? ACTIVE_TASK_SESSION_POLL_INTERVAL_MS
      : TASK_SESSION_POLL_INTERVAL_MS;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, interval);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, refresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refresh]);

  const latestByTaskId = useMemo(
    () => new Map(runs.map((run) => [run.taskId, run])),
    [runs],
  );
  const activeRuns = useMemo(
    () => runs.filter(
      (run) => run.status === 'running' || run.status === 'awaiting_approval',
    ),
    [runs],
  );
  const outputReadyRuns = useMemo(
    () => runs.filter((run) => run.status === 'output_ready'),
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

  const abandon = useCallback(async (runId: string) => {
    const previous = runs.find((run) => run.id === runId);
    if (!previous) throw new Error('Task session run not found.');
    const optimisticTime = new Date().toISOString();
    setRuns((current) => current.map((run) => run.id === runId
      ? {
          ...run,
          status: 'abandoned',
          hint: 'Stopping the Claude session.',
          errorCode: 'user_closed',
          updatedAt: optimisticTime,
          finishedAt: optimisticTime,
        }
      : run));
    setError(undefined);
    try {
      const run = await abandonTaskSessionRun(runId);
      setRuns((current) => current.map((candidate) => candidate.id === runId ? run : candidate));
      await refresh();
      return run;
    } catch (nextError) {
      setRuns((current) => current.map((run) => run.id === runId ? previous : run));
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Cove couldn't stop the Claude session.",
      );
      await refresh();
      throw nextError;
    }
  }, [refresh, runs]);

  return {
    runs,
    activeRuns,
    outputReadyRuns,
    latestByTaskId,
    launchingTaskIds,
    error,
    refresh,
    launch,
    abandon,
  };
}
