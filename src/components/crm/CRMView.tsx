'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { getRuntimeMode } from '@/lib/runtime/mode';
import {
  listAttioCRMRecords,
  type AttioCRMRecord,
  type AttioObjectType,
} from '@/lib/data/attio-crm';
import AttioRecordDetail from './AttioRecordDetail';
import ContactList from './ContactList';
import ContactDetail from './ContactDetail';
import ImportModal from './ImportModal';
import LocalCRMView from './LocalCRMView';

export default function CRMView() {
  const mode = getRuntimeMode();
  if (mode === 'supabase') return <AttioCRMView />;
  if (mode === 'local') return <LocalCRMView />;
  return <ConvexCRMView />;
}

function ConvexCRMView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', email: '', company: '' });
  const [addError, setAddError] = useState('');

  const [search, setSearch] = useState('');
  const [tier, setTier] = useState('');
  const [sort, setSort] = useState('name');

  const contacts = useQuery(api.contacts.list, {
    search: search || undefined,
    tier: tier || undefined,
    sort,
  }) ?? [];

  const createContact = useMutation(api.contacts.create);

  async function handleAddContact() {
    if (!newContact.name.trim()) {
      setAddError('Name is required.');
      return;
    }

    const id = await createContact({
      name: newContact.name.trim(),
      email: newContact.email || undefined,
      company: newContact.company || undefined,
    });
    setNewContact({ name: '', email: '', company: '' });
    setAddError('');
    setShowAddForm(false);
    setSelectedId(id);
  }

  function handleContactDeleted() {
    setSelectedId(null);
  }

  return (
    <div className="water-workspace people-surface flex h-full flex-col">
      {/* Header bar */}
      <div className="water-toolbar flex flex-wrap items-center gap-2 border-b px-5 py-2.5 sm:gap-3">
        <div className="flex items-baseline gap-2 shrink-0">
          <h1 className="water-workspace-title text-sm">People</h1>
          <span className="text-xs text-muted-foreground tabular-nums">
            {contacts.length} {contacts.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>

        <div className="relative min-w-[180px] max-w-[260px] flex-1">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="water-control w-full py-1.5 pl-8 pr-3 text-xs placeholder:text-muted-foreground"
          />
        </div>

        <select
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className="water-control px-3 py-1.5 text-xs"
        >
          <option value="">All groups</option>
          <option value="A">Tier A</option>
          <option value="B">Tier B</option>
          <option value="C">Tier C</option>
        </select>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowImport(true)}
            className="water-secondary-button px-3 py-1.5"
          >
            Import
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="water-primary-button px-4 py-1.5"
          >
            + Add
          </button>
        </div>
      </div>

      {/* Quick add form */}
      {showAddForm && (
        <div className="water-form-panel mx-5 mt-3 flex flex-col gap-3 rounded-[20px] px-5 py-4 md:flex-row md:items-end">
          <div className="flex-1 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label>Name *</label>
              <input
                type="text"
                value={newContact.name}
                onChange={(e) => {
                  setNewContact((p) => ({ ...p, name: e.target.value }));
                  if (addError) setAddError('');
                }}
                placeholder="Full name"
                className={`w-full px-2.5 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40 ${
                  addError ? 'border-accent-red' : ''
                }`}
                aria-invalid={Boolean(addError)}
                aria-describedby={addError ? 'new-contact-name-error' : undefined}
                autoFocus
              />
              {addError && (
                <div id="new-contact-name-error" className="mt-1 text-[11px] text-accent-red">
                  {addError}
                </div>
              )}
            </div>
            <div>
              <label>Email</label>
              <input
                type="email"
                value={newContact.email}
                onChange={(e) => setNewContact((p) => ({ ...p, email: e.target.value }))}
                placeholder="Email"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
              />
            </div>
            <div>
              <label>Company</label>
              <input
                type="text"
                value={newContact.company}
                onChange={(e) => setNewContact((p) => ({ ...p, company: e.target.value }))}
                placeholder="Company"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
              />
            </div>
          </div>
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={handleAddContact}
              className="water-primary-button px-4 py-1.5"
            >
              Save
            </button>
            <button
              onClick={() => {
                setShowAddForm(false);
                setNewContact({ name: '', email: '', company: '' });
                setAddError('');
              }}
              className="water-text-button px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Main content: table + detail panel */}
      <div className="flex-1 flex overflow-hidden">
        {/* Table panel */}
        <div className={`flex-1 overflow-hidden transition-all duration-200 ${selectedId ? 'min-w-0' : ''}`}>
          <ContactList
            contacts={contacts}
            selectedId={selectedId}
            onSelectContact={setSelectedId}
            sort={sort}
            onSort={setSort}
          />
        </div>

        {/* Detail panel (slide-in) */}
        {selectedId && (
          <div className="water-detail-shell w-[380px] flex-shrink-0 overflow-hidden">
            <ContactDetail
              key={selectedId}
              contactId={selectedId}
              onContactDeleted={handleContactDeleted}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
      </div>

      {showImport && (
        <ImportModal onClose={() => setShowImport(false)} />
      )}
    </div>
  );
}

type AttioObjectFilter = 'all' | AttioObjectType;

function sortAttioRecords(records: AttioCRMRecord[], sort: string): AttioCRMRecord[] {
  const sorted = [...records];
  if (sort === 'last_contact_date') {
    sorted.sort((a, b) => {
      if (!a.lastContactDate && !b.lastContactDate) return 0;
      if (!a.lastContactDate) return 1;
      if (!b.lastContactDate) return -1;
      return b.lastContactDate.localeCompare(a.lastContactDate);
    });
    return sorted;
  }

  const key =
    sort === 'company'
      ? 'company'
      : sort === 'role'
        ? 'role'
        : sort === 'tier'
          ? 'tier'
          : sort === 'relationship'
            ? 'relationship'
            : 'name';

  sorted.sort((a, b) =>
    String(a[key] ?? '').localeCompare(String(b[key] ?? ''))
  );
  return sorted;
}

function AttioCRMView() {
  const [records, setRecords] = useState<AttioCRMRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [lastLoadedAt, setLastLoadedAt] = useState<string>();
  const [search, setSearch] = useState('');
  const [objectFilter, setObjectFilter] = useState<AttioObjectFilter>('all');
  const [tier, setTier] = useState('');
  const [sort, setSort] = useState('last_contact_date');

  const reload = useCallback(async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      const payload = await listAttioCRMRecords();
      setRecords(payload.records);
      setLastLoadedAt(payload.generatedAt);
      setSelectedId((currentId) =>
        currentId && payload.records.some((record) => record._id === currentId)
          ? currentId
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const tierOptions = useMemo(() => {
    return Array.from(new Set(records.map((record) => record.tier).filter(Boolean))).sort();
  }, [records]);

  const visibleRecords = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = records.filter((record) => {
      if (objectFilter !== 'all' && record.objectType !== objectFilter) return false;
      if (tier && record.tier !== tier) return false;
      if (!q) return true;

      return [
        record.name,
        record.company,
        record.email,
        record.role,
        record.linkedin,
        record.notes,
        record.relationship,
        record.relevant,
        record.tags.join(' '),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });

    return sortAttioRecords(filtered, sort);
  }, [objectFilter, records, search, sort, tier]);

  const selectedRecord = useMemo(
    () => records.find((record) => record._id === selectedId) ?? null,
    [records, selectedId]
  );

  const peopleCount = records.filter((record) => record.objectType === 'people').length;
  const companyCount = records.filter((record) => record.objectType === 'companies').length;

  if (loading) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state px-6 py-5 text-sm">Loading people from Attio...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state max-w-lg p-5 text-sm">
          <p className="font-medium text-foreground">People could not load from Attio.</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
          <button
            onClick={() => void reload()}
            className="water-primary-button mt-3 px-4 py-1.5"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`water-workspace people-surface grid h-full overflow-hidden max-lg:flex max-lg:flex-col ${
        selectedRecord
          ? 'grid-cols-[220px_minmax(0,1fr)_380px] max-xl:grid-cols-[180px_minmax(0,1fr)_340px]'
          : 'grid-cols-[220px_minmax(0,1fr)] max-xl:grid-cols-[180px_minmax(0,1fr)]'
      }`}
    >
      <aside className="water-sidebar px-3 py-3 max-lg:hidden">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="water-workspace-title text-sm">Attio</div>
            <div className="text-[11px] text-muted-foreground">
              {records.length} records
            </div>
          </div>
          <button
            onClick={() => void reload()}
            disabled={refreshing}
            className="water-secondary-button px-2.5 py-1 disabled:opacity-50"
          >
            {refreshing ? 'Syncing' : 'Refresh'}
          </button>
        </div>

        <div className="space-y-1 text-[12px]">
          {([
            ['all', 'All records', records.length],
            ['people', 'People', peopleCount],
            ['companies', 'Companies', companyCount],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setObjectFilter(key)}
              className={`water-sidebar-row flex w-full items-center justify-between px-2.5 py-1.5 text-left ${
                objectFilter === key
                  ? 'is-active'
                  : 'text-muted-foreground'
              }`}
            >
              <span>{label}</span>
              <span className="tabular-nums">{count}</span>
            </button>
          ))}
        </div>

        <div className="mt-5 border-t border-border/40 pt-3">
          <div className="water-eyebrow mb-2">RELATIONSHIP GROUPS</div>
          <div className="space-y-1">
            <button
              onClick={() => setTier('')}
              className={`water-sidebar-row flex w-full items-center justify-between px-2.5 py-1 text-[12px] ${
                !tier ? 'is-active' : 'text-muted-foreground'
              }`}
            >
              <span>All groups</span>
              <span>{records.length}</span>
            </button>
            {tierOptions.slice(0, 8).map((option) => (
              <button
                key={option}
                onClick={() => setTier(option)}
                className={`water-sidebar-row flex w-full items-center justify-between px-2.5 py-1 text-[12px] ${
                  tier === option
                    ? 'is-active'
                    : 'text-muted-foreground'
                }`}
              >
                <span className="truncate">{option}</span>
                <span>{records.filter((record) => record.tier === option).length}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 border-t pt-3 text-[11px] text-muted-foreground">
          <div>Synced from Attio</div>
          {lastLoadedAt && <div>Loaded: {new Date(lastLoadedAt).toLocaleTimeString()}</div>}
        </div>
      </aside>

      <section className="water-table-panel flex min-w-0 flex-col overflow-hidden max-lg:flex-1">
        <div className="water-toolbar border-b px-5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-2">
              <h1 className="water-workspace-title text-sm">People</h1>
              <p className="text-[11px] text-muted-foreground">
                {visibleRecords.length} visible / {records.length} Attio records
              </p>
            </div>

            <div className="relative min-w-[180px] max-w-[280px] flex-1">
              <svg className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="search"
                placeholder="Search Attio..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="water-control w-full py-1.5 pl-8 pr-3 text-xs placeholder:text-muted-foreground"
              />
            </div>

            <select
              value={objectFilter}
              onChange={(event) => setObjectFilter(event.target.value as AttioObjectFilter)}
              className="water-control px-3 py-1.5 text-xs"
            >
              <option value="all">All records</option>
              <option value="people">People</option>
              <option value="companies">Companies</option>
            </select>

            <select
              value={tier}
              onChange={(event) => setTier(event.target.value)}
              className="water-control px-3 py-1.5 text-xs"
            >
              <option value="">All groups</option>
              {tierOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>

            <button
              onClick={() => void reload()}
              disabled={refreshing}
              className="water-secondary-button ml-auto px-4 py-1.5 disabled:opacity-50"
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        <ContactList
          contacts={visibleRecords}
          selectedId={selectedId}
          onSelectContact={setSelectedId}
          sort={sort}
          onSort={setSort}
          emptyMessage="No Attio records match this view."
        />
      </section>

      {selectedRecord && (
        <aside className="water-detail-shell max-lg:hidden">
          <AttioRecordDetail
            record={selectedRecord}
            onClose={() => setSelectedId(null)}
          />
        </aside>
      )}

      {selectedRecord && (
        <div className="water-detail-shell hidden max-lg:block max-lg:min-h-[320px] max-lg:flex-1 max-lg:overflow-hidden">
          <AttioRecordDetail
            record={selectedRecord}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </div>
  );
}
