'use client';

import type { ReceiptChange } from '@/lib/buddy/receipts';

const tones: Record<ReceiptChange['action'], string> = {
  insert: 'border-accent-green/25 bg-accent-green/10',
  update: 'border-accent-blue/25 bg-accent-blue/10',
  delete: 'border-accent-red/25 bg-accent-red/10',
};

export default function ReceiptChips({ changes }: { changes: ReceiptChange[] }) {
  if (!changes.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {changes.map((change, index) => (
        <span
          key={`${change.table}:${change.id}:${change.action}:${index}`}
          className={`inline-flex rounded-full border px-2 py-1 text-[11px] leading-tight text-foreground ${tones[change.action]}`}
        >
          ✓ {change.summary}
        </span>
      ))}
    </div>
  );
}
