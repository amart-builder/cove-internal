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
    <div className="water-field-row border-b py-3 last:border-b-0">
      <div className="water-detail-label">{label}</div>
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
    <div className="water-detail-panel flex h-full flex-col">
      <div className="water-detail-heading border-b p-4">
        <div className="flex items-start gap-3">
          <div className="water-avatar flex h-10 w-10 shrink-0 items-center justify-center text-xs font-semibold">
            {getInitials(record.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm">
                {record.name}
              </h2>
              <span className="water-pill px-2 py-0.5">
                {record.objectType === 'people' ? 'Person' : 'Company'}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {[record.role, record.company].filter(Boolean).join(' at ') || 'Attio record'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="water-secondary-button flex h-7 w-7 items-center justify-center text-lg leading-none"
            aria-label="Close details"
          >
            &times;
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {record.tags.slice(0, 8).map((tag) => (
            <span
              key={tag}
              className="water-pill px-2 py-0.5"
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
            className="water-primary-button mt-3 inline-flex px-4 py-1.5"
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

        <div className="water-field-row border-b py-3">
          <div className="water-detail-label">Notes</div>
          <p className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-foreground">
            {record.notes || 'No Attio description or notes exposed for this record.'}
          </p>
        </div>

        <div className="py-2.5">
          <div className="water-detail-label">Other details from Attio</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {record.sourceAttributes.map((attribute) => (
              <span
                key={attribute}
                className="water-pill px-2 py-0.5"
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
