export function normalizeContactEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function normalizeContactName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .trim()
    .replace(/\s+/g, " ");
}

function containsNonLatinLetter(value: string): boolean {
  return Array.from(value).some(
    (character) =>
      /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character),
  );
}

export function isPlausibleFullName(
  value: string,
  options: { explicit?: boolean } = {},
): boolean {
  const tokens = normalizeContactName(value).split(" ").filter(Boolean);
  if (tokens.length === 0 || !tokens.every((token) => /\p{L}/u.test(token))) {
    return false;
  }
  if (tokens.length >= 2) return true;
  return options.explicit === true || containsNonLatinLetter(tokens[0]);
}
