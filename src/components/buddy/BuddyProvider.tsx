'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { BuddyReceipts, PendingDelete } from '@/lib/buddy/receipts';
import { emitDataChanged } from '@/lib/data/refresh-bus';

export type BuddyTurnView = {
  id: string;
  user_text: string;
  page_context: string;
  model: 'sonnet' | 'opus';
  effort: 'low' | 'medium' | 'high';
  router_reason: string;
  state: 'running' | 'succeeded' | 'failed';
  assistant_text: string;
  error_code: string | null;
  started_at: string;
  receipts?: BuddyReceipts;
};

type SessionInfo = {
  headSessionId: string | null;
  turnCount: number;
  totalCostUsd: number;
  createdAt: string;
  hostname: string;
  deepLinksEnabled: boolean;
};

type BuddyContextValue = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  pageContext: Record<string, unknown>;
  setPageContext: (value: Record<string, unknown>) => void;
  turns: BuddyTurnView[];
  busy: boolean;
  send: (text: string, override?: 'fast' | 'deep') => Promise<BuddyTurnView | undefined>;
  resetConversation: () => Promise<void>;
  confirmDelete: (turnId: string, pending: PendingDelete) => Promise<void>;
  dismissDelete: (turnId: string, pending: PendingDelete) => Promise<void>;
  sessionInfo?: SessionInfo;
};

type BuddyStreamContextValue = {
  streamingTurn?: BuddyTurnView;
  thinking: boolean;
};

const BuddyContext = createContext<BuddyContextValue | undefined>(undefined);
const BuddyStreamContext = createContext<BuddyStreamContextValue | undefined>(undefined);

