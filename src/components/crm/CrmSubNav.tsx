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
      className="flex rounded-full border border-[#ded9d1] bg-[#f1ede7] p-0.5 dark:border-[#3b3834] dark:bg-[#25231f]"
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
            className={`rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors ${
              active
                ? 'bg-[#fffdfa] text-foreground shadow-sm dark:bg-[#34312c]'
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
