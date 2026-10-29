import { describe, expect, it, vi } from "vitest";
import { loadLatestRelease } from "./latestRelease";

const tagUrl = "https://github.com/ImpulseB23/Prismoid/releases/tag/v0.8.5";
const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { Location: location } });

function memoryCache(): Cache {
  const store = new Map<string, Response>();
  return {
    match: async (req: Request) => store.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => {
      store.set(req.url, res);
    },
  } as unknown as Cache;
}

describe("loadLatestRelease", () => {
  it("reads the version from the latest-release redirect and caches it", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () => redirect(tagUrl));
    expect(await loadLatestRelease(cache, fetcher)).toEqual({
      version: "0.8.5",
      url: tagUrl,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://github.com/ImpulseB23/Prismoid/releases/latest",
      { method: "HEAD", redirect: "manual" },
    );
    expect(await loadLatestRelease(cache, fetcher)).toMatchObject({
      version: "0.8.5",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps showing the last good version when GitHub stops answering", async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (req: Request) => store.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => {
        store.set(req.url, res);
      },
    } as unknown as Cache;
    await loadLatestRelease(cache, async () => redirect(tagUrl));
    // The fresh copy has expired at the edge; the last good one has not.
    for (const key of store.keys()) {
      if (!key.endsWith("/last-good")) store.delete(key);
    }
    const down = async () => new Response("", { status: 403 });
    expect(await loadLatestRelease(cache, down)).toEqual({
      version: "0.8.5",
      url: tagUrl,
    });
  });

  it("shows nothing without a release or when GitHub fails", async () => {
    const list = async () =>
      redirect("https://github.com/ImpulseB23/Prismoid/releases");
    expect(await loadLatestRelease(memoryCache(), list)).toBeNull();
    const down = async () => new Response("", { status: 503 });
    expect(await loadLatestRelease(undefined, down)).toBeNull();
    const offline = async () => {
      throw new TypeError("network");
    };
    expect(await loadLatestRelease(undefined, offline)).toBeNull();
  });
});
