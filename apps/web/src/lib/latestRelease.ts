// The newest published release, for the version line under the download
// button. GitHub's latest-release page redirects to the release's tag, so
// the redirect alone names it. The REST API would too, but its anonymous
// limit is per IP, and Cloudflare's outgoing IPs are shared with other
// sites that use it up. Cached at the edge twice: a fresh copy so a new
// release shows up within minutes, and the last good one for when GitHub
// does not answer, so the line never drops out once it has been seen.

import { RELEASES } from "./platform";

const FRESH_URL = "https://prismoid-edge-cache.internal/latest-release/v2";
const LAST_GOOD_URL =
  "https://prismoid-edge-cache.internal/latest-release/v2/last-good";
const FRESH_SECONDS = 10 * 60;
const LAST_GOOD_SECONDS = 30 * 24 * 60 * 60;

export interface LatestRelease {
  version: string;
  url: string;
}

export async function loadLatestRelease(
  cache: Cache | undefined,
  fetcher: typeof fetch = fetch,
): Promise<LatestRelease | null> {
  const fresh = await read(cache, FRESH_URL);
  if (fresh) return fresh;

  const release = await fetchLatest(fetcher);
  if (!release) return read(cache, LAST_GOOD_URL);
  if (cache) {
    await Promise.all([
      write(cache, FRESH_URL, release, FRESH_SECONDS),
      write(cache, LAST_GOOD_URL, release, LAST_GOOD_SECONDS),
    ]);
  }
  return release;
}

async function fetchLatest(
  fetcher: typeof fetch,
): Promise<LatestRelease | null> {
  try {
    const res = await fetcher(`${RELEASES}/latest`, {
      method: "HEAD",
      redirect: "manual",
    });
    return parse(res.headers.get("Location"));
  } catch {
    return null;
  }
}

async function read(
  cache: Cache | undefined,
  url: string,
): Promise<LatestRelease | null> {
  const hit = await cache?.match(new Request(url));
  return hit ? ((await hit.json()) as LatestRelease) : null;
}

function write(
  cache: Cache,
  url: string,
  release: LatestRelease,
  seconds: number,
): Promise<void> {
  return cache.put(
    new Request(url),
    new Response(JSON.stringify(release), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, s-maxage=${seconds}`,
      },
    }),
  );
}

// Before the first release the redirect goes to the release list instead.
function parse(location: string | null): LatestRelease | null {
  const tag = location?.match(/\/releases\/tag\/v?([^/?#]+)$/);
  return tag ? { version: decodeURIComponent(tag[1]!), url: location! } : null;
}
