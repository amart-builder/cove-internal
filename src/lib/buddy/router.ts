export type BuddyRoute = {
  model: "sonnet" | "opus";
  effort: "low" | "medium" | "high";
  reason: string;
};

const PLANNING_CUES = /\b(?:restructure|plan|strategy|prioritize|re-prioritize|review my|trade-off|tradeoff|think through|think hard|why|week|quarter|roadmap|goals|focus|organize|overwhelmed|decide|should i|help me figure)\b/i;
const SHORT_IMPERATIVE = /^(?:move|rename|add|mark|set|complete|delete|schedule|create|finish|push|bump|remind|check)\b/i;

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
