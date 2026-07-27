'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

// Local-mode CRM. Everything reads and writes through the /api/forge-rest
// dispatcher (crm.ts), which talks to the on-machine SQLite store. No account,
// no login. Two panes: a searchable contact list on the left, a detail panel on
// the right that edits the selected contact and shows its activity timeline.

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

export default function LocalCRMView() {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [contactRows, companyRows] = await Promise.all([
        listContacts(),
        listCompanies(),
      ]);
      setError(undefined);
      setContacts(contactRows);
      setCompanies(companyRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useDataChanged(['contacts', 'companies'], () => void load());

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

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
    const rows = contacts ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter((c) =>
          [c.name, companyName(c), c.email ?? '', c.tags.join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(q),
        )
      : rows;
    return [...filtered].sort(byLastInteractionDesc);
  }, [contacts, search, companyName]);

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
    setShowAddForm(false);
  }

  function handleContactDeleted(id: string) {
    setContacts((cur) => (cur ? cur.filter((c) => c.id !== id) : cur));
    if (selectedId === id) setSelectedId(null);
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border bg-card p-4 text-sm">
          <p className="font-medium text-foreground">CRM could not load.</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-3 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (contacts === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading CRM...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left pane: list */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5 sm:gap-3">
          <div className="flex items-baseline gap-2 shrink-0">
            <h1 className="text-sm font-semibold text-foreground">Contacts</h1>
            <span className="text-xs text-muted-foreground tabular-nums">
              {contacts.length} {contacts.length === 1 ? 'entry' : 'entries'}
            </span>
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
              placeholder="Search name, company, email, tags..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
            />
          </div>

          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="ml-auto rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity duration-150 hover:opacity-90 shrink-0"
          >
            + Add contact
          </button>
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
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              {contacts.length === 0
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
                      onClick={() => setSelectedId(contact.id)}
                      className={`flex w-full items-center gap-3 border-b px-5 py-2.5 text-left transition-colors duration-150 ${
                        active ? 'bg-muted' : 'hover:bg-muted/50'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {contact.name}
                          </span>
                          {companyName(contact) && (
                            <span className="truncate text-[12px] text-muted-foreground">
                              {companyName(contact)}
                            </span>
                          )}
                        </div>
                        {contact.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {contact.tags.slice(0, 4).map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
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
      <aside className="w-[400px] shrink-0 overflow-y-auto border-l bg-card max-lg:w-[340px]">
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
            onClose={() => setSelectedId(null)}
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
    <div className="flex flex-col gap-3 border-b bg-muted/30 px-5 py-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="text-[11px] text-muted-foreground">Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (formError) setFormError('');
            }}
            placeholder="Full name"
            autoFocus
            className={`w-full rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40 ${
              formError && !name.trim() ? 'border-accent-red' : ''
            }`}
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">Role</label>
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role"
            className="w-full rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">Phone</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
            className="w-full rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">Company</label>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="w-full rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
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
            <label className="text-[11px] text-muted-foreground">
              New company name
            </label>
            <input
              type="text"
              value={newCompanyName}
              onChange={(e) => setNewCompanyName(e.target.value)}
              placeholder="Company name"
              className="w-full rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
            />
          </div>
        )}
      </div>

      {formError && (
        <div className="text-[11px] text-accent-red">{formError}</div>
      )}

      <div className="flex gap-1.5">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="rounded-md bg-accent-blue px-3 py-1.5 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save contact'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
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

  async function saveField(patch: Partial<Contact>) {
    try {
      setSaveError(undefined);
      await onSaveContact(patch);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  function commitNotes() {
    if (notes === (contact.notes ?? '')) return;
    void saveField({ notes });
  }

  function commitLocation() {
    if (location === (contact.location ?? '')) return;
    void saveField({ location: location || null });
  }

  function commitHowWeMet() {
    if (howWeMet === (contact.how_we_met ?? '')) return;
    void saveField({ how_we_met: howWeMet || null });
  }

  function commitTier(next: string) {
    setTier(next);
    if (next === contact.tier) return;
    void saveField({ tier: next });
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
    void saveField({ tags: parsed });
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
    <div className="flex flex-col">
      <div className="flex items-start justify-between border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">
            {contact.name}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
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
          className="text-lg leading-none text-muted-foreground hover:text-foreground"
          aria-label="Close details"
        >
          &times;
        </button>
      </div>

      {saveError && (
        <div className="border-b bg-accent-red/5 px-5 py-2 text-[12px] text-accent-red">
          {saveError}
        </div>
      )}

      <div className="space-y-4 px-5 py-4">
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={commitNotes}
            rows={4}
            placeholder="What should you remember about this person?"
            className="w-full resize-y rounded-md border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">
              Tier
            </label>
            <select
              value={tier}
              onChange={(e) => commitTier(e.target.value)}
              className="w-full rounded-md border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
            >
              <option value="A">Tier A</option>
              <option value="B">Tier B</option>
              <option value="C">Tier C</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] text-muted-foreground">
              Location
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              onBlur={commitLocation}
              placeholder="City, region"
              className="w-full rounded-md border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">
            How we met
          </label>
          <input
            type="text"
            value={howWeMet}
            onChange={(e) => setHowWeMet(e.target.value)}
            onBlur={commitHowWeMet}
            placeholder="Where the relationship started"
            className="w-full rounded-md border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">
            Tags (comma-separated)
          </label>
          <input
            type="text"
            value={tagsStr}
            onChange={(e) => setTagsStr(e.target.value)}
            onBlur={commitTags}
            placeholder="investor, warm intro, roofing"
            className="w-full rounded-md border bg-background px-2.5 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
          />
        </div>
      </div>

      <ActivityTimeline contactId={contact.id} onActivityAdded={onSaveContact} />

      <div className="flex justify-between border-t px-5 py-3">
        <button
          onClick={() => void handleDelete()}
          className="text-[11px] text-accent-red hover:underline"
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
    <div className="border-t px-5 py-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Activity
      </h3>

      <div className="mb-3 flex flex-col gap-2 rounded-md border bg-background p-2.5">
        <div className="flex gap-2">
          <select
            value={activityType}
            onChange={(e) => setActivityType(e.target.value)}
            className="rounded-md border bg-card px-2 py-1.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
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
            placeholder="Title"
            className="min-w-0 flex-1 rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
          />
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
          placeholder="Details (optional)"
          className="w-full resize-y rounded-md border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-accent-blue/40"
        />
        <div className="flex justify-end">
          <button
            onClick={() => void handleAdd()}
            disabled={saving}
            className="rounded-md bg-accent-blue px-3 py-1.5 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
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
              className="rounded-md border bg-background px-2.5 py-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-foreground">
                  {a.title || ACTIVITY_TYPES.find((t) => t.value === a.activity_type)?.label || a.activity_type}
                </span>
                <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                  {a.activity_type}
                </span>
              </div>
              {a.content && (
                <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                  {a.content}
                </p>
              )}
              <p className="mt-1 text-[10px] text-muted-foreground">
                {fullTimestamp(a.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
