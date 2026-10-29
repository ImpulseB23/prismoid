import { describe, expect, it, vi } from "vitest";
import { loadLatestRelease } from "./latestRelease";

const release = {
  tag_name: "v0.8.5",
  html_url: "https://github.com/ImpulseB23/Prismoid/releases/tag/v0.8.5",
};

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
  it("reads the version from the release tag and caches it", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () => Response.json(release));
    expect(await loadLatestRelease(cache, fetcher)).toEqual({
      version: "0.8.5",
      url: release.html_url,
    });
    expect(await loadLatestRelease(cache, fetcher)).toMatchObject({
      version: "0.8.5",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("shows nothing when GitHub fails", async () => {
    const down = async () => new Response("", { status: 403 });
    expect(await loadLatestRelease(memoryCache(), down)).toBeNull();
    const offline = async () => {
      throw new TypeError("network");
    };
    expect(await loadLatestRelease(undefined, offline)).toBeNull();
    const odd = async () => Response.json({ message: "Not Found" });
    expect(await loadLatestRelease(undefined, odd)).toBeNull();
  });
});
