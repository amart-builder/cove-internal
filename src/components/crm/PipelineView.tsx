'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchPipeline,
  getContact,
  listContactActivities,
  listContacts,
  logDealTouch,
  moveDeal,
  resolveContact,
  upsertDeal,
  type PipelineResponse,
} from '@/lib/data/crm';
import { emitDataChanged, useDataChanged } from '@/lib/data/refresh-bus';
import type { Contact, ContactActivity } from '@/lib/data/types';
import type { ContactCandidate } from '@/lib/crm/types';
import {
  attentionItems,
  followUpStatus,
  isOpenPipelineStage,
  parseCalendarDate,
  pipelineSummary,
  PIPELINE_STAGE_LABELS,
  type LogPipelineTouchInput,
  type PipelineAttentionItem,
  type PipelineDealPatch,
  type PipelineDealWithContact,
  type PipelineStage,
} from '@/lib/crm/pipeline';
import CrmSubNav from './CrmSubNav';

const CLOSED_STAGES = new Set<PipelineStage>(['lost', 'parked']);
const TOUCH_TYPES: Array<{ id: LogPipelineTouchInput['activityType']; label: string }> = [
  { id: 'call', label: 'Call' },
  { id: 'email', label: 'Email' },
  { id: 'text', label: 'Text' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'note', label: 'Note' },
];

function formatMoney(value: number): string {
  return `$${value.toLocaleString('en-US')}`;
}

function shortCalendarDate(value: string): string {
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dayNumber(value: string): number | null {
  const parsed = parseCalendarDate(value);
  if (!parsed) return null;
  return Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) / 86_400_000;
}

function relativeFollowUp(value: string | null, today: string): string {
  if (!value) return 'No date';
  const valueDay = dayNumber(value);
  const todayDay = dayNumber(today);
  if (valueDay === null || todayDay === null) return value;
  const difference = valueDay - todayDay;
  if (difference < -1) return `${Math.abs(difference)} days overdue`;
  if (difference === -1) return '1 day overdue';
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Tomorrow';
  if (difference <= 7) return `In ${difference} days`;
  return shortCalendarDate(value);
}

function dealValue(deal: PipelineDealWithContact): string | null {
  if (deal.stage === 'client' && deal.monthly_value !== null) {
    return `${formatMoney(deal.monthly_value)}/mo`;
  }
  if (deal.stage !== 'client' && deal.discovery_price !== null) {
    return `${formatMoney(deal.discovery_price)} discovery`;
  }
  if (deal.stage !== 'client' && deal.monthly_value !== null) {
    return `~${formatMoney(deal.monthly_value)}/mo`;
  }
  return null;
}

