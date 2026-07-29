'use client';

import type { AttioCRMRecord } from '@/lib/data/attio-crm';

interface AttioRecordDetailProps {
  record: AttioCRMRecord | null;
  onClose: () => void;
}

function formatDate(value: string | undefined): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function FieldRow({
  label,
  value,
  href,
}: {
  label: string;
  value?: string;
  href?: string;
}) {
  return (
    <div className="border-b py-2.5 last:border-b-0">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      {value ? (
        href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block break-words text-[12px] text-accent-blue hover:underline"
          >
            {value}
          </a>
        ) : (
          <div className="mt-0.5 break-words text-[12px] text-foreground">{value}</div>
        )
      ) : (
        <div className="mt-0.5 text-[12px] text-muted-foreground">--</div>
      )}
    </div>
  );
}

export default function AttioRecordDetail({
  record,
  onClose,
}: AttioRecordDetailProps) {
  if (!record) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Select a person or company to see the relationship details.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="border-b p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background">
            {getInitials(record.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {record.name}
              </h2>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {record.objectType === 'people' ? 'Person' : 'Company'}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {[record.role, record.company].filter(Boolean).join(' at ') || 'Attio record'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close details"
          >
            &times;
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {record.tags.slice(0, 8).map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>

        {record.attioUrl && (
          <a
            href={record.attioUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
          >
            Open in Attio
          </a>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4">
        <FieldRow label="Email" value={record.email} href={record.email ? `mailto:${record.email}` : undefined} />
        <FieldRow label="Phone" value={record.phone} />
        <FieldRow label="Company / Domain" value={record.company} />
        <FieldRow label="Role / Size" value={record.role} />
        <FieldRow label="LinkedIn" value={record.linkedin} href={record.linkedin} />
        <FieldRow label="Location" value={record.location} />
        <FieldRow label="Relationship group" value={record.tier} />
        <FieldRow label="Relationship" value={record.relationship} />
        <FieldRow label="Relevant" value={record.relevant} />
        <FieldRow label="Last interaction" value={formatDate(record.lastContactDate)} />
        <FieldRow label="Next interaction" value={formatDate(record.nextInteractionDate)} />

        <div className="border-b py-2.5">
          <div className="text-[10px] uppercase text-muted-foreground">Notes</div>
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-foreground">
            {record.notes || 'No Attio description or notes exposed for this record.'}
          </p>
        </div>

        <div className="py-2.5">
          <div className="text-[10px] uppercase text-muted-foreground">Other details from Attio</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {record.sourceAttributes.map((attribute) => (
              <span
                key={attribute}
                className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {attribute}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
