'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getRuntimeMode, type RuntimeMode } from '@/lib/runtime/mode';
import {
  TASK_WORKSPACE_VIEW_EVENT,
  announceTaskWorkspaceView,
  requestedTaskWorkspaceView,
  type TaskWorkspaceView,
} from '@/components/tasks/task-workspace-view';

const baseTabs = [
  { name: 'Today', href: '/tasks' },
  { name: 'People', href: '/crm' },
];

export function tabNavItems(runtimeMode: RuntimeMode) {
  return runtimeMode === 'local'
    ? [...baseTabs, { name: 'Issues', href: '/failures' }]
    : baseTabs;
}

export function preferredDarkTheme(
  storedTheme: string | null,
  systemPrefersDark: boolean,
): boolean {
  return storedTheme === 'dark' || (!storedTheme && systemPrefersDark);
}

export function shouldAutoHideMainNav(pathname: string, taskView: TaskWorkspaceView): boolean {
  return pathname === '/tasks' && taskView === 'today';
}

export default function TabNav() {
  const pathname = usePathname();
  const runtimeMode = getRuntimeMode();
  const tabs = tabNavItems(runtimeMode);
  const quietCurrentAvailable = runtimeMode !== 'convex';
  // Must start false so the server and the first client render agree; reading
  // the theme here instead would fail hydration for anyone in dark mode. The
  // pre-paint script in the root layout owns the <html> class, and the icons
  // below follow it through CSS, so this state only drives the label and toggle.
  const [dark, setDark] = useState(false);
  const [taskView, setTaskView] = useState<TaskWorkspaceView>(
    quietCurrentAvailable ? 'today' : 'all-work',
  );
  const [visible, setVisible] = useState(true);
  const autoHide = shouldAutoHideMainNav(pathname, taskView);
  const barVisible = !autoHide || visible;
  const navRef = useRef<HTMLElement>(null);
  const hideTimerRef = useRef<number | undefined>(undefined);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === undefined) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = undefined;
  }, []);

  const showBar = useCallback(() => {
    clearHideTimer();
    setVisible(true);
  }, [clearHideTimer]);

  const scheduleHide = useCallback((delay: number) => {
    clearHideTimer();
    if (!autoHide) return;
    hideTimerRef.current = window.setTimeout(() => {
      const nav = navRef.current;
      if (
        nav?.contains(document.activeElement) ||
        nav?.querySelector('details[open], [role="dialog"], [aria-expanded="true"]')
      ) {
        hideTimerRef.current = undefined;
        return;
      }
      setVisible(false);
      hideTimerRef.current = undefined;
    }, delay);
  }, [autoHide, clearHideTimer]);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDark(preferredDarkTheme(
        localStorage.getItem('theme'),
        matchMedia('(prefers-color-scheme: dark)').matches,
      ));
    } catch {
      // localStorage throws in some privacy modes; the light default stands.
    }
  }, []);

  useEffect(() => {
    const requested = requestedTaskWorkspaceView(
      window.location.search,
      quietCurrentAvailable,
    );
    const update = requested
      ? window.setTimeout(() => setTaskView(requested), 0)
      : undefined;
    const handleView = (event: Event) => {
      setTaskView((event as CustomEvent<TaskWorkspaceView>).detail);
    };
    window.addEventListener(TASK_WORKSPACE_VIEW_EVENT, handleView);
    return () => {
      if (update !== undefined) window.clearTimeout(update);
      window.removeEventListener(TASK_WORKSPACE_VIEW_EVENT, handleView);
    };
  }, [quietCurrentAvailable]);

  useEffect(() => {
    scheduleHide(2500);
    return clearHideTimer;
  }, [clearHideTimer, scheduleHide]);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  return (
    <>
    {autoHide && <div
      className="fixed inset-x-0 top-0 z-[129] h-6"
      aria-hidden="true"
      onMouseEnter={showBar}
      onMouseLeave={() => scheduleHide(700)}
    />}
    {!barVisible && (
      <button
        type="button"
        aria-label="Show main navigation"
        aria-controls="cove-main-navigation"
        aria-expanded={false}
        className="fixed left-1/2 top-0 z-[130] flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-b-xl border border-t-0 bg-background px-4 text-xs font-medium text-muted-foreground shadow-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        onClick={() => {
          showBar();
          // The handle unmounts when opened. Move keyboard focus into the bar
          // rather than dropping it onto the document body.
          window.requestAnimationFrame(() => {
            navRef.current?.querySelector<HTMLAnchorElement>('a')?.focus();
          });
        }}
      >
        Menu
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
    )}
    <nav
      id="cove-main-navigation"
      inert={!barVisible}
      aria-hidden={!barVisible}
      ref={navRef}
      className={`quiet-main-nav fixed inset-x-0 top-0 z-[130] grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b px-4 transition-[translate,opacity] duration-[350ms] ease-[cubic-bezier(.22,.8,.25,1)] motion-reduce:translate-none motion-reduce:duration-150 sm:px-6 ${
        barVisible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0'
      }`}
      aria-label="Main navigation"
      onMouseEnter={showBar}
      onMouseLeave={() => scheduleHide(700)}
      onFocusCapture={showBar}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) scheduleHide(700);
      }}
    >
      <div className="flex h-full min-w-0 items-center gap-1">
      <span className="mr-4 flex items-center gap-2 text-[13.5px] font-[650] tracking-[-0.012em] text-foreground sm:mr-7">
        <span className="quiet-cove-mark" aria-hidden="true" />
        Cove
      </span>
      <div className="flex items-center h-full">
        {tabs.map((tab) => {
          const isActive = pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`relative flex h-full items-center px-3 text-[13.5px] font-medium transition-colors duration-150 ${
                isActive
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              {tab.name}
              {isActive && (
                <span className="absolute bottom-0 left-2 right-2 h-px rounded-full bg-foreground" />
              )}
            </Link>
          );
        })}
      </div>
      </div>
      {pathname.startsWith('/tasks') ? (
        <div
          className="quiet-segmented-control flex items-center rounded-full p-1"
          role="group"
          aria-label="Task view"
        >
          <button
            type="button"
            aria-pressed={taskView === 'today'}
            disabled={!quietCurrentAvailable}
            onClick={() => announceTaskWorkspaceView('today')}
            className={`quiet-segment ${taskView === 'today' ? 'is-active' : ''}`}
          >
            Today
          </button>
          <button
            type="button"
            aria-pressed={taskView === 'all-work'}
            onClick={() => announceTaskWorkspaceView('all-work')}
            className={`quiet-segment ${taskView === 'all-work' ? 'is-active' : ''}`}
          >
            All Work
          </button>
        </div>
      ) : <span />}
      <div className="ml-auto flex items-center gap-2 justify-self-end">
        <Link
          href="/guide"
          className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
            pathname.startsWith('/guide')
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          aria-current={pathname.startsWith('/guide') ? 'page' : undefined}
        >
          Guide
        </Link>
        <button
          onClick={toggleTheme}
          className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-150"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {/* Both icons always render and CSS picks one, so the markup never
              depends on a theme the server cannot know. */}
          <svg className="hidden dark:block" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <svg className="block dark:hidden" aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>
      </div>
    </nav>
    </>
  );
}
