export type BuddyRoute = {
  model: "sonnet" | "opus";
  effort: "low" | "medium" | "high";
  reason: string;
};

const PLANNING_CUES = /\b(?:restructure|plan|strategy|prioritize|re-prioritize|review my|trade-off|tradeoff|think through|think hard|why|week|quarter|roadmap|goals|focus|organize|overwhelmed|decide|should i|help me figure)\b/i;
const SHORT_IMPERATIVE = /^(?:move|rename|add|mark|set|complete|delete|schedule|create|finish|push|bump|remind|check)\b/i;
const DIRECT_REPLAN = /\b(?:replan|re-plan|reshuffle|reprioritize|re-prioritize|restack|reorder|rework|reschedule)\b/i;
const DAY_SCOPE = /\b(?:today|my day|the day|this morning|my morning|this afternoon|my afternoon|the afternoon|tonight|my plan)\b/i;
const SCHEDULED_OBJECT_AFTER_DAY_SCOPE = /\b(?:(?:my|this|the)\s+(?:day|morning|afternoon)|today(?:'s)?)\s+(?:call|meeting|1:1|appointment|event)\b/i;
const URGENT_CHANGE = /\b(?:urgent|emergency|just came up|new thing|new priority|plans changed|day changed)\b/i;
const ARRANGEMENT = /\b(?:move|shift|fit|make room|push|priorit|order|schedule|plan|shuffle|stack)\w*\b/i;
const SEND_FEEDBACK = /^send\s+feedback(?:\s*:?\s*(.*))?$/i;
const FEEDBACK_PREFIX = /^feedback\s*:\s*(.*)$/i;

export type BuddyCommandIntent =
  | { kind: "replan" }
  | { kind: "feedback"; message: string };

export function detectBuddyCommandIntent(userText: string): BuddyCommandIntent | undefined {
  const text = userText.trim();
  const feedback = SEND_FEEDBACK.exec(text) ?? FEEDBACK_PREFIX.exec(text);
  if (feedback) return { kind: "feedback", message: feedback[1]?.trim() ?? "" };
  if (SCHEDULED_OBJECT_AFTER_DAY_SCOPE.test(text)) return undefined;
  if (
    (DIRECT_REPLAN.test(text) && DAY_SCOPE.test(text)) ||
    (DAY_SCOPE.test(text) && URGENT_CHANGE.test(text) && ARRANGEMENT.test(text))
  ) {
    return { kind: "replan" };
  }
  return undefined;
}

export function routeBuddyTurn(
  userText: string,
  _pageContext?: unknown,
  override?: "fast" | "deep",
): BuddyRoute {
  if (override === "deep") return { model: "opus", effort: "high", reason: "Deep override" };
  if (override === "fast") return { model: "sonnet", effort: "low", reason: "Fast override" };

  const text = userText.trim();
  if (/^CONFIRM_DELETE\b/i.test(text)) {
    return { model: "sonnet", effort: "low", reason: "Confirmed delete" };
  }
  const questionCount = text.match(/\?/g)?.length ?? 0;
  if (text.length > 400) return { model: "opus", effort: "high", reason: "Long request" };
  if (questionCount >= 2) return { model: "opus", effort: "high", reason: "Multiple questions" };
  if (PLANNING_CUES.test(text)) return { model: "opus", effort: "high", reason: "Planning request" };
  if (text.length < 140 && SHORT_IMPERATIVE.test(text)) {
    return { model: "sonnet", effort: "low", reason: "Short action" };
  }
  return { model: "sonnet", effort: "medium", reason: "General conversation" };
}
