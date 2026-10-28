// Decides whether a message should be highlighted: it mentions the
// signed-in user (an @handle or the bare login as its own word) or
// contains one of their highlight phrases. Case insensitive.

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsLogin(text: string, login: string): boolean {
  if (!login) return false;
  return new RegExp(`(^|[^a-z0-9_])@?${escape(login)}(?![a-z0-9_])`, "i").test(
    text,
  );
}

export function matchesPhrase(text: string, phrases: string[]): boolean {
  if (phrases.length === 0) return false;
  const lower = text.toLowerCase();
  return phrases.some((p) => p && lower.includes(p.toLowerCase()));
}

export function isHighlighted(
  text: string,
  login: string,
  phrases: string[],
): boolean {
  return mentionsLogin(text, login) || matchesPhrase(text, phrases);
}

/** The sender is someone the user always wants to see: a listed login or a holder of a listed badge. */
export function isSpotlit(
  login: string,
  badges: { set_id: string }[],
  users: string[],
  badgeSets: string[],
): boolean {
  return (
    users.includes(login) || badges.some((b) => badgeSets.includes(b.set_id))
  );
}
