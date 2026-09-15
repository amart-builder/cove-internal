'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const keyForPlan = (planId: string) => `cove.closeout-draft.v1:${planId}`;

/** Keep a narrative with its exact plan across navigation and browser restarts. */
export default function useCloseoutDraft(planId: string | undefined) {
  const [draft, setDraft] = useState<{ planId?: string; note: string }>({ note: '' });
  const [error, setError] = useState<string>();
  const currentPlanRef = useRef(planId);
  useEffect(() => {
    currentPlanRef.current = planId;
    if (!planId) return;
    const timer = window.setTimeout(() => {
      try {
        const note = window.localStorage.getItem(keyForPlan(planId)) ?? '';
        setDraft(current => current.planId === planId ? current : { planId, note });
        setError(undefined);
      } catch {
        setError('Your closeout draft cannot be saved in this browser. Keep this page open until you close the day.');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [planId]);

  const setNote = useCallback((note: string) => {
    if (!planId) return;
    setDraft({ planId, note });
    try {
      if (note) window.localStorage.setItem(keyForPlan(planId), note);
      else window.localStorage.removeItem(keyForPlan(planId));
      setError(undefined);
    } catch {
      setError('Your closeout draft cannot be saved in this browser. Keep this page open until you close the day.');
    }
  }, [planId]);

  const clearSavedDraft = useCallback((savedPlanId: string, savedNote: string) => {
    try {
      if (window.localStorage.getItem(keyForPlan(savedPlanId)) === savedNote) {
        window.localStorage.removeItem(keyForPlan(savedPlanId));
      }
    } catch {
      if (currentPlanRef.current === savedPlanId) setError('Your day was saved, but the browser draft could not be cleared.');
    }
    // A delayed response cannot erase later typing, in this tab or another one.
    setDraft(current => current.planId === savedPlanId && current.note === savedNote
      ? { planId: savedPlanId, note: '' } : current);
  }, []);

  return { note: draft.planId === planId ? draft.note : '', setNote, clearSavedDraft, error };
}