function viewForPath(pathname: string): string {
  if (pathname.startsWith('/tasks')) return 'tasks';
  if (pathname.startsWith('/crm')) return 'crm';
  return 'other';
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

function emitReceiptChanges(receipts: BuddyReceipts | undefined): void {
  const tables = receipts?.changes.map((change) => change.table) ?? [];
  if (tables.length) emitDataChanged([...new Set(tables)]);
}

export function BuddyProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pageContext, setPageContext] = useState<Record<string, unknown>>({ view: viewForPath(pathname) });
  const [turns, setTurns] = useState<BuddyTurnView[]>([]);
  const [streamingTurn, setStreamingTurn] = useState<BuddyTurnView>();
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo>();
  const [csrfToken, setCsrfToken] = useState<string>();
  const streamingTurnRef = useRef<BuddyTurnView | undefined>(undefined);
  const pendingStreamingTurnRef = useRef<BuddyTurnView | undefined>(undefined);
  const streamFrameRef = useRef<number | undefined>(undefined);

  const queueStreamingTurn = useCallback((turn: BuddyTurnView) => {
    streamingTurnRef.current = turn;
    setBusy(true);
    pendingStreamingTurnRef.current = turn;
    if (streamFrameRef.current !== undefined) return;
    streamFrameRef.current = window.requestAnimationFrame(() => {
      streamFrameRef.current = undefined;
      setStreamingTurn(pendingStreamingTurnRef.current);
    });
  }, []);

  const clearStreamingTurn = useCallback(() => {
    streamingTurnRef.current = undefined;
    setBusy(false);
    pendingStreamingTurnRef.current = undefined;
    if (streamFrameRef.current !== undefined) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = undefined;
    }
    setStreamingTurn(undefined);
  }, []);

  useEffect(() => () => {
    if (streamFrameRef.current !== undefined) window.cancelAnimationFrame(streamFrameRef.current);
  }, []);

  useEffect(() => {
    setPageContext({ view: viewForPath(pathname) });
  }, [pathname]);

  const hydrate = useCallback(async () => {
    const [historyResponse, sessionResponse, dayPlanResponse] = await Promise.all([
      fetch('/api/buddy/turn?recent=50', { cache: 'no-store' }),
      fetch('/api/buddy/session', { cache: 'no-store' }),
      fetch('/api/day-plan', { cache: 'no-store' }),
    ]);
    const history = await jsonResponse(historyResponse);
    const session = await jsonResponse(sessionResponse);
    const dayPlan = await jsonResponse(dayPlanResponse);
    if (historyResponse.ok && Array.isArray(history.turns)) {
      const loadedTurns = history.turns as BuddyTurnView[];
      setTurns(loadedTurns);
      const running = loadedTurns.find((turn) => turn.state === 'running');
      if (running && !streamingTurnRef.current) queueStreamingTurn(running);
    }
    if (sessionResponse.ok) setSessionInfo(session as SessionInfo);
    if (dayPlanResponse.ok && typeof dayPlan.csrfToken === 'string') setCsrfToken(dayPlan.csrfToken);
  }, [queueStreamingTurn]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  const hydratedRunningTurnId = turns.find((turn) => turn.state === 'running')?.id;
  useEffect(() => {
    if (!hydratedRunningTurnId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/buddy/turn?id=${encodeURIComponent(hydratedRunningTurnId)}`, {
          cache: 'no-store',
        });
        const payload = await jsonResponse(response);
        if (!response.ok || !payload.turn || typeof payload.turn !== 'object') return;
        const turn = payload.turn as BuddyTurnView;
        if (stopped) return;
        setTurns((current) => current.map((item) => item.id === turn.id ? turn : item));
        if (turn.state === 'running') queueStreamingTurn(turn);
        else {
          clearStreamingTurn();
          emitReceiptChanges(turn.receipts);
        }
        if (turn.state !== 'running') void hydrate();
      } catch {
        // A later poll or a manual refresh can recover a transient request failure.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [clearStreamingTurn, hydrate, hydratedRunningTurnId, queueStreamingTurn]);

  const ensureCsrf = useCallback(async () => {
    if (csrfToken) return csrfToken;
    const response = await fetch('/api/day-plan', { cache: 'no-store' });
    const payload = await jsonResponse(response);
    if (!response.ok || typeof payload.csrfToken !== 'string') {
      throw new Error(typeof payload.error === 'string' ? payload.error : 'Forge request token is unavailable.');
    }
    setCsrfToken(payload.csrfToken);
    return payload.csrfToken;
  }, [csrfToken]);

  const send = useCallback(async (text: string, override?: 'fast' | 'deep') => {
    if (streamingTurnRef.current || !text.trim()) return;
    setBusy(true);
    setThinking(false);
    let response: Response;
    try {
      const token = await ensureCsrf();
      response = await fetch('/api/buddy/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-CSRF': token },
        body: JSON.stringify({ text: text.trim(), pageContext, ...(override ? { override } : {}) }),
        cache: 'no-store',
      });
    } catch (error) {
      setBusy(false);
      throw error;
    }
    if (!response.ok || !response.body) {
      const payload = await jsonResponse(response);
      setBusy(false);
      throw new Error(typeof payload.error === 'string' ? payload.error : "Buddy couldn't start that turn.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let live: BuddyTurnView | undefined;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\n\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split(/\r?\n/).find((candidate) => candidate.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (event.kind === 'claimed' && event.turn && typeof event.turn === 'object') {
            live = event.turn as BuddyTurnView;
            queueStreamingTurn(live);
          } else if (event.kind === 'thinking') {
            setThinking(true);
          } else if (event.kind === 'delta' && typeof event.text === 'string' && live) {
            setThinking(false);
            live = { ...live, assistant_text: live.assistant_text + event.text };
            queueStreamingTurn(live);
          } else if (event.kind === 'done' && live) {
            setThinking(false);
            live = {
              ...live,
              state: event.isError === true ? 'failed' : 'succeeded',
              assistant_text: typeof event.resultText === 'string' && (event.resultText || event.receipts)
                ? event.resultText
                : live.assistant_text,
              ...(event.receipts && typeof event.receipts === 'object'
                ? { receipts: event.receipts as BuddyReceipts }
                : {}),
            };
            queueStreamingTurn(live);
            const receipts = event.receipts as BuddyReceipts | undefined;
            emitReceiptChanges(receipts);
            if (typeof event.costUsd === 'number') {
              const costUsd = event.costUsd;
              setSessionInfo((current) => current ? {
                ...current,
                headSessionId: typeof event.sessionId === 'string' ? event.sessionId : current.headSessionId,
                turnCount: current.turnCount + 1,
                totalCostUsd: current.totalCostUsd + costUsd,
              } : current);
            }
          } else if (event.kind === 'compacting' && live) {
            setThinking(true);
            live = { ...live, assistant_text: '' };
            queueStreamingTurn(live);
          } else if (event.kind === 'failed' && live) {
            setThinking(false);
            const receipts = event.receipts && typeof event.receipts === 'object'
              ? event.receipts as BuddyReceipts
              : undefined;
            live = {
              ...live,
              state: 'failed',
              error_code: typeof event.errorCode === 'string' ? event.errorCode : 'interrupted',
              ...(receipts ? { receipts } : {}),
            };
            queueStreamingTurn(live);
            emitReceiptChanges(receipts);
          }
        }
        if (done) break;
      }
    } finally {
      clearStreamingTurn();
      setThinking(false);
      await hydrate();
    }
    return live;
  }, [clearStreamingTurn, ensureCsrf, hydrate, pageContext, queueStreamingTurn]);

  const setPendingDisposition = useCallback((turnId: string, pending: PendingDelete,
    disposition: 'confirmed' | 'dismissed', expiresAt?: string) => {
    setTurns((current) => current.map((turn) => turn.id !== turnId || !turn.receipts ? turn : {
      ...turn,
      receipts: {
        ...turn.receipts,
        pendingDeletes: turn.receipts.pendingDeletes.map((item) =>
          item.table === pending.table && item.id === pending.id && !item.disposition
            ? { ...item, disposition, ...(expiresAt ? { expiresAt } : {}) }
            : item),
      },
    }));
  }, []);

  const confirmDelete = useCallback(async (turnId: string, pending: PendingDelete) => {
    const token = await ensureCsrf();
    const response = await fetch('/api/buddy/confirm-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-CSRF': token },
      body: JSON.stringify({ turnId, table: pending.table, id: pending.id, label: pending.label }),
      cache: 'no-store',
    });
    const payload = await jsonResponse(response);
    if (!response.ok || typeof payload.token !== 'string') {
      throw new Error(typeof payload.error === 'string' ? payload.error : 'Delete confirmation failed.');
    }
    const result = await send(`CONFIRM_DELETE token=${payload.token} table=${pending.table} id=${pending.id}`);
    const deleted = result?.state === 'succeeded' && result.receipts?.changes.some((change) =>
      change.action === 'delete' && change.table === pending.table && change.id === pending.id);
    if (!deleted) throw new Error('Buddy did not confirm that the row was deleted. You can try again.');
    const resolved = await fetch('/api/buddy/confirm-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-CSRF': token },
      body: JSON.stringify({ action: 'resolve', turnId, table: pending.table, id: pending.id }),
      cache: 'no-store',
    });
    const resolvedPayload = await jsonResponse(resolved);
    if (!resolved.ok) {
      throw new Error(typeof resolvedPayload.error === 'string' ? resolvedPayload.error : 'Delete status could not be saved.');
    }
    setPendingDisposition(turnId, pending, 'confirmed');
  }, [ensureCsrf, send, setPendingDisposition]);

  const dismissDelete = useCallback(async (turnId: string, pending: PendingDelete) => {
    const token = await ensureCsrf();
    const response = await fetch('/api/buddy/confirm-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-CSRF': token },
      body: JSON.stringify({ action: 'dismiss', turnId, table: pending.table, id: pending.id }),
      cache: 'no-store',
    });
    const payload = await jsonResponse(response);
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Cancel failed.');
    setPendingDisposition(turnId, pending, 'dismissed');
  }, [ensureCsrf, setPendingDisposition]);

  const resetConversation = useCallback(async () => {
    if (streamingTurnRef.current) return;
    const token = await ensureCsrf();
    const response = await fetch('/api/buddy/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-CSRF': token },
      body: JSON.stringify({ action: 'reset' }),
      cache: 'no-store',
    });
    const payload = await jsonResponse(response);
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Reset failed.');
    setSessionInfo(payload as SessionInfo);
  }, [ensureCsrf]);

  const value = useMemo(() => ({
    open, setOpen, pageContext, setPageContext, turns, busy, send, resetConversation,
    confirmDelete, dismissDelete, sessionInfo,
  }), [open, pageContext, turns, busy, send, resetConversation, confirmDelete, dismissDelete, sessionInfo]);
  const streamValue = useMemo(() => ({ streamingTurn, thinking }), [streamingTurn, thinking]);

  return (
    <BuddyContext.Provider value={value}>
      <BuddyStreamContext.Provider value={streamValue}>
        {children}
      </BuddyStreamContext.Provider>
    </BuddyContext.Provider>
  );
}

export function useBuddyStream(): BuddyStreamContextValue {
  const value = useContext(BuddyStreamContext);
  if (!value) throw new Error('useBuddyStream must be used inside BuddyProvider.');
  return value;
}

export function useBuddy(): BuddyContextValue {
  const value = useContext(BuddyContext);
  if (!value) throw new Error('useBuddy must be used inside BuddyProvider.');
  return value;
}
