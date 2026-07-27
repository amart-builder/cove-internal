'use client';

import BuddyLauncher from './BuddyLauncher';
import BuddyPanel from './BuddyPanel';

export default function BuddyDock() {
  return (
    <>
      <BuddyPanel />
      <BuddyLauncher />
      <style>{`
        @keyframes buddy-shimmer { 0%,100% { opacity: .38 } 50% { opacity: .85 } }
        .buddy-thinking { animation: buddy-shimmer 1.2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .buddy-thinking { animation: none; } }
      `}</style>
    </>
  );
}
