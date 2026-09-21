'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listContacts,
  listCompanies,
  createContact,
  createCompany,
  updateContact,
  deleteContact,
  listContactActivities,
  createContactActivity,
} from '@/lib/data/crm';
import type { Company, Contact, ContactActivity } from '@/lib/data/types';
import { useDataChanged } from '@/lib/data/refresh-bus';
import CrmSubNav from './CrmSubNav';

// Local-mode CRM. Contacts and relationship history use the dedicated /api/crm
// interface; company CRUD keeps the existing local REST path. No account, no
// login. Two panes: a searchable contact list on the left, a detail panel on the
// right that edits the selected contact and shows its activity timeline.

function relativeDate(iso?: string | null): string {
  if (!iso) return 'No contact yet';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'No contact yet';
  const diffMs = Date.now() - then;
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.floor(diffDays / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

function fullTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Sort by last_interaction_at descending, with null/empty dates always last.
function byLastInteractionDesc(a: Contact, b: Contact): number {
  const av = a.last_interaction_at;
  const bv = b.last_interaction_at;
  if (!av && !bv) return a.name.localeCompare(b.name);
  if (!av) return 1;
  if (!bv) return -1;
  return bv.localeCompare(av);
}

const ACTIVITY_TYPES: Array<{ value: string; label: string }> = [
  { value: 'note', label: 'Note' },
  { value: 'call', label: 'Call' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'email', label: 'Email' },
];

type EditableContactField = 'notes' | 'location' | 'howWeMet' | 'tier' | 'tags';

export default function LocalCRMView() {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const load = useCallback(async (query = '') => {
    try {
      const [contactRows, companyRows] = await Promise.all([
        listContacts(query.trim() || undefined),
        listCompanies(),
      ]);
      setError(undefined);
      setContacts(contactRows);
      setCompanies(companyRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useDataChanged(
    ['contacts', 'companies'],
    () => void load(search),
  );

  useEffect(() => {
    const timeout = window.setTimeout(
      () => void load(search),
      search.trim() ? 200 : 0,
    );
    return () => window.clearTimeout(timeout);
  }, [load, search]);

  const companyById = useMemo(() => {
    const map = new Map<string, Company>();
    for (const c of companies) map.set(c.id, c);
    return map;
  }, [companies]);

  const companyName = useCallback(
    (contact: Contact): string => {
      if (!contact.company_id) return '';
      return companyById.get(contact.company_id)?.name ?? '';
    },
    [companyById],
  );

  const visibleContacts = useMemo(() => {
    return [...(contacts ?? [])].sort(byLastInteractionDesc);
  }, [contacts]);

  const selectedContact = useMemo(
    () => (contacts ?? []).find((c) => c.id === selectedId) ?? null,
    [contacts, selectedId],
  );

  // Replace a contact in local state after a server write, so edits show at once.
  const applyContact = useCallback((updated: Contact) => {
    setContacts((cur) =>
      cur ? cur.map((c) => (c.id === updated.id ? updated : c)) : cur,
    );
  }, []);

  function handleContactCreated(contact: Contact, newCompany?: Company) {
    setContacts((cur) => (cur ? [...cur, contact] : [contact]));
    if (newCompany) setCompanies((cur) => [...cur, newCompany]);
    setSelectedId(contact.id);
    setMobileDetailOpen(true);
    setShowAddForm(false);
  }

  function handleContactDeleted(id: string) {
    setContacts((cur) => (cur ? cur.filter((c) => c.id !== id) : cur));
    if (selectedId === id) {
      setSelectedId(null);
      setMobileDetailOpen(false);
    }
  }

  if (error) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state max-w-lg p-6">
          <p className="water-eyebrow">Relationships</p>
          <h1 className="water-workspace-title mt-2">People could not load.</h1>
          <p className="mt-2 text-[13.5px] leading-[1.55] text-muted-foreground">{error}</p>
          <button
            onClick={() => void load(search)}
            className="water-primary-button mt-4 px-4 py-2"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (contacts === null) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state px-6 py-5 text-sm">Loading people...</div>
      </div>
    );
  }

  return (
    <div className={`water-workspace people-surface flex h-full overflow-hidden ${
      mobileDetailOpen ? 'is-detail-open' : ''
    }`}>
      {/* Left pane: list */}
      <section className="people-list-pane water-list-panel flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="water-toolbar people-toolbar flex flex-wrap items-center gap-3 border-b px-5 pb-4 pt-[64px]">
          <div className="flex shrink-0 items-end gap-3">
            <div>
              <p className="water-eyebrow">Relationships</p>
              <h1 className="water-workspace-title mt-1">People</h1>
            </div>
            <CrmSubNav />
          </div>

          <div className="relative min-w-[180px] max-w-[280px] flex-1">
            <svg
              className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              aria-label="Search people"
              placeholder={
                // The field is 278px wide, and narrower still under 900px. The
                // longer hint was cut mid-word at every width, which reads as a
                // half-finished screen; email and tags are still searched.
                'Search name or company'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="water-control w-full py-2 pl-8 pr-3 text-[13.5px] placeholder:text-muted-foreground"
            />
          </div>

          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="water-primary-button ml-auto shrink-0 px-4 py-2"
          >
            + Add contact
          </button>
          <p className="w-full text-[12px] font-medium text-muted-foreground tabular-nums">
            {contacts.length} {contacts.length === 1 ? 'person' : 'people'}
          </p>
        </div>

        {showAddForm && (
          <AddContactForm
            companies={companies}
            onCreated={handleContactCreated}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        <div className="flex-1 overflow-y-auto">
          {visibleContacts.length === 0 ? (
            <p className="water-empty-state m-5 px-5 py-10 text-center text-sm">
              {!search.trim() && contacts.length === 0
                ? 'No contacts yet. Add your first one to get started.'
                : 'No contacts match this search.'}
            </p>
          ) : (
            <ul>
              {visibleContacts.map((contact) => {
                const active = contact.id === selectedId;
                return (
                  <li key={contact.id}>
                    <button
                      onClick={() => {
                        setSelectedId(contact.id);
                        setMobileDetailOpen(true);
                      }}
                      className={`water-list-row flex min-h-[56px] w-full items-center gap-3 border-b px-5 py-2.5 text-left ${
                        active ? 'is-active' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[13.5px] font-medium text-foreground">
                            {contact.name}
                          </span>
                          {companyName(contact) && (
                            <span className="truncate text-[12px] text-muted-foreground">
                              {companyName(contact)}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 text-[12px] font-medium text-muted-foreground tabular-nums">
                        {relativeDate(contact.last_interaction_at)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Right pane: detail */}
      <aside className="people-detail-pane water-detail-shell w-[400px] shrink-0 overflow-y-auto max-lg:w-[340px]">
        {selectedContact ? (
          <ContactDetailPanel
            key={selectedContact.id}
            contact={selectedContact}
            companyName={companyName(selectedContact)}
            onSaveContact={async (patch) => {
              const updated = await updateContact(selectedContact.id, patch);
              // The dispatcher can return no row (204 / empty body). Don't write
              // undefined into state; surface it instead of crashing the pane.
              if (!updated) {
                throw new Error('Save did not return the updated contact.');
              }
              applyContact(updated);
              return updated;
            }}
            onDeleteContact={async () => {
              await deleteContact(selectedContact.id);
              handleContactDeleted(selectedContact.id);
            }}
            onClose={() => {
              setSelectedId(null);
              setMobileDetailOpen(false);
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <p className="max-w-[240px] text-sm text-muted-foreground">
              Select a contact to see their details, notes, and activity.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function AddContactForm({
  companies,
  onCreated,
  onCancel,
}: {
  companies: Company[];
  onCreated: (contact: Contact, newCompany?: Company) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [phone, setPhone] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [newCompanyName, setNewCompanyName] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const creatingNewCompany = companyId === '__new__';

  async function handleSave() {
    if (!name.trim()) {
      setFormError('Name is required.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      let resolvedCompanyId: string | undefined;
      let createdCompany: Company | undefined;

      if (creatingNewCompany) {
        if (!newCompanyName.trim()) {
          setFormError('Enter a name for the new company.');
          setSaving(false);
          return;
        }
        createdCompany = await createCompany({ name: newCompanyName.trim() });
        resolvedCompanyId = createdCompany.id;
      } else if (companyId) {
        resolvedCompanyId = companyId;
      }

      const contact = await createContact({
        name: name.trim(),
        email: email.trim() || undefined,
        role: role.trim() || undefined,
        phone: phone.trim() || undefined,
        company_id: resolvedCompanyId,
      });
      onCreated(contact, createdCompany);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div className="water-form-panel mx-5 mt-3 flex flex-col gap-3 rounded-[20px] px-5 py-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="crm-new-contact-name">Name *</label>
          <input
            id="crm-new-contact-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (formError) setFormError('');
            }}
            placeholder="Full name"
            autoFocus
            aria-invalid={formError && !name.trim() ? true : undefined}
            aria-describedby={formError ? 'crm-new-contact-error' : undefined}
            className={`w-full px-2.5 py-1.5 text-foreground ${
              formError && !name.trim() ? 'border-accent-red' : ''
            }`}
          />
        </div>
        <div>
          <label htmlFor="crm-new-contact-email">Email</label>
          <input
            id="crm-new-contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full px-2.5 py-1.5 text-foreground"
          />
        </div>
        <div>
          <label htmlFor="crm-new-contact-role">Role</label>
          <input
            id="crm-new-contact-role"
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role"
            className="w-full px-2.5 py-1.5 text-foreground"
          />
        </div>
        <div>
          <label htmlFor="crm-new-contact-phone">Phone</label>
          <input
            id="crm-new-contact-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
            className="w-full px-2.5 py-1.5 text-foreground"
          />
        </div>
        <div>
          <label htmlFor="crm-new-contact-company">Company</label>
          <select
            id="crm-new-contact-company"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="w-full px-2.5 py-1.5 text-foreground"
          >
            <option value="">No company</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="__new__">+ New company...</option>
          </select>
        </div>
        {creatingNewCompany && (
          <div className="sm:col-span-2">
            <label htmlFor="crm-new-contact-company-name">
              New company name
            </label>
            <input
              id="crm-new-contact-company-name"
              type="text"
              value={newCompanyName}
              onChange={(e) => setNewCompanyName(e.target.value)}
              placeholder="Company name"
              className="w-full px-2.5 py-1.5 text-foreground"
            />
          </div>
        )}
      </div>

      {formError && (
        <div
          id="crm-new-contact-error"
          role="alert"
          className="text-[12px] font-medium text-accent-red"
        >
          {formError}
        </div>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="water-primary-button px-4 py-1.5 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save contact'}
        </button>
        <button
          onClick={onCancel}
          className="water-text-button px-3 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ContactDetailPanel({
  contact,
  companyName,
  onSaveContact,
  onDeleteContact,
  onClose,
}: {
  contact: Contact;
  companyName: string;
  onSaveContact: (patch: Partial<Contact>) => Promise<Contact>;
  onDeleteContact: () => Promise<void>;
  onClose: () => void;
}) {
  // Editable fields hold their own draft state so we can save on blur without
  // re-rendering the whole list on every keystroke.
  const [notes, setNotes] = useState(contact.notes ?? '');
  const [location, setLocation] = useState(contact.location ?? '');
  const [howWeMet, setHowWeMet] = useState(contact.how_we_met ?? '');
  const [tier, setTier] = useState(contact.tier ?? 'C');
  const [tagsStr, setTagsStr] = useState(contact.tags.join(', '));
  const [saveError, setSaveError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<EditableContactField, string>>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const latestSaveRequestId = useRef(0);
  const latestRequestByField = useRef<Partial<Record<EditableContactField, number>>>({});
  const dirtyVersionByField = useRef<Record<EditableContactField, number>>({
    notes: 0,
    location: 0,
    howWeMet: 0,
    tier: 0,
    tags: 0,
  });
  const saveStatusField = useRef<EditableContactField | undefined>(undefined);
  const savedStatusTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (savedStatusTimer.current !== undefined) {
        window.clearTimeout(savedStatusTimer.current);
      }
    };
  }, []);

  function clearSavedStatusTimer() {
    if (savedStatusTimer.current === undefined) return;
    window.clearTimeout(savedStatusTimer.current);
    savedStatusTimer.current = undefined;
  }

  function markDraftDirty(field: EditableContactField) {
    dirtyVersionByField.current[field] += 1;
    if (saveStatus === 'saved' && saveStatusField.current === field) {
      clearSavedStatusTimer();
      saveStatusField.current = undefined;
      setSaveStatus('idle');
    }
  }

  async function saveField(field: EditableContactField, patch: Partial<Contact>) {
    const requestId = ++latestSaveRequestId.current;
    latestRequestByField.current[field] = requestId;
    const dirtyVersionAtStart = dirtyVersionByField.current[field];
    clearSavedStatusTimer();
    saveStatusField.current = field;
    try {
      setFieldErrors(current => ({ ...current, [field]: undefined }));
      setSaveStatus('saving');
      await onSaveContact(patch);
      if (requestId !== latestSaveRequestId.current) return;
      if (dirtyVersionByField.current[field] !== dirtyVersionAtStart) {
        saveStatusField.current = undefined;
        setSaveStatus('idle');
        return;
      }
      setSaveStatus('saved');
      savedStatusTimer.current = window.setTimeout(() => {
        if (requestId !== latestSaveRequestId.current) return;
        saveStatusField.current = undefined;
        setSaveStatus('idle');
        savedStatusTimer.current = undefined;
      }, 3000);
    } catch (err) {
      // A successful location save cannot hide an independent failed note save.
      if (requestId !== latestRequestByField.current[field]) return;
      if (requestId === latestSaveRequestId.current) {
        saveStatusField.current = undefined;
        setSaveStatus('idle');
      }
      setFieldErrors(current => ({ ...current, [field]: err instanceof Error ? err.message : String(err) }));
    }
  }

  function commitNotes() {
    if (notes === (contact.notes ?? '')) return;
    void saveField('notes', { notes });
  }

  function commitLocation() {
    if (location === (contact.location ?? '')) return;
    void saveField('location', { location: location || null });
  }

  function commitHowWeMet() {
    if (howWeMet === (contact.how_we_met ?? '')) return;
    void saveField('howWeMet', { how_we_met: howWeMet || null });
  }

  function commitTier(next: string) {
    setTier(next);
    if (next === contact.tier) return;
    markDraftDirty('tier');
    void saveField('tier', { tier: next });
  }

  function commitTags() {
    const parsed = Array.from(
      new Set(
        tagsStr
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    );
    if (parsed.join(',') === contact.tags.join(',')) return;
    void saveField('tags', { tags: parsed });
  }

  async function handleDelete() {
    if (!confirm(`Delete ${contact.name}? This cannot be undone.`)) return;
    try {
      setSaveError(undefined);
      await onDeleteContact();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="water-detail-panel flex flex-col">
      <div className="water-detail-heading border-b px-5 pb-4 pt-[64px]">
        <button
          type="button"
          onClick={onClose}
          className="people-mobile-back water-text-button mb-3 items-center gap-1 px-0 py-1"
        >
          <span aria-hidden="true">←</span> Back
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="truncate text-[21px] font-[650] tracking-[-0.018em]">
              {contact.name}
            </h2>
            <span className="text-[12px] font-medium text-muted-foreground" role="status" aria-live="polite">
              {Object.values(fieldErrors).some(Boolean) ? 'Some changes not saved' : saveStatus === 'idle' ? '' : saveStatus === 'saving' ? 'Saving...' : 'Saved'}
            </span>
          </div>
          <p className="mt-0.5 text-[13.5px] leading-[1.55] text-muted-foreground">
            {[contact.role, companyName].filter(Boolean).join(' at ') ||
              'No role set'}
          </p>
          <div className="mt-2 flex flex-col gap-1 text-[12px]">
            {contact.email && (
              <a
                href={`mailto:${contact.email}`}
                className="text-accent-blue hover:underline"
              >
                {contact.email}
              </a>
            )}
            {contact.phone && (
              <a
                href={`tel:${contact.phone}`}
                className="text-accent-blue hover:underline"
              >
                {contact.phone}
              </a>
            )}
            {contact.linkedin && (
              <a
                href={contact.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-blue hover:underline"
              >
                LinkedIn
              </a>
            )}
          </div>
          </div>
          <button
            onClick={onClose}
            className="water-secondary-button flex h-8 w-8 shrink-0 items-center justify-center text-lg leading-none"
            aria-label="Close details"
          >
            &times;
          </button>
        </div>
      </div>

      {saveError && (
        <div className="border-b bg-accent-red/5 px-5 py-2 text-[12px] text-accent-red">
          {saveError}
        </div>
      )}
      {Object.entries(fieldErrors).filter(([, message]) => message).map(([field, message]) => (
        <p key={field} role="alert" className="border-b bg-accent-red/5 px-5 py-2 text-[12px] text-accent-red">
          Could not save {field.replace(/([A-Z])/g, ' $1').toLowerCase()}: {message}. Your text is still here; edit this field and leave it to retry.
        </p>
      ))}

      <div className="space-y-4 px-5 py-4">
        <div>
          <label className="mb-1.5 block" htmlFor="contact-detail-notes">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              markDraftDirty('notes');
            }}
            onBlur={commitNotes}
            id="contact-detail-notes"
            rows={4}
            placeholder="What should you remember about this person?"
            className="w-full resize-y px-2.5 py-2 text-foreground"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block" htmlFor="contact-detail-tier">
              Tier
            </label>
            <select
              value={tier}
              onChange={(e) => commitTier(e.target.value)}
              id="contact-detail-tier"
              className="w-full px-2.5 py-2 text-foreground"
            >
              <option value="A">Tier A</option>
              <option value="B">Tier B</option>
              <option value="C">Tier C</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block" htmlFor="contact-detail-location">
              Location
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => {
                setLocation(e.target.value);
                markDraftDirty('location');
              }}
              onBlur={commitLocation}
              id="contact-detail-location"
              placeholder="City, region"
              className="w-full px-2.5 py-2 text-foreground"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block" htmlFor="contact-detail-how-we-met">
            How we met
          </label>
          <input
            type="text"
            value={howWeMet}
            onChange={(e) => {
              setHowWeMet(e.target.value);
              markDraftDirty('howWeMet');
            }}
            onBlur={commitHowWeMet}
            id="contact-detail-how-we-met"
            placeholder="Where the relationship started"
            className="w-full px-2.5 py-2 text-foreground"
          />
        </div>

        <div>
          <label className="mb-1.5 block" htmlFor="contact-detail-tags">
            Tags (comma-separated)
          </label>
          <input
            type="text"
            value={tagsStr}
            onChange={(e) => {
              setTagsStr(e.target.value);
              markDraftDirty('tags');
            }}
            onBlur={commitTags}
            id="contact-detail-tags"
            placeholder="investor, warm intro, roofing"
            className="w-full px-2.5 py-2 text-foreground"
          />
        </div>
      </div>

      <ActivityTimeline contactId={contact.id} onActivityAdded={onSaveContact} />

      <div className="flex justify-between border-t px-5 py-3">
        <button
          onClick={() => void handleDelete()}
          className="text-[12px] font-medium text-accent-red hover:underline"
        >
          Delete contact
        </button>
      </div>
    </div>
  );
}

function ActivityTimeline({
  contactId,
  onActivityAdded,
}: {
  contactId: string;
  // After adding an activity we touch last_interaction_at on the contact so the
  // list re-sorts and the "last contact" label updates without a full reload.
  onActivityAdded: (patch: Partial<Contact>) => Promise<Contact>;
}) {
  const [activities, setActivities] = useState<ContactActivity[] | null>(null);
  const [error, setError] = useState<string>();
  const [touchWarning, setTouchWarning] = useState<string>();
  const [activityType, setActivityType] = useState('note');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(undefined);
      const rows = await listContactActivities(contactId);
      setActivities(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [contactId]);

  useDataChanged(['contact_activities'], () => void load());

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd() {
    if (!title.trim()) {
      setError('Give the activity a title.');
      return;
    }
    setSaving(true);
    try {
      setError(undefined);
      setTouchWarning(undefined);
      await createContactActivity({
        contact_id: contactId,
        activity_type: activityType,
        title: title.trim(),
        content: content.trim() || undefined,
      });
      setTitle('');
      setContent('');
      setActivityType('note');
      await load();
      // The activity is saved. Touch last_interaction_at so the list re-sorts and
      // the "last contact" label updates. If only this touch fails, keep the saved
      // activity but tell the user the timestamp is stale rather than hiding it.
      try {
        await onActivityAdded({ last_interaction_at: new Date().toISOString() });
      } catch (touchErr) {
        setTouchWarning(
          `Activity saved, but the last-contact time did not update: ${
            touchErr instanceof Error ? touchErr.message : String(touchErr)
          }`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border/50 px-5 py-4">
      <h3 className="water-eyebrow mb-2">
        Activity
      </h3>

      <div className="water-activity-card mb-3 flex flex-col gap-2 border p-3">
        <div className="flex gap-2">
          <select
            value={activityType}
            onChange={(e) => setActivityType(e.target.value)}
            aria-label="Kind of activity"
            className="px-2 py-1.5 text-foreground"
          >
            {ACTIVITY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (error) setError(undefined);
            }}
            aria-label="What happened"
            placeholder="Title"
            className="min-w-0 flex-1 px-2.5 py-1.5 text-foreground"
          />
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          aria-label="Details of what happened, optional"
          placeholder="Details (optional)"
          className="w-full resize-y px-2.5 py-1.5 text-foreground"
        />
        <div className="flex justify-end">
          <button
            onClick={() => void handleAdd()}
            disabled={saving}
            className="water-primary-button px-4 py-1.5 disabled:opacity-50"
          >
            {saving ? 'Adding...' : 'Add activity'}
          </button>
        </div>
      </div>

      {error && <p className="mb-2 text-[12px] text-accent-red">{error}</p>}
      {touchWarning && (
        <p className="mb-2 text-[12px] text-accent-orange">{touchWarning}</p>
      )}

      {activities === null ? (
        <p className="py-4 text-center text-[12px] text-muted-foreground">
          Loading activity...
        </p>
      ) : activities.length === 0 ? (
        <p className="py-4 text-center text-[12px] text-muted-foreground">
          No activity logged yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {activities.map((a) => (
            <li
              key={a.id}
              className="water-activity-card border px-3 py-2.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-medium text-foreground">
                  {a.title || ACTIVITY_TYPES.find((t) => t.value === a.activity_type)?.label || a.activity_type}
                </span>
                <span className="shrink-0 text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">
                  {a.activity_type}
                </span>
              </div>
              {a.content && (
                <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                  {a.content}
                </p>
              )}
              <p className="mt-1 text-[12px] font-medium text-muted-foreground">
                {fullTimestamp(a.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
