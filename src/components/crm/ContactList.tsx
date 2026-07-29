'use client';

import { useEffect, useRef, useState } from 'react';

interface Contact {
  _id: string;
  name: string;
  objectType?: 'people' | 'companies';
  email?: string;
  company?: string;
  role?: string;
  linkedin?: string;
  notes?: string;
  tier: string;
  relationship?: string;
  relevant?: string;
  tags: string[];
  lastContactDate?: string;
}

interface ContactListProps {
  contacts: Contact[];
  selectedId: string | null;
  onSelectContact: (id: string) => void;
  sort: string;
  onSort: (sort: string) => void;
  emptyMessage?: string;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function getInitialsColor(name: string): string {
  const colors = [
    'bg-accent-blue', 'bg-accent-green', 'bg-accent-orange', 'bg-accent-red',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const tierColors: Record<string, string> = {
  A: 'bg-accent-green/10 text-accent-green',
  B: 'bg-accent-blue/10 text-accent-blue',
  C: 'bg-muted text-muted-foreground',
};

type ColumnKey = 'name' | 'type' | 'company' | 'role' | 'email' | 'linkedin' | 'notes' | 'tier' | 'relationship' | 'tags' | 'lastContactDate';

const ALL_COLUMNS: { key: ColumnKey; label: string; defaultVisible: boolean }[] = [
  { key: 'name', label: 'Name', defaultVisible: true },
  { key: 'type', label: 'Type', defaultVisible: true },
  { key: 'company', label: 'Company', defaultVisible: true },
  { key: 'role', label: 'Role', defaultVisible: true },
  { key: 'email', label: 'Email', defaultVisible: true },
  { key: 'linkedin', label: 'LinkedIn', defaultVisible: true },
  { key: 'notes', label: 'Notes', defaultVisible: true },
  { key: 'tier', label: 'Tier', defaultVisible: true },
  { key: 'relationship', label: 'Relationship', defaultVisible: true },
  { key: 'tags', label: 'Tags', defaultVisible: true },
  { key: 'lastContactDate', label: 'Last Contact', defaultVisible: true },
];

export default function ContactList({
  contacts,
  selectedId,
  onSelectContact,
  sort,
  onSort,
  emptyMessage = 'No contacts yet. Add your first contact to get started.',
}: ContactListProps) {
  const [visibleCols, setVisibleCols] = useState<Set<ColumnKey>>(
    new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key))
  );
  const [showColMenu, setShowColMenu] = useState(false);
  const [checkedRows, setCheckedRows] = useState<Set<string>>(new Set());
  const columnMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (
        showColMenu &&
        columnMenuRef.current &&
        !columnMenuRef.current.contains(event.target as Node)
      ) {
        setShowColMenu(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [showColMenu]);

  function toggleColumn(key: ColumnKey) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleRow(id: string) {
    setCheckedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (checkedRows.size === contacts.length) {
      setCheckedRows(new Set());
    } else {
      setCheckedRows(new Set(contacts.map((c) => c._id)));
    }
  }

  const columns = ALL_COLUMNS.filter((c) => visibleCols.has(c.key));

  function handleSort(key: string) {
    if (key === 'name') onSort('name');
    else if (key === 'company') onSort('company');
    else if (key === 'role') onSort('role');
    else if (key === 'tier') onSort('tier');
    else if (key === 'relationship') onSort('relationship');
    else if (key === 'lastContactDate') onSort('last_contact_date');
  }

  function getSortArrow(key: string) {
    const mapping: Record<string, string> = {
      name: 'name',
      company: 'company',
      role: 'role',
      tier: 'tier',
      relationship: 'relationship',
      lastContactDate: 'last_contact_date',
    };
    return sort === mapping[key] ? ' \u2193' : '';
  }

  return (
    <div className="flex h-full flex-col">
      {/* Column visibility toggle */}
      <div className="water-table-tools flex items-center justify-end border-b px-4 py-2">
        <div className="relative" ref={columnMenuRef}>
          <button
            onClick={() => setShowColMenu(!showColMenu)}
            className="water-secondary-button px-3 py-1"
          >
            Columns
          </button>
          {showColMenu && (
            <div className="water-popover absolute right-0 top-full z-10 mt-1 min-w-[150px] py-1.5">
              {ALL_COLUMNS.map((col) => (
                <label
                  key={col.key}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={visibleCols.has(col.key)}
                    onChange={() => toggleColumn(col.key)}
                    className="rounded border-border"
                  />
                  {col.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {contacts.length === 0 ? (
          <div className="water-empty-state m-5 px-4 py-12 text-center text-sm">
            {emptyMessage}
          </div>
        ) : (
          <table className="water-contact-table w-full text-[13px]">
            <thead>
              <tr className="sticky top-0 border-b text-left text-muted-foreground">
                <th className="pl-4 pr-2 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={checkedRows.size === contacts.length && contacts.length > 0}
                    onChange={toggleAll}
                    className="rounded border-border"
                  />
                </th>
                {columns.map((col) => {
                  const sortable = ['name', 'company', 'role', 'tier', 'relationship', 'lastContactDate'].includes(col.key);
                  return (
                    <th
                      key={col.key}
                      className={`px-3 py-2 font-medium ${sortable ? 'cursor-pointer hover:text-foreground' : ''}`}
                      onClick={sortable ? () => handleSort(col.key) : undefined}
                    >
                      {col.label}{getSortArrow(col.key)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => {
                const isSelected = contact._id === selectedId;
                const isChecked = checkedRows.has(contact._id);
                return (
                  <tr
                    key={contact._id}
                    onClick={() => onSelectContact(contact._id)}
                    className={`water-contact-row cursor-pointer border-b ${
                      isSelected ? 'is-selected' : ''
                    }`}
                  >
                    <td className="pl-4 pr-2 py-2">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleRow(contact._id);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded border-border"
                      />
                    </td>
                    {columns.map((col) => (
                      <td key={col.key} className="px-3 py-2">
                        {col.key === 'name' && (
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0 ${getInitialsColor(contact.name)}`}
                            >
                              {getInitials(contact.name)}
                            </div>
                            <span className="font-medium text-foreground truncate max-w-[160px]">{contact.name}</span>
                          </div>
                        )}
                        {col.key === 'company' && (
                          <span className={contact.company ? 'text-accent-blue' : 'text-muted-foreground'}>
                            {contact.company || '--'}
                          </span>
                        )}
                        {col.key === 'type' && (
                          <span className="water-pill px-2 py-0.5">
                            {contact.objectType === 'companies' ? 'Company' : 'Person'}
                          </span>
                        )}
                        {col.key === 'role' && (
                          <span className="text-muted-foreground truncate max-w-[160px] block text-[11px]">
                            {contact.role || '--'}
                          </span>
                        )}
                        {col.key === 'email' && (
                          <span className="text-muted-foreground truncate max-w-[180px] block">
                            {contact.email || '--'}
                          </span>
                        )}
                        {col.key === 'linkedin' && (
                          <span className="text-muted-foreground truncate max-w-[140px] block text-[11px]">
                            {contact.linkedin || '--'}
                          </span>
                        )}
                        {col.key === 'notes' && (
                          <span className="text-muted-foreground truncate max-w-[120px] block text-[11px]">
                            {contact.notes || '--'}
                          </span>
                        )}
                        {col.key === 'tier' && (
                          <span className={`water-pill px-2 py-0.5 ${tierColors[contact.tier] ?? tierColors.C}`}>
                            {contact.tier}
                          </span>
                        )}
                        {col.key === 'relationship' && (
                          <span className="text-muted-foreground truncate max-w-[140px] block text-[11px]">
                            {contact.relationship || contact.relevant || '--'}
                          </span>
                        )}
                        {col.key === 'tags' && (
                          <div className="flex flex-wrap gap-1">
                            {contact.tags.slice(0, 2).map((tag) => (
                              <span
                                key={tag}
                                className="water-pill px-2 py-0.5"
                              >
                                {tag}
                              </span>
                            ))}
                            {contact.tags.length > 2 && (
                              <span className="text-[10px] text-muted-foreground">+{contact.tags.length - 2}</span>
                            )}
                          </div>
                        )}
                        {col.key === 'lastContactDate' && (
                          <span className="text-muted-foreground text-[11px]">
                            {formatDate(contact.lastContactDate)}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
