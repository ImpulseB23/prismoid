// Builds the prismoid:// link the desktop app listens for from what Twitch
// put on the hosted redirect page: a granted token arrives in the URL
// fragment, a refusal in the query. Only the fields the app reads are
// forwarded.

export const DEEP_LINK = "prismoid://auth/twitch";

const FORWARDED = [
  "access_token",
  "state",
  "scope",
  "token_type",
  "error",
  "error_description",
];

export function deepLinkFor(hash: string, search: string): string | null {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const query = new URLSearchParams(search.replace(/^\?/, ""));
  const source = fragment.has("access_token")
    ? fragment
    : query.has("error")
      ? query
      : null;
  if (!source) return null;
  const out = new URLSearchParams();
  for (const key of FORWARDED) {
    const value = source.get(key);
    if (value !== null) out.set(key, value);
  }
  return `${DEEP_LINK}?${out}`;
}
