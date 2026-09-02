export function isBlockedTag(tag: string): boolean {
  return tag.trim().toLowerCase() === "blocked";
}

export function visibleTags(tags: string[]): string[] {
  return tags.filter((tag) => !isBlockedTag(tag));
}

export function tagsWithBlockedFlag(tags: string[], blocked: boolean): string[] {
  const visible = visibleTags(tags);
  return blocked ? [...visible, "blocked"] : visible;
}
