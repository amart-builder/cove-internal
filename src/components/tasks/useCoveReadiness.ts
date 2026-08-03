'use client';

import { useSyncExternalStore } from 'react';
import type { CoveReadiness } from '@/lib/health/readiness';

export type CoveReadinessSnapshot = {
  readiness?: CoveReadiness;
  error?: string;
  checking: boolean;
  notApplicable: boolean;
};

type StoreOptions = {
  fetchImpl?: typeof fetch;
  setIntervalImpl?: (callback: () => void, delay: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
};

const INITIAL_SNAPSHOT: CoveReadinessSnapshot = {
  checking: true,
  notApplicable: false,
};

export function createCoveReadinessStore(options: StoreOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const setIntervalImpl = options.setIntervalImpl ??
    ((callback, delay) => window.setInterval(callback, delay));
  const clearIntervalImpl = options.clearIntervalImpl ??
    ((timer) => window.clearInterval(timer as number));
  const listeners = new Set<() => void>();
  let snapshot = INITIAL_SNAPSHOT;
  let interval: unknown;
  let request: Promise<void> | undefined;

  const publish = (next: CoveReadinessSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const stopPolling = () => {
    if (interval === undefined) return;
    clearIntervalImpl(interval);
    interval = undefined;
  };
  const load = (): Promise<void> => {
    if (snapshot.notApplicable) return Promise.resolve();
    if (request) return request;
    if (!snapshot.readiness) {
      publish({ ...snapshot, checking: true, error: undefined });
    }
    request = (async () => {
      try {
        const response = await fetchImpl('/api/health', { cache: 'no-store' });
        if (response.status === 409) {
          publish({ checking: false, notApplicable: true });
          stopPolling();
          return;
        }
        if (!response.ok) throw new Error(`Health check returned ${response.status}.`);
        const payload = await response.json() as { readiness?: CoveReadiness };
        if (!payload.readiness) throw new Error('Health check returned no readiness state.');
        publish({
          readiness: payload.readiness,
          checking: false,
          notApplicable: false,
        });
      } catch (loadError) {
        publish({
          ...snapshot,
          checking: false,
          error: loadError instanceof Error ? loadError.message : String(loadError),
        });
      } finally {
        request = undefined;
      }
    })();
    return request;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1 && !snapshot.notApplicable) {
      void load();
      interval = setIntervalImpl(() => void load(), 60_000);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stopPolling();
    };
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL_SNAPSHOT,
    subscribe,
    load,
  };
}

const sharedStore = createCoveReadinessStore();

export default function useCoveReadiness() {
  const snapshot = useSyncExternalStore(
    sharedStore.subscribe,
    sharedStore.getSnapshot,
    sharedStore.getServerSnapshot,
  );
  return { ...snapshot, retry: sharedStore.load };
}
