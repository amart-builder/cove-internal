export function isClaudeNotSignedIn(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return normalized.includes('not logged in') || normalized.includes('please run /login');
}
