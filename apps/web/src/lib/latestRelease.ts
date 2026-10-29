// The newest published release, for the version line under the download
// button. It is cached at the Cloudflare edge like the GitHub preview, but
// for less time so a new release shows up soon after it is published.

const API = "https://api.github.com/repos/ImpulseB23/Prismoid/releases/latest";
const CACHE_URL = "https://prismoid-edge-cache.internal/latest-release/v1";
const EDGE_CACHE_SECONDS = 10 * 60;

export interface LatestRelease {
  version: string;
  url: string;
}

export async function loadLatestRelease(
  cache: Cache | undefined,
  fetcher: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  const req = new Request(CACHE_URL);
  const hit = await cache?.match(req);
  if (hit) return (await hit.json()) as LatestRelease;

  try {
    const res = await fetcher(API, {
      headers: { "User-Agent": "prismoid-website" },
    });
    if (!res.ok) return null;
    const release = parse(await res.json());
    if (release && cache) {
      await cache.put(
        req,
        new Response(JSON.stringify(release), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, s-maxage=${EDGE_CACHE_SECONDS}`,
          },
        }),
      );
    }
    return release;
  } catch {
    return null;
  }
}

function parse(body: unknown): LatestRelease | null {
  const { tag_name: tag, html_url: url } = (body ?? {}) as {
    tag_name?: unknown;
    html_url?: unknown;
  };
  if (typeof tag !== "string" || typeof url !== "string") return null;
  return { version: tag.replace(/^v/, ""), url };
}
