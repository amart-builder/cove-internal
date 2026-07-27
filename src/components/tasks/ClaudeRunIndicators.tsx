'use client';

import { useEffect, useState } from 'react';
import type { DayPlanExecutionMode, DayPlanExecutionRunStatus } from '@/lib/day-plan/types';
import { claudeResumeUrl, executionRunStatusLabel } from '@/lib/day-plan/presentation';

// Non-interactive status pill. Rendered as a <span> so it can live inside a <button>
// (downstream node, shelf entry) without nesting interactive controls.
export function RunStatusChip({
  status,
  label,
  className = '',
}: {
  status: DayPlanExecutionRunStatus;
  label?: string;
  className?: string;
}) {
  const tone = status === 'failed'
    ? 'border-accent-red/30 bg-accent-red/10 text-accent-red'
    : status === 'plan_ready' || status === 'ready_to_join' || status === 'awaiting_review'
      ? 'border-accent-blue/50 bg-accent-blue/15 text-foreground'
      : status === 'running'
        ? 'border-accent-blue/40 bg-accent-blue/10 text-foreground'
        : 'border-border/70 bg-muted/60 text-muted-foreground';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium leading-none ${tone} ${className}`}
    >
      {label ?? executionRunStatusLabel(status)}
    </span>
  );
}

// Opens the resulting Claude session in the desktop app via its custom protocol. Custom
// protocols have no completion callback, so this never mutates run state and never claims
// the app opened.
export function OpenInClaudeCode({
  sessionId,
  mode,
  title,
  label = 'Open in Claude Code',
  resumeCommand,
  className = '',
}: {
  sessionId: string;
  mode?: DayPlanExecutionMode;
  title?: string;
  label?: string;
  resumeCommand?: string;
  className?: string;
}) {
  const [showCopyFallback, setShowCopyFallback] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!showCopyFallback) return;
    const timer = window.setTimeout(() => {
      setShowCopyFallback(false);
      setCopied(false);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [showCopyFallback]);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        title="Opens Claude Code"
        className={`min-h-9 shrink-0 rounded-lg border border-accent-blue/50 bg-accent-blue/10 px-3 text-xs font-semibold text-foreground transition-[background-color,transform] duration-150 ease-[var(--ease-out-forge)] hover:bg-accent-blue/20 active:scale-[0.97] motion-reduce:transform-none motion-reduce:transition-none ${className}`}
        aria-label={title ? `Open ${title} in Claude Code` : 'Open in Claude Code'}
        onClick={() => {
          setShowCopyFallback(Boolean(resumeCommand));
          setCopied(false);
          window.location.href = claudeResumeUrl(sessionId);
        }}
      >
        {label}
      </button>
      {mode === 'plan_review' && (
        <span className="max-w-72 text-left text-[10px] leading-relaxed text-muted-foreground">
          Opens in the app&apos;s default mode. Switch the mode picker to Plan to review changes before they happen.
        </span>
      )}
      {showCopyFallback && resumeCommand && (
        <button
          type="button"
          className="text-left text-[10px] font-medium text-muted-foreground underline decoration-dotted underline-offset-2"
          onClick={() => {
            void navigator.clipboard.writeText(resumeCommand).then(() => {
              setCopied(true);
            }).catch(() => setCopied(false));
          }}
        >
          {copied ? 'Resume command copied' : "Didn't open? Copy resume command"}
        </button>
      )}
    </span>
  );
}
