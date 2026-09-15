import { localDateLabel } from "./planning-dates";

// Clock values in generated prose are references, not a second independently
// authored schedule. Old stored prose is deliberately outside this boundary.
const clockPattern = /\b(?:(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:\s*[ap]\.?m\.?)?|(?:1[0-2]|0?[1-9])\s*[ap]\.?m\.?|noon|midnight)\b/gi;
type Timed = { nextCheckAt: string; plannedFor?: string | null; expiresAt?: string };

export function planningTimeReferences(contextText: string, sourcePrompt: string): { timeZone: string; labels: string[] } {
  let view: Record<string, unknown> = {};
  try { view = JSON.parse(contextText); } catch { /* Legacy/test context may be empty. */ }
  const timeZone = typeof view.timeZone === "string" ? view.timeZone : "UTC";
  const labels = new Set<string>();
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string") {
      if (key.endsWith("Local") && !/^(Invalid|Unlabelled)/.test(value)) labels.add(value);
      // Quoted source clock wording is not proof of a current booking. The
      // caller supplies that distinction separately in the planning contract.
      for (const match of value.matchAll(clockPattern)) {
        if (!/[T+\d:-]/.test(value[(match.index ?? 0) - 1] ?? "")) labels.add(match[0]);
      }
    } else if (Array.isArray(value)) value.forEach(item => visit(item));
    else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => visit(item, name));
  };
  visit(view);
  visit(sourcePrompt);
  return { timeZone, labels: [...labels] };
}

export function renderPlanningTimeText(
  paragraphs: string[],
  actions: Timed[],
  questions: Timed[],
  sources: ReturnType<typeof planningTimeReferences>,
  options: { allowSourceClocks?: boolean } = {},
): string[] {
  const normalizeClock = (value: string) => value.toLowerCase().replace(/[.\s]/g, "");
  const sourceClocks = new Set(sources.labels.flatMap(label => [...label.matchAll(clockPattern)].map(match => normalizeClock(match[0]))));
  return paragraphs.map(paragraph => {
    if (/\b(?:I|we|Cove)(?:\s+will|[’']ll)\s+(?:(?:automatically|also|then|continue\s+to)\s+)*(?:check|review|monitor|watch|notify|remind|surface|track|follow\s+up)\b/i.test(paragraph)) {
      throw new Error("planning_unactivated_follow_through_claim");
    }
    if (/\b(?:treat|consider|regard)\b[^.!?]{0,160}\b(?:as|the)\s+(?:(?:the|only|an?)\s+)*active\s+(?:check|watch|reminder|monitoring)\b/i.test(paragraph)) {
      throw new Error("planning_unactivated_follow_through_claim");
    }
    let remaining = paragraph.replace(/\{\{(?:time\.\d+|(?:action|question)\.\d+\.(?:nextCheckAt|plannedFor|expiresAt))\}\}/g, "");
    // Exact copies of a supplied full local date label have already been
    // formatted by Cove. Do not discard a correct brief merely for quoting one.
    for (const label of sources.labels) {
      if (/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),/.test(label)) {
        remaining = remaining.replaceAll(label, "");
      }
    }
    const literalClocks = remaining.match(clockPattern) ?? [];
    if (literalClocks.some(clock => !options.allowSourceClocks || !sourceClocks.has(normalizeClock(clock)))) {
      throw new Error("planning_prose_clock_requires_reference");
    }
    const rendered = paragraph.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) => {
      const source = /^time\.(\d+)$/.exec(key);
      if (source) {
        const label = sources.labels[Number(source[1]) - 1];
        if (!label) throw new Error("planning_time_reference_unavailable");
        return label;
      }
      const generated = /^(action|question)\.(\d+)\.(nextCheckAt|plannedFor|expiresAt)$/.exec(key);
      if (!generated) throw new Error("planning_time_reference_invalid");
      const [, kind, position, field] = generated;
      const row = (kind === "action" ? actions : questions)[Number(position) - 1];
      const value = row?.[field as keyof Timed];
      if (!value) throw new Error("planning_time_reference_unavailable");
      const label = localDateLabel(value, sources.timeZone);
      if (!label || /^(Invalid|Unlabelled)/.test(label)) throw new Error("planning_time_reference_invalid");
      return label;
    });
    if (rendered.includes("{{") || rendered.includes("}}")) throw new Error("planning_time_reference_invalid");
    return rendered;
  });
}
