'use client';

import BuddyLauncher from './BuddyLauncher';
import BuddyPanel from './BuddyPanel';

export default function BuddyDock() {
  return (
    <div data-buddy-root>
      <BuddyPanel />
      <BuddyLauncher />
    </div>
  );
}