function attentionReason(item: PipelineAttentionItem): string {
  const text = item.reasons.map((reason) => {
    if (reason === 'overdue' && item.deal.next_follow_up_at) {
      return `follow-up was due ${shortCalendarDate(item.deal.next_follow_up_at)}`;
    }
    if (reason === 'missing_action') return 'no next action';
    return 'no follow-up date';
  }).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withDeals(data: PipelineResponse, deals: PipelineDealWithContact[]): PipelineResponse {
  return {
    ...data,
    deals,
    summary: pipelineSummary(deals, data.today),
    attention: attentionItems(deals, data.today),
  };
}

export default function PipelineView() {
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [addingLead, setAddingLead] = useState(false);
  const [search, setSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [stageErrors, setStageErrors] = useState<Record<string, string>>({});
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const next = await fetchPipeline();
      if (sequence !== loadSequence.current) return;
      setData(next);
      setLoadError(undefined);
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useDataChanged(['pipeline_deals', 'contacts'], () => void load());

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, [load]);

  const visibleDeals = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return data?.deals ?? [];
    return (data?.deals ?? []).filter((deal) =>
      deal.name.toLocaleLowerCase().includes(query) ||
      deal.company.toLocaleLowerCase().includes(query)
    );
  }, [data?.deals, search]);

  const selectedDeal = useMemo(
    () => data?.deals.find((deal) => deal.contact_id === selectedId) ?? null,
    [data?.deals, selectedId],
  );

  const applyDeal = useCallback((deal: PipelineDealWithContact) => {
    loadSequence.current += 1;
    setData((current) => {
      if (!current) return current;
      const exists = current.deals.some((item) => item.contact_id === deal.contact_id);
      const deals = exists
        ? current.deals.map((item) => item.contact_id === deal.contact_id ? deal : item)
        : [...current.deals, deal];
      return withDeals(current, deals);
    });
  }, []);

  const recordWrite = useCallback((deal: PipelineDealWithContact) => {
    applyDeal(deal);
  }, [applyDeal]);

  async function changeStage(contactId: string, stage: PipelineStage) {
    if (!data) return;
    const currentDeal = data.deals.find((deal) => deal.contact_id === contactId);
    if (!currentDeal || currentDeal.stage === stage) return;
    const previousStage = currentDeal.stage;
    setStageErrors((current) => ({ ...current, [contactId]: '' }));
    setData((current) => current
      ? withDeals(current, current.deals.map((deal) =>
          deal.contact_id === contactId ? { ...deal, stage } : deal))
      : current);
    try {
      const saved = await moveDeal(contactId, stage);
      recordWrite(saved);
    } catch (error) {
      setData((current) => current
        ? withDeals(current, current.deals.map((deal) =>
            deal.contact_id === contactId && deal.stage === stage
              ? { ...deal, stage: previousStage }
              : deal))
        : current);
      setStageErrors((current) => ({
        ...current,
        [contactId]: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  function openDeal(contactId: string) {
    setSelectedId(contactId);
    setAddingLead(false);
    setMobileDetailOpen(true);
  }

  function closeDetail() {
    setSelectedId(null);
    setAddingLead(false);
    setMobileDetailOpen(false);
  }

  if (!data && loadError) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state max-w-lg p-6">
          <p className="water-eyebrow">Relationships</p>
          <h1 className="water-workspace-title mt-2">Pipeline could not load.</h1>
          <p className="mt-2 text-[13.5px] text-muted-foreground">{loadError}</p>
          <button onClick={() => void load()} className="water-primary-button mt-4 px-4 py-2">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state px-6 py-5 text-sm">Loading pipeline...</div>
      </div>
    );
  }

  const closedCount = data.deals.filter((deal) => CLOSED_STAGES.has(deal.stage)).length;

  return (
    <div className={`water-workspace people-surface flex h-full overflow-hidden ${
      mobileDetailOpen ? 'is-detail-open' : ''
    }`}>
      <section className="people-list-pane water-list-panel flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="water-toolbar flex flex-wrap items-center gap-3 border-b px-5 pb-4 pt-[64px]">
          <div className="flex shrink-0 items-end gap-3">
            <div>
              <p className="water-eyebrow">Relationships</p>
              <h1 className="water-workspace-title mt-1">Pipeline</h1>
            </div>
            <CrmSubNav />
          </div>
          <div className="relative min-w-[170px] max-w-[260px] flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              ⌕
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or company"
              className="water-control w-full py-2 pl-8 pr-3"
            />
          </div>
          <button
            onClick={() => {
              setAddingLead(true);
              setSelectedId(null);
              setMobileDetailOpen(true);
            }}
            className="water-primary-button ml-auto shrink-0 px-4 py-2"
          >
            + Add lead
          </button>
        </div>

        {loadError && (
          <div className="border-b bg-accent-red/5 px-5 py-2 text-[12px] text-accent-red">
            Refresh failed: {loadError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[
              ['Client MRR', formatMoney(data.summary.mrr)],
              ['Open leads', data.summary.openCount.toLocaleString('en-US')],
              ['Overdue', data.summary.overdueCount.toLocaleString('en-US')],
              ['Due in 7 days', data.summary.dueSoonCount.toLocaleString('en-US')],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[14px] border border-[#e5e0d9] bg-[#fffdfa] px-4 py-3 dark:border-[#3b3834] dark:bg-[#22211f]">
                <p className="water-eyebrow">{label}</p>
                <p className="mt-1 text-[22px] font-[650] tracking-[-0.02em] tabular-nums">{value}</p>
              </div>
            ))}
          </div>

          <section className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="water-eyebrow">Needs attention</h2>
              {data.attention.length > 0 && (
                <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
                  {data.attention.length}
                </span>
              )}
            </div>
            {data.attention.length === 0 ? (
              <div className="water-empty-state px-4 py-3 text-[12.5px]">
                Nothing overdue and every open lead has a next step.
              </div>
            ) : (
              <div className="overflow-hidden rounded-[14px] border border-[#e5e0d9] bg-[#fffdfa] dark:border-[#3b3834] dark:bg-[#22211f]">
                {data.attention.map((item, index) => (
                  <button
                    key={item.deal.contact_id}
                    onClick={() => openDeal(item.deal.contact_id)}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[#f7f4ef] dark:hover:bg-[#282622] ${
                      index > 0 ? 'border-t border-[#e5e0d9] dark:border-[#3b3834]' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{item.deal.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">{item.deal.company || 'No company'}</span>
                    </span>
                    <span className={item.reason === 'overdue' ? 'text-[12px] text-accent-red' : 'text-[12px] text-muted-foreground'}>
                      {attentionReason(item)}
                    </span>
                    <span className="water-pill shrink-0 px-2 py-1">{PIPELINE_STAGE_LABELS[item.deal.stage]}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="mt-7 space-y-6">
            {data.stages.filter((stage) => !CLOSED_STAGES.has(stage.id)).map((stage) => (
              <StageGroup
                key={stage.id}
                stage={stage}
                deals={visibleDeals.filter((deal) => deal.stage === stage.id)}
                today={data.today}
                selectedId={selectedId}
                stages={data.stages}
                stageErrors={stageErrors}
                onOpen={openDeal}
                onMove={changeStage}
              />
            ))}
          </div>

          <div className="mt-7 border-t border-[#e5e0d9] pt-4 dark:border-[#3b3834]">
            <button
              onClick={() => setShowClosed((current) => !current)}
              className="water-text-button flex items-center gap-2 px-0 py-1.5"
              aria-expanded={showClosed}
            >
              <span aria-hidden="true">{showClosed ? '▾' : '▸'}</span>
              Lost and parked ({closedCount})
            </button>
            {showClosed && (
              <div className="mt-4 space-y-6">
                {data.stages.filter((stage) => CLOSED_STAGES.has(stage.id)).map((stage) => (
                  <StageGroup
                    key={stage.id}
                    stage={stage}
                    deals={visibleDeals.filter((deal) => deal.stage === stage.id)}
                    today={data.today}
                    selectedId={selectedId}
                    stages={data.stages}
                    stageErrors={stageErrors}
                    onOpen={openDeal}
                    onMove={changeStage}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <aside className="people-detail-pane water-detail-shell w-[400px] shrink-0 overflow-y-auto max-lg:w-[340px]">
        {addingLead ? (
          <AddLeadPanel
            stages={data.stages}
            pipelineContactIds={new Set(data.deals.map((deal) => deal.contact_id))}
            onClose={closeDetail}
            onCreated={(deal) => {
              recordWrite(deal);
              setAddingLead(false);
              setSelectedId(deal.contact_id);
            }}
          />
        ) : selectedDeal ? (
          <DealDetailPanel
            key={selectedDeal.contact_id}
            deal={selectedDeal}
            stages={data.stages}
            onClose={closeDetail}
            onMove={changeStage}
            onWritten={recordWrite}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <p className="max-w-[240px] text-sm text-muted-foreground">
              Select a lead to update the next move and see relationship history.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function StageGroup({
  stage,
  deals,
  today,
  selectedId,
  stages,
  stageErrors,
  onOpen,
  onMove,
}: {
  stage: { id: PipelineStage; label: string };
  deals: PipelineDealWithContact[];
  today: string;
  selectedId: string | null;
  stages: Array<{ id: PipelineStage; label: string }>;
  stageErrors: Record<string, string>;
  onOpen: (contactId: string) => void;
  onMove: (contactId: string, stage: PipelineStage) => Promise<void>;
}) {
  const clientMrr = stage.id === 'client'
    ? deals.reduce((total, deal) => total + (deal.monthly_value ?? 0), 0)
    : 0;
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="water-eyebrow">{stage.label}</h2>
        <span className="water-pill px-2 py-0.5 tabular-nums">{deals.length}</span>
        {stage.id === 'client' && (
          <span className="text-[11.5px] font-medium text-muted-foreground">
            {formatMoney(clientMrr)}/mo
          </span>
        )}
      </div>
      {deals.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-[#d8d2ca] px-4 py-3 text-[12px] text-muted-foreground dark:border-[#3b3834]">
          No leads in this stage.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border border-[#e5e0d9] bg-[#fffdfa] dark:border-[#3b3834] dark:bg-[#22211f]">
          {deals.map((deal, index) => {
            const status = followUpStatus(deal, today);
            const value = dealValue(deal);
            return (
              <div
                key={deal.contact_id}
                className={`water-list-row flex flex-wrap items-center gap-3 px-4 py-3 ${
                  index > 0 ? 'border-t' : ''
                } ${selectedId === deal.contact_id ? 'is-active' : ''}`}
              >
                <button onClick={() => onOpen(deal.contact_id)} className="min-w-[150px] flex-1 text-left">
                  <span className="block truncate text-[13.5px] font-medium">{deal.name}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">{deal.company || 'No company'}</span>
                </button>
                {value && <span className="water-pill shrink-0 px-2 py-1 tabular-nums">{value}</span>}
                <button onClick={() => onOpen(deal.contact_id)} className="min-w-[170px] flex-[1.25] text-left">
                  <span className={`block truncate text-[12.5px] ${deal.next_action ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {deal.next_action || 'No next action'}
                  </span>
                  <span className={`block text-[11.5px] ${status === 'overdue' ? 'font-medium text-accent-red' : 'text-muted-foreground'}`}>
                    {relativeFollowUp(deal.next_follow_up_at, today)}
                  </span>
                </button>
                <select
                  aria-label={`Stage for ${deal.name}`}
                  value={deal.stage}
                  onChange={(event) => void onMove(deal.contact_id, event.target.value as PipelineStage)}
                  className="water-control max-w-[150px] shrink-0 px-2 py-1.5 text-[12px]"
                >
                  {stages.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                {stageErrors[deal.contact_id] && (
                  <p className="w-full text-right text-[11.5px] text-accent-red">{stageErrors[deal.contact_id]}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

type EditableDealField = keyof PipelineDealPatch;

function DealDetailPanel({
  deal,
  stages,
  onClose,
  onMove,
  onWritten,
}: {
  deal: PipelineDealWithContact;
  stages: Array<{ id: PipelineStage; label: string }>;
  onClose: () => void;
  onMove: (contactId: string, stage: PipelineStage) => Promise<void>;
  onWritten: (deal: PipelineDealWithContact) => void;
}) {
  const [monthlyValue, setMonthlyValue] = useState(deal.monthly_value?.toString() ?? '');
  const [discoveryPrice, setDiscoveryPrice] = useState(deal.discovery_price?.toString() ?? '');
  const [nextAction, setNextAction] = useState(deal.next_action);
  const [nextFollowUpAt, setNextFollowUpAt] = useState(deal.next_follow_up_at ?? '');
  const [source, setSource] = useState(deal.source);
  const [notes, setNotes] = useState(deal.notes);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = useState<string>();
  const saveTimer = useRef<number | undefined>(undefined);
  const reconcileTimers = useRef<Set<number>>(new Set());
  const requestId = useRef(0);
  const lastStoredDrafts = useRef({
    monthlyValue: deal.monthly_value?.toString() ?? '',
    discoveryPrice: deal.discovery_price?.toString() ?? '',
    nextAction: deal.next_action,
    nextFollowUpAt: deal.next_follow_up_at ?? '',
    source: deal.source,
    notes: deal.notes,
  });

  useEffect(() => {
    const previous = lastStoredDrafts.current;
    const current = {
      monthlyValue: deal.monthly_value?.toString() ?? '',
      discoveryPrice: deal.discovery_price?.toString() ?? '',
      nextAction: deal.next_action,
      nextFollowUpAt: deal.next_follow_up_at ?? '',
      source: deal.source,
      notes: deal.notes,
    };
    lastStoredDrafts.current = current;
    const changed = Object.keys(current).some((key) =>
      current[key as keyof typeof current] !== previous[key as keyof typeof previous]
    );
    if (!changed) return;
    const timer = window.setTimeout(() => {
      reconcileTimers.current.delete(timer);
      if (current.monthlyValue !== previous.monthlyValue) {
        setMonthlyValue((draft) => draft === previous.monthlyValue ? current.monthlyValue : draft);
      }
      if (current.discoveryPrice !== previous.discoveryPrice) {
        setDiscoveryPrice((draft) =>
          draft === previous.discoveryPrice ? current.discoveryPrice : draft
        );
      }
      if (current.nextAction !== previous.nextAction) {
        setNextAction((draft) => draft === previous.nextAction ? current.nextAction : draft);
      }
      if (current.nextFollowUpAt !== previous.nextFollowUpAt) {
        setNextFollowUpAt((draft) =>
          draft === previous.nextFollowUpAt ? current.nextFollowUpAt : draft
        );
      }
      if (current.source !== previous.source) {
        setSource((draft) => draft === previous.source ? current.source : draft);
      }
      if (current.notes !== previous.notes) {
        setNotes((draft) => draft === previous.notes ? current.notes : draft);
      }
    }, 0);
    reconcileTimers.current.add(timer);
  }, [
    deal.discovery_price,
    deal.monthly_value,
    deal.next_action,
    deal.next_follow_up_at,
    deal.notes,
    deal.source,
  ]);

  useEffect(() => () => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    for (const timer of reconcileTimers.current) window.clearTimeout(timer);
    reconcileTimers.current.clear();
  }, []);

  async function saveField(field: EditableDealField, value: PipelineDealPatch[EditableDealField]) {
    const id = ++requestId.current;
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    setSaveStatus('saving');
    setSaveError(undefined);
    try {
      const saved = await upsertDeal({ contactId: deal.contact_id, patch: { [field]: value } });
      if (id !== requestId.current) return;
      onWritten(saved);
      setSaveStatus('saved');
      saveTimer.current = window.setTimeout(() => setSaveStatus('idle'), 3_000);
    } catch (error) {
      if (id !== requestId.current) return;
      setSaveStatus('idle');
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }

  function commitAmount(field: 'monthlyValue' | 'discoveryPrice', value: string, current: number | null) {
    const trimmed = value.trim();
    if (!trimmed && current === null) return;
    const parsed = trimmed ? Number(trimmed) : null;
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      setSaveError('Dollar values must be whole numbers of zero or more.');
      return;
    }
    if (parsed === current) return;
    void saveField(field, parsed);
  }

  function commitText(field: 'nextAction' | 'source' | 'notes', value: string, current: string) {
    if (value === current) return;
    void saveField(field, value);
  }

  return (
    <div className="water-detail-panel flex flex-col">
      <div className="water-detail-heading border-b px-5 pb-4 pt-[64px]">
        <button type="button" onClick={onClose} className="people-mobile-back water-text-button mb-3 items-center gap-1 px-0 py-1">
          <span aria-hidden="true">←</span> Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[21px]">{deal.name}</h2>
              <span role="status" aria-live="polite" className="text-[11.5px] text-muted-foreground">
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : ''}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{deal.company || 'No company'}</p>
            <div className="mt-2 flex flex-col gap-0.5 text-[12px]">
              {deal.email && <a className="text-accent-blue hover:underline" href={`mailto:${deal.email}`}>{deal.email}</a>}
              {deal.phone && <a className="text-accent-blue hover:underline" href={`tel:${deal.phone}`}>{deal.phone}</a>}
            </div>
            <select
              value={deal.stage}
              onChange={(event) => void onMove(deal.contact_id, event.target.value as PipelineStage)}
              className="mt-3 w-full px-2.5 py-2"
              aria-label={`Stage for ${deal.name}`}
            >
              {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
            </select>
          </div>
          <button onClick={onClose} className="water-secondary-button flex h-8 w-8 shrink-0 items-center justify-center text-lg" aria-label="Close details">
            &times;
          </button>
        </div>
      </div>

      {saveError && <div className="border-b bg-accent-red/5 px-5 py-2 text-[12px] text-accent-red">{saveError}</div>}

      <div className="space-y-4 px-5 py-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block">Monthly value</label>
            <input type="number" min="0" step="1" value={monthlyValue} onChange={(event) => setMonthlyValue(event.target.value)} onBlur={() => commitAmount('monthlyValue', monthlyValue, deal.monthly_value)} className="w-full px-2.5 py-2" placeholder="0" />
          </div>
          <div>
            <label className="mb-1.5 block">Discovery price</label>
            <input type="number" min="0" step="1" value={discoveryPrice} onChange={(event) => setDiscoveryPrice(event.target.value)} onBlur={() => commitAmount('discoveryPrice', discoveryPrice, deal.discovery_price)} className="w-full px-2.5 py-2" placeholder="0" />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block">Next action</label>
          <textarea value={nextAction} onChange={(event) => setNextAction(event.target.value)} onBlur={() => commitText('nextAction', nextAction, deal.next_action)} rows={2} maxLength={500} className="w-full resize-y px-2.5 py-2" placeholder="What moves this forward?" />
        </div>
        <div>
          <label className="mb-1.5 block">Follow-up date</label>
          <input type="date" value={nextFollowUpAt} onChange={(event) => setNextFollowUpAt(event.target.value)} onBlur={() => {
            const value = nextFollowUpAt || null;
            if (value !== deal.next_follow_up_at) void saveField('nextFollowUpAt', value);
          }} className="w-full px-2.5 py-2" />
        </div>
        <div>
          <label className="mb-1.5 block">Source</label>
          <input value={source} onChange={(event) => setSource(event.target.value)} onBlur={() => commitText('source', source, deal.source)} maxLength={200} className="w-full px-2.5 py-2" placeholder="Who referred them or where they came from" />
        </div>
        <div>
          <label className="mb-1.5 block">Notes</label>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} onBlur={() => commitText('notes', notes, deal.notes)} rows={5} maxLength={5000} className="w-full resize-y px-2.5 py-2" placeholder="Deal context and useful details" />
        </div>
      </div>

      <TouchAndTimeline
        deal={deal}
        stages={stages}
        nextAction={nextAction}
        nextFollowUpAt={nextFollowUpAt}
        onNextActionChange={setNextAction}
        onNextFollowUpAtChange={setNextFollowUpAt}
        onWritten={onWritten}
      />
    </div>
  );
}

function TouchAndTimeline({
  deal,
  stages,
  nextAction,
  nextFollowUpAt,
  onNextActionChange,
  onNextFollowUpAtChange,
  onWritten,
}: {
  deal: PipelineDealWithContact;
  stages: Array<{ id: PipelineStage; label: string }>;
  nextAction: string;
  nextFollowUpAt: string;
  onNextActionChange: (value: string) => void;
  onNextFollowUpAtChange: (value: string) => void;
  onWritten: (deal: PipelineDealWithContact) => void;
}) {
  const [activities, setActivities] = useState<ContactActivity[] | null>(null);
  const [activityType, setActivityType] = useState<LogPipelineTouchInput['activityType']>('call');
  const [whatHappened, setWhatHappened] = useState('');
  const [newStage, setNewStage] = useState<PipelineStage | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const loadActivities = useCallback(async () => {
    try {
      setActivities(await listContactActivities(deal.contact_id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [deal.contact_id]);

  useDataChanged(['contact_activities'], () => void loadActivities());

  useEffect(() => {
    void loadActivities();
  }, [loadActivities]);

  async function submit() {
    const happened = whatHappened.trim();
    if (!happened) {
      setError('Say what happened.');
      return;
    }
    const targetStage = newStage || deal.stage;
    if (isOpenPipelineStage(targetStage) && (!nextAction.trim() || !nextFollowUpAt)) {
      setError('Every open lead needs a next action and follow-up date.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const typeLabel = TOUCH_TYPES.find((type) => type.id === activityType)?.label ?? 'Touch';
      const title = `${typeLabel}: ${happened.split('\n')[0].slice(0, 420)}`;
      const saved = await logDealTouch(deal.contact_id, {
        activityType,
        title,
        content: happened,
        ...(nextAction !== deal.next_action ? { nextAction } : {}),
        ...(nextFollowUpAt !== (deal.next_follow_up_at ?? '')
          ? { nextFollowUpAt: nextFollowUpAt || null }
          : {}),
        ...(newStage ? { stage: newStage } : {}),
      });
      onWritten(saved);
      onNextActionChange(saved.next_action);
      onNextFollowUpAtChange(saved.next_follow_up_at ?? '');
      setWhatHappened('');
      setNewStage('');
      emitDataChanged(['contacts']);
      await loadActivities();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-[#e5e0d9] px-5 py-4 dark:border-[#3b3834]">
      <h3 className="water-eyebrow mb-2">Log a touch</h3>
      <div className="water-activity-card space-y-2 border p-3">
        <select aria-label="Touch type" value={activityType} onChange={(event) => setActivityType(event.target.value as LogPipelineTouchInput['activityType'])} className="w-full px-2.5 py-1.5">
          {TOUCH_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
        </select>
        <textarea aria-label="What happened" value={whatHappened} onChange={(event) => setWhatHappened(event.target.value)} rows={3} maxLength={5000} className="w-full resize-y px-2.5 py-2" placeholder="What happened?" />
        <input aria-label="Next action after this touch" value={nextAction} onChange={(event) => onNextActionChange(event.target.value)} maxLength={500} className="w-full px-2.5 py-1.5" placeholder="Next action" />
        <input aria-label="Follow-up date after this touch" type="date" value={nextFollowUpAt} onChange={(event) => onNextFollowUpAtChange(event.target.value)} className="w-full px-2.5 py-1.5" />
        <select aria-label="New stage after this touch" value={newStage} onChange={(event) => setNewStage(event.target.value as PipelineStage | '')} className="w-full px-2.5 py-1.5">
          <option value="">Keep current stage</option>
          {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
        </select>
        <div className="flex justify-end">
          <button onClick={() => void submit()} disabled={saving} className="water-primary-button px-4 py-1.5 disabled:opacity-50">
            {saving ? 'Saving...' : 'Log touch'}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-[12px] text-accent-red">{error}</p>}

      <h3 className="water-eyebrow mb-2 mt-5">Timeline</h3>
      {activities === null ? (
        <p className="py-3 text-[12px] text-muted-foreground">Loading activity...</p>
      ) : activities.length === 0 ? (
        <p className="py-3 text-[12px] text-muted-foreground">No activity logged yet.</p>
      ) : (
        <ul className="space-y-2">
          {activities.map((activity) => {
            if (activity.activity_type === 'pipeline_stage') {
              const to = activity.metadata?.to;
              const label = typeof to === 'string' && to in PIPELINE_STAGE_LABELS
                ? PIPELINE_STAGE_LABELS[to as PipelineStage]
                : activity.title?.replace(/^Moved to /, '') || 'another stage';
              const added = activity.metadata?.from === null;
              return (
                <li key={activity.id} className="px-1 py-1 text-[11.5px] text-muted-foreground">
                  {added ? `Added to pipeline: ${label}` : `Moved to ${label}`}
                  {activity.content ? `: ${activity.content}` : ''}
                  <span className="ml-2">{activityTimestamp(activity.created_at)}</span>
                </li>
              );
            }
            return (
              <li key={activity.id} className="water-activity-card border px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-medium">{activity.title || activity.activity_type}</span>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">{activityTimestamp(activity.created_at)}</span>
                </div>
                {activity.content && <p className="mt-1 whitespace-pre-wrap text-[12px] leading-[1.5] text-muted-foreground">{activity.content}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function activityTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function AddLeadPanel({
  stages,
  pipelineContactIds,
  onClose,
  onCreated,
}: {
  stages: Array<{ id: PipelineStage; label: string }>;
  pipelineContactIds: Set<string>;
  onClose: () => void;
  onCreated: (deal: PipelineDealWithContact) => void;
}) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [ambiguous, setAmbiguous] = useState<ContactCandidate[]>([]);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [stage, setStage] = useState<PipelineStage>('reach_out');
  const [monthlyValue, setMonthlyValue] = useState('');
  const [discoveryPrice, setDiscoveryPrice] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [nextFollowUpAt, setNextFollowUpAt] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!search.trim() || selected) {
      setResults([]);
      return;
    }
    const timeout = window.setTimeout(() => {
      void listContacts(search.trim()).then(setResults).catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [search, selected]);

  async function pickContact(contactId: string) {
    try {
      const contact = await getContact(contactId);
      if (!contact) throw new Error('Contact was not found.');
      setSelected(contact);
      setAmbiguous([]);
      setError(undefined);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
    }
  }

  async function resolveTypedName() {
    const name = search.trim();
    if (!name) return;
    setSaving(true);
    setError(undefined);
    try {
      const resolution = await resolveContact({ name });
      if (resolution.status === 'ambiguous') {
        setAmbiguous(resolution.candidates);
        if (resolution.candidates.length === 0) {
          setError('Enter a first and last name so Cove can add this person safely.');
        }
        return;
      }
      setSelected(resolution.contact);
      setAmbiguous([]);
      emitDataChanged(['contacts']);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : String(resolveError));
    } finally {
      setSaving(false);
    }
  }

  function amount(value: string, label: string): number | null {
    if (!value.trim()) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a whole number of zero or more.`);
    return parsed;
  }

  async function createDeal() {
    if (!selected) {
      setError('Choose or create a contact first.');
      return;
    }
    if (pipelineContactIds.has(selected.id)) {
      setError('This contact is already in the pipeline.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const deal = await upsertDeal({
        contactId: selected.id,
        stage,
        patch: {
          monthlyValue: amount(monthlyValue, 'Monthly value'),
          discoveryPrice: amount(discoveryPrice, 'Discovery price'),
          nextAction,
          nextFollowUpAt: nextFollowUpAt || null,
          source,
          notes,
        },
      });
      onCreated(deal);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="water-detail-panel flex flex-col">
      <div className="water-detail-heading border-b px-5 pb-4 pt-[64px]">
        <button type="button" onClick={onClose} className="people-mobile-back water-text-button mb-3 items-center gap-1 px-0 py-1">
          <span aria-hidden="true">←</span> Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="water-eyebrow">Pipeline</p>
            <h2 className="mt-1 text-[21px]">Add lead</h2>
          </div>
          <button onClick={onClose} className="water-secondary-button flex h-8 w-8 items-center justify-center text-lg" aria-label="Close add lead panel">&times;</button>
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        {!selected ? (
          <div>
            <label className="mb-1.5 block">Find a contact</label>
            <input type="search" value={search} onChange={(event) => {
              setSearch(event.target.value);
              setAmbiguous([]);
              setError(undefined);
            }} className="w-full px-2.5 py-2" placeholder="Name" autoFocus />
            {results.length > 0 && (
              <div className="mt-2 overflow-hidden rounded-[12px] border border-[#e5e0d9] dark:border-[#3b3834]">
                {results.slice(0, 8).map((contact) => (
                  <button key={contact.id} onClick={() => void pickContact(contact.id)} disabled={pipelineContactIds.has(contact.id)} className="flex w-full items-center justify-between border-b border-[#e5e0d9] px-3 py-2 text-left last:border-b-0 disabled:opacity-45 dark:border-[#3b3834]">
                    <span>
                      <span className="block text-[13px] font-medium">{contact.name}</span>
                      <span className="block text-[11.5px] text-muted-foreground">{contact.email || 'No email'}</span>
                    </span>
                    {pipelineContactIds.has(contact.id) && <span className="text-[10.5px] text-muted-foreground">Already in pipeline</span>}
                  </button>
                ))}
              </div>
            )}
            {search.trim() && (
              <button onClick={() => void resolveTypedName()} disabled={saving} className="water-secondary-button mt-2 w-full px-3 py-2 disabled:opacity-50">
                Add {search.trim()}
              </button>
            )}
            {ambiguous.length > 0 && (
              <div className="mt-3">
                <p className="text-[12px] text-muted-foreground">More than one person could match. Choose one:</p>
                <div className="mt-2 space-y-1">
                  {ambiguous.map((candidate) => (
                    <button key={candidate.id} onClick={() => void pickContact(candidate.id)} className="water-secondary-button w-full px-3 py-2 text-left">
                      {candidate.name}{candidate.email ? `, ${candidate.email}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-[14px] border border-[#e5e0d9] bg-[#faf8f4] px-4 py-3 dark:border-[#3b3834] dark:bg-[#25231f]">
            <p className="text-[13.5px] font-medium">{selected.name}</p>
            <p className="text-[11.5px] text-muted-foreground">{selected.email || 'No email'}</p>
            <button onClick={() => setSelected(null)} className="water-text-button mt-1 px-0 py-1">Choose someone else</button>
          </div>
        )}

        {selected && (
          <>
            <div>
              <label className="mb-1.5 block">Stage</label>
              <select value={stage} onChange={(event) => setStage(event.target.value as PipelineStage)} className="w-full px-2.5 py-2">
                {stages.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block">Monthly value</label>
                <input type="number" min="0" step="1" value={monthlyValue} onChange={(event) => setMonthlyValue(event.target.value)} className="w-full px-2.5 py-2" placeholder="0" />
              </div>
              <div>
                <label className="mb-1.5 block">Discovery price</label>
                <input type="number" min="0" step="1" value={discoveryPrice} onChange={(event) => setDiscoveryPrice(event.target.value)} className="w-full px-2.5 py-2" placeholder="0" />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block">Next action</label>
              <textarea value={nextAction} onChange={(event) => setNextAction(event.target.value)} rows={2} maxLength={500} className="w-full resize-y px-2.5 py-2" />
            </div>
            <div>
              <label className="mb-1.5 block">Follow-up date</label>
              <input type="date" value={nextFollowUpAt} onChange={(event) => setNextFollowUpAt(event.target.value)} className="w-full px-2.5 py-2" />
            </div>
            <div>
              <label className="mb-1.5 block">Source</label>
              <input value={source} onChange={(event) => setSource(event.target.value)} maxLength={200} className="w-full px-2.5 py-2" />
            </div>
            <div>
              <label className="mb-1.5 block">Notes</label>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} maxLength={5000} className="w-full resize-y px-2.5 py-2" />
            </div>
            <button onClick={() => void createDeal()} disabled={saving} className="water-primary-button w-full px-4 py-2 disabled:opacity-50">
              {saving ? 'Adding...' : 'Add to pipeline'}
            </button>
          </>
        )}

        {error && <p className="text-[12px] text-accent-red">{error}</p>}
      </div>
    </div>
  );
}
