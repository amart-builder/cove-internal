'use client';

import { useEffect, useRef } from 'react';

const EVENT_NAME = 'forge:data-changed';

export function emitDataChanged(tables: string[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME, {
    detail: { tables: [...new Set(tables)] },
  }));
}

export function useDataChanged(tables: string[], callback: () => void): void {
  const callbackRef = useRef(callback);
  const tableKey = tables.join('\u0000');
  callbackRef.current = callback;
  useEffect(() => {
    const subscribed = new Set(tableKey.split('\u0000').filter(Boolean));
    const onChanged = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{ tables?: unknown }>;
      const changed = Array.isArray(event.detail?.tables)
        ? event.detail.tables.filter((table): table is string => typeof table === 'string')
        : [];
      if (changed.includes('*') || subscribed.has('*') || changed.some((table) => subscribed.has(table))) {
        callbackRef.current();
      }
    };
    window.addEventListener(EVENT_NAME, onChanged);
    return () => window.removeEventListener(EVENT_NAME, onChanged);
  }, [tableKey]);
}
