'use client';

import { useEffect, useRef, useState } from 'react';
import { useBuddy } from './BuddyProvider';

export function BuddyGlyph({ className = '', mood = 'smile' }: {
  className?: string;
  mood?: 'smile' | 'frown';
}) {
  return (
    <svg className={className} viewBox="0 0 64 72" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="buddy-water" x1="12" y1="8" x2="54" y2="66">
          <stop stopColor="#8ed8ff" />
          <stop offset="1" stopColor="#318ee2" />
        </linearGradient>
      </defs>
      <path d="M32 3C26 16 9 29 9 46c0 14 10 23 23 23s23-9 23-23C55 29 38 16 32 3Z" fill="url(#buddy-water)" stroke="rgba(255,255,255,.78)" strokeWidth="1.5" />
      <ellipse cx="23" cy="24" rx="5" ry="8" fill="rgba(255,255,255,.38)" transform="rotate(28 23 24)" />
      <g className="buddy-eyes" fill="#153f62">
        <circle cx="25" cy="45" r="2.2" />
        <circle cx="39" cy="45" r="2.2" />
      </g>
      <path d={mood === 'frown' ? 'M27 57q5-5 10 0' : 'M27 53q5 5 10 0'} fill="none" stroke="#153f62" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function BuddyLauncher() {
  const { open, setOpen, turns, busy } = useBuddy();
  const [drooping, setDrooping] = useState(false);
  const lastSeenFailedIdRef = useRef<string | null | undefined>(undefined);
  const lastTurn = turns.at(-1);
  const lastTurnId = lastTurn?.id;
  const lastFailed = lastTurn?.state === 'failed';

  useEffect(() => {
    if (!lastTurnId) return;
    if (lastSeenFailedIdRef.current === undefined) {
      lastSeenFailedIdRef.current = lastFailed ? lastTurnId : null;
      return;
    }
    if (!lastFailed || lastSeenFailedIdRef.current === lastTurnId) return;
    lastSeenFailedIdRef.current = lastTurnId;
    const startTimer = window.setTimeout(() => setDrooping(true), 0);
    const endTimer = window.setTimeout(() => setDrooping(false), 3000);
    return () => {
      window.clearTimeout(startTimer);
      window.clearTimeout(endTimer);
    };
  }, [lastFailed, lastTurnId]);

  const stateClass = drooping ? 'buddy-droop' : busy ? 'buddy-working' : 'buddy-idle';
  return (
    <>
      <button
        type="button"
        aria-label={open ? 'Close Buddy chat' : 'Open Buddy chat'}
        aria-expanded={open}
        className={`press-scale fixed bottom-4 right-4 z-[120] grid size-14 place-items-center rounded-full drop-shadow-[0_10px_18px_rgba(37,112,176,.28)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-blue ${stateClass} ${open ? 'buddy-open' : ''}`}
        onClick={() => setOpen((current) => !current)}
      >
        <BuddyGlyph className="h-[62px] w-14 overflow-visible" mood={drooping ? 'frown' : 'smile'} />
      </button>
      <style>{`
        @keyframes buddy-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
        @keyframes buddy-blink { 0%,94%,100% { transform: scaleY(1) } 96% { transform: scaleY(.08) } }
        @keyframes buddy-work { 0%,100% { transform: scale(1,1) } 50% { transform: scale(1.12,.86) translateY(4px) } }
        @keyframes buddy-droop { 0%,100% { transform: scale(1) } 20%,75% { transform: scale(1.1,.78) translateY(6px) rotate(3deg) } }
        .buddy-idle svg { animation: buddy-bob 3s ease-in-out infinite; }
        .buddy-idle .buddy-eyes { transform-origin: 32px 45px; animation: buddy-blink 5.4s ease-in-out infinite; }
        .buddy-working svg { animation: buddy-work .85s ease-in-out infinite; transform-origin: 32px 64px; }
        .buddy-working .buddy-eyes, .buddy-open .buddy-eyes { transform: translateY(-2px); }
        .buddy-droop svg { animation: buddy-droop 3s var(--ease-out-forge) both; transform-origin: 32px 64px; }
        @media (prefers-reduced-motion: reduce) {
          .buddy-idle svg, .buddy-idle .buddy-eyes, .buddy-working svg, .buddy-droop svg { animation: none; transform: none; }
        }
      `}</style>
    </>
  );
}
