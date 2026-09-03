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

const EYEBROW_CLASS = 'text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground';
const SECTION_TITLE_CLASS = 'text-[21px] font-semibold leading-[1.42] tracking-[-0.016em] text-foreground';
const LABEL_CLASS = 'mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground';
const FIELD_CLASS = 'w-full rounded-[12px] border bg-background text-[14px] leading-[1.55] text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-150 ease-[var(--ease-out-cove)] placeholder:text-muted-foreground/70 focus:border-muted-foreground/50 focus:ring-2 focus:ring-accent-blue/20 dark:bg-muted/35';
const STAGE_SELECT_CLASS = 'w-full rounded-[10px] border bg-background text-[12.5px] leading-[1.55] text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-150 ease-[var(--ease-out-cove)] focus:border-muted-foreground/50 focus:ring-2 focus:ring-accent-blue/20 dark:bg-muted/35';
const PRIMARY_BUTTON_CLASS = 'press-scale rounded-[13px] bg-foreground font-semibold text-background shadow-lg outline-none transition-[transform,box-shadow,opacity] duration-150 ease-[var(--ease-out-cove)] hover:-translate-y-px hover:shadow-xl focus-visible:ring-2 focus-visible:ring-accent-blue/40 active:translate-y-0 disabled:cursor-default disabled:opacity-50';
const TEXT_BUTTON_CLASS = 'press-scale text-[13px] font-medium text-muted-foreground outline-none transition-colors duration-150 ease-[var(--ease-out-cove)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40';
const CARD_CLASS = 'rounded-[14px] border bg-background transition-[transform,box-shadow,background-color,border-color] duration-150 ease-[var(--ease-out-cove)] hover:-translate-y-0.5 hover:border-muted-foreground/40 hover:bg-card hover:shadow-lg active:translate-y-0 active:shadow-sm motion-reduce:transform-none dark:bg-muted/35 dark:hover:bg-muted/70';
const EMPTY_SLOT_CLASS = 'rounded-[14px] border border-dashed bg-transparent transition-[border-color,background-color] duration-150 ease-[var(--ease-out-cove)] hover:border-muted-foreground/50';
const TRAY_CLASS = 'rounded-[20px] border-2 p-2';
const TAG_CLASS = 'inline-block rounded-full bg-muted px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground';

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
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg rounded-3xl border bg-card p-8">
          <p className={EYEBROW_CLASS}>Relationships</p>
          <h1 className="mt-2 text-[30px] font-semibold leading-[1.15] tracking-[-0.022em] text-foreground">
            Pipeline could not load.
          </h1>
          <p className="mt-3 text-[15px] leading-[1.62] text-foreground/75">{loadError}</p>
          <button onClick={() => void load()} className={`${PRIMARY_BUTTON_CLASS} mt-6 px-5 py-2.5`}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className={`${EMPTY_SLOT_CLASS} bg-card px-6 py-5 text-[13px] text-muted-foreground`}>
          Loading pipeline...
        </div>
      </div>
    );
  }

  const closedCount = data.deals.filter((deal) => CLOSED_STAGES.has(deal.stage)).length;

  return (
    <div className={`people-surface mx-auto flex h-full w-full max-w-[90rem] gap-5 overflow-hidden bg-background p-4 sm:p-6 lg:p-8 ${
      mobileDetailOpen ? 'is-detail-open' : ''
    }`}>
      <section className="people-list-pane flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl border bg-card">
        <header className="border-b bg-card px-6 pb-7 pt-8 sm:px-10 lg:px-12 lg:pt-[52px]">
          <div className="mx-auto w-full max-w-[63rem]">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div>
                <p className={`mb-2.5 ${EYEBROW_CLASS}`}>Relationships</p>
                <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.022em] text-foreground">
                  Pipeline
                </h1>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-3">
                <CrmSubNav />
                <div className="relative min-w-[210px] max-w-[260px] flex-1">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    ⌕
                  </span>
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search name or company"
                    className={`${FIELD_CLASS} py-2 pl-9 pr-3`}
                  />
                </div>
                <button
                  onClick={() => {
                    setAddingLead(true);
                    setSelectedId(null);
                    setMobileDetailOpen(true);
                  }}
                  className={`${PRIMARY_BUTTON_CLASS} shrink-0 px-5 py-2.5 text-[13px]`}
                >
                  + Add lead
                </button>
              </div>
            </div>
          </div>
        </header>

        {loadError && (
          <div className="border-b bg-accent-red/5 px-5 py-2 text-[12px] text-accent-red">
            Refresh failed: {loadError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-8 sm:px-10 lg:px-12">
          <div className="mx-auto w-full max-w-[63rem]">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[
                ['Client MRR', formatMoney(data.summary.mrr)],
                ['Open leads', data.summary.openCount.toLocaleString('en-US')],
                ['Overdue', data.summary.overdueCount.toLocaleString('en-US')],
                ['Due in 7 days', data.summary.dueSoonCount.toLocaleString('en-US')],
              ].map(([label, value]) => (
                <div key={label} className="rounded-[14px] border bg-background px-[18px] py-4 dark:bg-muted/35">
                  <p className={EYEBROW_CLASS}>{label}</p>
                  <p className="mt-2 text-[22px] font-semibold tracking-[-0.02em] text-foreground tabular-nums">{value}</p>
                </div>
              ))}
            </div>

            <section className="mt-10">
              <div className="mb-4 flex items-center gap-3">
                <h2 className={EYEBROW_CLASS}>Needs attention</h2>
                <span className={`${TAG_CLASS} tabular-nums`}>
                  {data.attention.length}
                </span>
              </div>
              {data.attention.length === 0 ? (
                <div className={`${EMPTY_SLOT_CLASS} px-[18px] py-5 text-[13px] leading-relaxed text-muted-foreground`}>
                  Nothing overdue and every open lead has a next step.
                </div>
              ) : (
                <div className={TRAY_CLASS}>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                    {data.attention.map((item, index) => (
                      <button
                        key={item.deal.contact_id}
                        onClick={() => openDeal(item.deal.contact_id)}
                        className="press-scale flex min-h-[134px] w-full flex-col rounded-[20px] border border-white/10 bg-[linear-gradient(160deg,#33302b_0%,#2a2724_70%)] px-[22px] pb-[18px] pt-5 text-left shadow-lg outline-none transition-[transform,box-shadow] duration-150 ease-[var(--ease-out-cove)] hover:-translate-y-0.5 hover:shadow-2xl focus-visible:ring-2 focus-visible:ring-accent-blue/70 active:translate-y-0 active:shadow-md motion-reduce:transform-none dark:border-white/15 dark:bg-[linear-gradient(160deg,#262320_0%,#1d1b19_70%)]"
                      >
                        <span className="mb-3.5 grid size-6 place-items-center rounded-full bg-white/10 text-xs font-semibold text-white/70">
                          {index + 1}
                        </span>
                        <span className="line-clamp-2 text-[15.5px] font-medium leading-[1.42] tracking-[-0.004em] text-white/95">
                          {item.deal.name}
                        </span>
                        <span className="mt-auto truncate pt-3.5 text-xs leading-[1.4] text-white/60">
                          {attentionReason(item)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <div className="mt-12 space-y-10">
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

            <div className="mt-12 border-t pt-6">
              <button
                onClick={() => setShowClosed((current) => !current)}
                className={`${TEXT_BUTTON_CLASS} flex items-center gap-2 px-0 py-1.5`}
                aria-expanded={showClosed}
              >
                <span aria-hidden="true">{showClosed ? '▾' : '▸'}</span>
                Lost and parked ({closedCount})
              </button>
              {showClosed && (
                <div className="day-ritual-swap-in mt-6 space-y-10">
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
        </div>
      </section>

      <aside className="people-detail-pane w-[400px] shrink-0 overflow-y-auto rounded-3xl border bg-card max-lg:w-[340px]">
        <div
          key={addingLead ? 'add-lead' : selectedDeal ? `deal:${selectedDeal.contact_id}` : 'empty'}
          className="day-ritual-swap-in min-h-full"
        >
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
            <div className="flex min-h-full items-center justify-center p-6 text-center">
              <p className={`${EMPTY_SLOT_CLASS} max-w-[270px] px-6 py-8 text-[13px] leading-relaxed text-muted-foreground`}>
                Select a lead to update the next move and see relationship history.
              </p>
            </div>
          )}
        </div>
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
      <div className="mb-4 flex items-center gap-3">
        <h2 className={EYEBROW_CLASS}>{stage.label}</h2>
        <span className={`${TAG_CLASS} tabular-nums`}>
          {deals.length}
        </span>
        {stage.id === 'client' && (
          <span className="text-[12px] font-medium text-muted-foreground">
            {formatMoney(clientMrr)}/mo
          </span>
        )}
      </div>
      <div className={TRAY_CLASS}>
        {deals.length === 0 ? (
          <div className={`${EMPTY_SLOT_CLASS} px-[18px] py-5 text-[13px] text-muted-foreground`}>
            No leads in this stage.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
            {deals.map((deal) => {
              const status = followUpStatus(deal, today);
              const value = dealValue(deal);
              const followUpLabel = relativeFollowUp(deal.next_follow_up_at, today);
              return (
                <div
                  key={deal.contact_id}
                  className={`${CARD_CLASS} flex min-h-[168px] flex-col items-stretch px-[18px] py-4 ${
                    selectedId === deal.contact_id ? 'border-muted-foreground/50 bg-card shadow-md' : ''
                  }`}
                >
                  <button onClick={() => onOpen(deal.contact_id)} className="press-scale flex flex-1 flex-col items-start rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40">
                    <span className={`${TAG_CLASS} ${status === 'overdue' ? 'bg-accent-red/10 text-accent-red' : ''}`}>
                      {followUpLabel}
                    </span>
                    <span className="mt-3 block truncate text-[14px] font-medium leading-[1.4] tracking-[-0.004em] text-foreground/85 dark:text-foreground/90">
                      {deal.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                      {deal.company || 'No company'}
                    </span>
                    <span className="mt-3 block w-full truncate text-[12.5px] leading-relaxed text-muted-foreground">
                      {deal.next_action || 'No next action'}
                    </span>
                  </button>
                  <div className="mt-4 flex items-center gap-3">
                    <select
                      aria-label={`Stage for ${deal.name}`}
                      value={deal.stage}
                      onChange={(event) => void onMove(deal.contact_id, event.target.value as PipelineStage)}
                      className={`${STAGE_SELECT_CLASS} min-w-0 flex-1 px-3 py-2`}
                    >
                      {stages.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                    {value && (
                      <span className="shrink-0 text-[11px] font-medium text-muted-foreground tabular-nums">
                        {value}
                      </span>
                    )}
                  </div>
                  {stageErrors[deal.contact_id] && (
                    <p className="mt-2 text-right text-[11.5px] text-accent-red">{stageErrors[deal.contact_id]}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
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
    <div className="flex min-h-full flex-col">
      <div className="border-b bg-card px-7 pb-7 pt-8 lg:pt-[52px]">
        <button type="button" onClick={onClose} className={`people-mobile-back ${TEXT_BUTTON_CLASS} mb-4 items-center gap-1 px-0 py-1`}>
          <span aria-hidden="true">←</span> Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className={`truncate ${SECTION_TITLE_CLASS}`}>{deal.name}</h2>
              <span role="status" aria-live="polite" className="text-[11.5px] text-muted-foreground">
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : ''}
              </span>
            </div>
            <p className="mt-1 truncate text-[13px] text-muted-foreground">{deal.company || 'No company'}</p>
            <div className="mt-3 flex flex-col gap-1 text-[12px]">
              {deal.email && <a className="press-scale text-accent-blue hover:underline" href={`mailto:${deal.email}`}>{deal.email}</a>}
              {deal.phone && <a className="press-scale text-accent-blue hover:underline" href={`tel:${deal.phone}`}>{deal.phone}</a>}
            </div>
            <select
              value={deal.stage}
              onChange={(event) => void onMove(deal.contact_id, event.target.value as PipelineStage)}
              className={`${FIELD_CLASS} mt-4 px-3 py-2`}
              aria-label={`Stage for ${deal.name}`}
            >
              {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
            </select>
          </div>
          <button onClick={onClose} className="press-scale flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40" aria-label="Close details">
            &times;
          </button>
        </div>
      </div>

      {saveError && <div className="border-b bg-accent-red/5 px-5 py-2 text-[12px] text-accent-red">{saveError}</div>}

      <div className="space-y-5 p-7">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={LABEL_CLASS}>Monthly value</label>
            <input type="number" min="0" step="1" value={monthlyValue} onChange={(event) => setMonthlyValue(event.target.value)} onBlur={() => commitAmount('monthlyValue', monthlyValue, deal.monthly_value)} className={`${FIELD_CLASS} px-3 py-2`} placeholder="0" />
          </div>
          <div>
            <label className={LABEL_CLASS}>Discovery price</label>
            <input type="number" min="0" step="1" value={discoveryPrice} onChange={(event) => setDiscoveryPrice(event.target.value)} onBlur={() => commitAmount('discoveryPrice', discoveryPrice, deal.discovery_price)} className={`${FIELD_CLASS} px-3 py-2`} placeholder="0" />
          </div>
        </div>
        <div>
          <label className={LABEL_CLASS}>Next action</label>
          <textarea value={nextAction} onChange={(event) => setNextAction(event.target.value)} onBlur={() => commitText('nextAction', nextAction, deal.next_action)} rows={2} maxLength={500} className={`${FIELD_CLASS} resize-y px-3 py-2`} placeholder="What moves this forward?" />
        </div>
        <div>
          <label className={LABEL_CLASS}>Follow-up date</label>
          <input type="date" value={nextFollowUpAt} onChange={(event) => setNextFollowUpAt(event.target.value)} onBlur={() => {
            const value = nextFollowUpAt || null;
            if (value !== deal.next_follow_up_at) void saveField('nextFollowUpAt', value);
          }} className={`${FIELD_CLASS} px-3 py-2`} />
        </div>
        <div>
          <label className={LABEL_CLASS}>Source</label>
          <input value={source} onChange={(event) => setSource(event.target.value)} onBlur={() => commitText('source', source, deal.source)} maxLength={200} className={`${FIELD_CLASS} px-3 py-2`} placeholder="Who referred them or where they came from" />
        </div>
        <div>
          <label className={LABEL_CLASS}>Notes</label>
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} onBlur={() => commitText('notes', notes, deal.notes)} rows={5} maxLength={5000} className={`${FIELD_CLASS} resize-y px-3 py-2`} placeholder="Deal context and useful details" />
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
    <div className="border-t p-7">
      <h3 className={EYEBROW_CLASS}>Log a touch</h3>
      <div className="mt-4 space-y-3 rounded-[14px] border bg-background p-4 dark:bg-muted/35">
        <select aria-label="Touch type" value={activityType} onChange={(event) => setActivityType(event.target.value as LogPipelineTouchInput['activityType'])} className={`${FIELD_CLASS} px-3 py-2`}>
          {TOUCH_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
        </select>
        <textarea aria-label="What happened" value={whatHappened} onChange={(event) => setWhatHappened(event.target.value)} rows={3} maxLength={5000} className={`${FIELD_CLASS} resize-y px-3 py-2`} placeholder="What happened?" />
        <input aria-label="Next action after this touch" value={nextAction} onChange={(event) => onNextActionChange(event.target.value)} maxLength={500} className={`${FIELD_CLASS} px-3 py-2`} placeholder="Next action" />
        <input aria-label="Follow-up date after this touch" type="date" value={nextFollowUpAt} onChange={(event) => onNextFollowUpAtChange(event.target.value)} className={`${FIELD_CLASS} px-3 py-2`} />
        <select aria-label="New stage after this touch" value={newStage} onChange={(event) => setNewStage(event.target.value as PipelineStage | '')} className={`${FIELD_CLASS} px-3 py-2`}>
          <option value="">Keep current stage</option>
          {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
        </select>
        <div className="flex justify-end">
          <button onClick={() => void submit()} disabled={saving} className={`${PRIMARY_BUTTON_CLASS} px-5 py-2.5 text-[13px]`}>
            {saving ? 'Saving...' : 'Log touch'}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-[12px] text-accent-red">{error}</p>}

      <h3 className={`${EYEBROW_CLASS} mb-4 mt-8`}>Timeline</h3>
      {activities === null ? (
        <p className={`${EMPTY_SLOT_CLASS} px-4 py-5 text-[12px] text-muted-foreground`}>Loading activity...</p>
      ) : activities.length === 0 ? (
        <p className={`${EMPTY_SLOT_CLASS} px-4 py-5 text-[12px] text-muted-foreground`}>No activity logged yet.</p>
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
              <li key={activity.id} className="rounded-[14px] border bg-background px-4 py-3 dark:bg-muted/35">
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
    <div className="flex min-h-full flex-col">
      <div className="border-b bg-card px-7 pb-7 pt-8 lg:pt-[52px]">
        <button type="button" onClick={onClose} className={`people-mobile-back ${TEXT_BUTTON_CLASS} mb-4 items-center gap-1 px-0 py-1`}>
          <span aria-hidden="true">←</span> Back
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className={EYEBROW_CLASS}>Pipeline</p>
            <h2 className="mt-2 text-[18px] font-semibold leading-[1.42] tracking-[-0.016em] text-foreground">Add lead</h2>
          </div>
          <button onClick={onClose} className="press-scale flex size-8 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40" aria-label="Close add lead panel">&times;</button>
        </div>
      </div>

      <div className="space-y-5 p-7">
        {!selected ? (
          <div>
            <label className={LABEL_CLASS}>Find a contact</label>
            <input type="search" value={search} onChange={(event) => {
              setSearch(event.target.value);
              setAmbiguous([]);
              setError(undefined);
            }} className={`${FIELD_CLASS} px-3 py-2`} placeholder="Name" autoFocus />
            {results.length > 0 && (
              <div className="mt-3 space-y-2">
                {results.slice(0, 8).map((contact) => (
                  <button key={contact.id} onClick={() => void pickContact(contact.id)} disabled={pipelineContactIds.has(contact.id)} className={`press-scale ${CARD_CLASS} flex w-full items-center justify-between px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-45`}>
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
              <button onClick={() => void resolveTypedName()} disabled={saving} className={`${TEXT_BUTTON_CLASS} mt-3 px-0 py-2 disabled:opacity-50`}>
                Add {search.trim()}
              </button>
            )}
            {ambiguous.length > 0 && (
              <div className="mt-3">
                <p className="text-[12px] text-muted-foreground">More than one person could match. Choose one:</p>
                <div className="mt-3 space-y-2">
                  {ambiguous.map((candidate) => (
                    <button key={candidate.id} onClick={() => void pickContact(candidate.id)} className={`press-scale ${CARD_CLASS} w-full px-4 py-3 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40`}>
                      {candidate.name}{candidate.email ? `, ${candidate.email}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-[14px] border bg-background px-4 py-3 dark:bg-muted/35">
            <p className="text-[13.5px] font-medium">{selected.name}</p>
            <p className="text-[11.5px] text-muted-foreground">{selected.email || 'No email'}</p>
            <button onClick={() => setSelected(null)} className={`${TEXT_BUTTON_CLASS} mt-2 px-0 py-1`}>Choose someone else</button>
          </div>
        )}

        {selected && (
          <>
            <div>
              <label className={LABEL_CLASS}>Stage</label>
              <select value={stage} onChange={(event) => setStage(event.target.value as PipelineStage)} className={`${FIELD_CLASS} px-3 py-2`}>
                {stages.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={LABEL_CLASS}>Monthly value</label>
                <input type="number" min="0" step="1" value={monthlyValue} onChange={(event) => setMonthlyValue(event.target.value)} className={`${FIELD_CLASS} px-3 py-2`} placeholder="0" />
              </div>
              <div>
                <label className={LABEL_CLASS}>Discovery price</label>
                <input type="number" min="0" step="1" value={discoveryPrice} onChange={(event) => setDiscoveryPrice(event.target.value)} className={`${FIELD_CLASS} px-3 py-2`} placeholder="0" />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Next action</label>
              <textarea value={nextAction} onChange={(event) => setNextAction(event.target.value)} rows={2} maxLength={500} className={`${FIELD_CLASS} resize-y px-3 py-2`} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Follow-up date</label>
              <input type="date" value={nextFollowUpAt} onChange={(event) => setNextFollowUpAt(event.target.value)} className={`${FIELD_CLASS} px-3 py-2`} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Source</label>
              <input value={source} onChange={(event) => setSource(event.target.value)} maxLength={200} className={`${FIELD_CLASS} px-3 py-2`} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Notes</label>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} maxLength={5000} className={`${FIELD_CLASS} resize-y px-3 py-2`} />
            </div>
            <button onClick={() => void createDeal()} disabled={saving} className={`${PRIMARY_BUTTON_CLASS} w-full px-5 py-2.5 text-[13px]`}>
              {saving ? 'Adding...' : 'Add to pipeline'}
            </button>
          </>
        )}

        {error && <p className="text-[12px] text-accent-red">{error}</p>}
      </div>
    </div>
  );
}
