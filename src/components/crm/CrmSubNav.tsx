'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/crm', label: 'People', exact: true },
  { href: '/crm/pipeline', label: 'Pipeline', exact: false },
] as const;

export default function CrmSubNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Relationship views"
      className="flex rounded-full border bg-muted p-0.5"
    >
      {ITEMS.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`press-scale rounded-full px-3 py-1.5 text-[11.5px] font-medium outline-none transition-[color,background-color,box-shadow] duration-150 ease-[var(--ease-out-cove)] focus-visible:ring-2 focus-visible:ring-accent-blue/40 ${
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
