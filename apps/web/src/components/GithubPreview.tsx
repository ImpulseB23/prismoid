import { createResource, createSignal, Show } from "solid-js";
import { query } from "@solidjs/router";
import "./GithubPreview.css";

const REPO = "ImpulseB23/Prismoid";
const REPO_URL = `https://github.com/${REPO}`;

// Cloudflare edge cache TTL. Cached at the PoP, shared across all visitors,
// so GitHub's unauthenticated 60/hr limit per IP never becomes the site's
// problem. We also fall back to stale data on any upstream error.
const EDGE_CACHE_SECONDS = 15 * 60;
const STALE_CACHE_SECONDS = 24 * 60 * 60;
const CACHE_URL = "https://prismoid-edge-cache.internal/gh-preview/v1";

interface RepoInfo {
  stars: number;
  openIssues: number;
  openPRs: number;
  lastCommitMsg: string;
  lastCommitSha: string;
  lastCommitAuthor: string;
  lastCommitTime: string;
}

async function readStale(
  cache: Cache | undefined,
  req: Request,
): Promise<RepoInfo | null> {
  if (!cache) return null;
  try {
    const hit = await cache.match(req);
    if (!hit) return null;
    return (await hit.json()) as RepoInfo;
  } catch {
    return null;
  }
}

const fetchRepoInfo = query(async (): Promise<RepoInfo | null> => {
  "use server";
  const edgeCache = (globalThis as unknown as { caches?: CacheStorage }).caches
    ?.default;
  const cacheReq = new Request(CACHE_URL);

  if (edgeCache) {
    const hit = await edgeCache.match(cacheReq);
    if (hit) {
      try {
        return (await hit.json()) as RepoInfo;
      } catch {
        // fall through to refetch on parse error
      }
    }
  }

  const headers = { "User-Agent": "prismoid-website" };
  try {
    const [repoRes, issuesRes, prsRes, commitsRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}`, { headers }),
      fetch(
        `https://api.github.com/repos/${REPO}/issues?state=open&per_page=100`,
        { headers },
      ),
      fetch(
        `https://api.github.com/repos/${REPO}/pulls?state=open&per_page=100`,
        { headers },
      ),
      fetch(`https://api.github.com/repos/${REPO}/commits?per_page=1`, {
        headers,
      }),
    ]);

    if (!repoRes.ok || !commitsRes.ok) return readStale(edgeCache, cacheReq);

    const repo = await repoRes.json();
    const issues = await issuesRes.json();
    const prs = await prsRes.json();
    const commits = await commitsRes.json();
    const latest = commits[0];

    if (!latest?.commit) return readStale(edgeCache, cacheReq);

    const data: RepoInfo = {
      stars: repo.stargazers_count ?? 0,
      openIssues: Array.isArray(issues)
        ? issues.filter((i: { pull_request?: unknown }) => !i.pull_request)
            .length
        : 0,
      openPRs: Array.isArray(prs) ? prs.length : 0,
      lastCommitMsg: latest.commit.message.split("\n")[0],
      lastCommitSha: latest.sha,
      lastCommitAuthor: latest.commit.author.name,
      lastCommitTime: timeAgo(new Date(latest.commit.author.date)),
    };

    if (edgeCache) {
      // Cache.put keeps the body for EDGE_CACHE_SECONDS, and we set a longer
      // browser Cache-Control so Cloudflare keeps a stale copy available
      // for the error-fallback path even after the fresh TTL expires.
      await edgeCache.put(
        cacheReq,
        new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, s-maxage=${EDGE_CACHE_SECONDS}, max-age=${STALE_CACHE_SECONDS}`,
          },
        }),
      );
    }
    return data;
  } catch {
    return readStale(edgeCache, cacheReq);
  }
}, "gh-preview");

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function GithubPreview(props: {
  children: any;
  href: string;
  class?: string;
  target?: string;
}) {
  const [show, setShow] = createSignal(false);
  const [info] = createResource(fetchRepoInfo);
  let timeout: number;

  const keepOpen = () => {
    clearTimeout(timeout);
  };

  const onButtonEnter = () => {
    clearTimeout(timeout);
    setShow(true);
  };

  const onLeave = () => {
    timeout = window.setTimeout(() => setShow(false), 300);
  };

  return (
    <span class="gh-preview-wrapper" onMouseLeave={onLeave}>
      <a
        href={props.href}
        class={props.class}
        target={props.target}
        rel={props.target === "_blank" ? "noopener" : undefined}
        onMouseEnter={onButtonEnter}
      >
        {props.children}
      </a>
      <Show when={show()}>
        <div class="gh-preview-bridge" onMouseEnter={keepOpen} />
      </Show>
      <Show when={show() && info()}>
        <div class="gh-preview-card" onMouseEnter={keepOpen}>
          <div class="gh-preview-stats">
            <a href={`${REPO_URL}/stargazers`} target="_blank" rel="noopener">
              &#9733; {info()!.stars}
            </a>
            <a href={`${REPO_URL}/pulls`} target="_blank" rel="noopener">
              {info()!.openPRs === 0
                ? "no PRs"
                : `${info()!.openPRs} ${info()!.openPRs === 1 ? "PR" : "PRs"}`}
            </a>
            <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener">
              {info()!.openIssues === 0
                ? "no issues"
                : `${info()!.openIssues} ${info()!.openIssues === 1 ? "issue" : "issues"}`}
            </a>
          </div>
          <div class="gh-preview-commit">
            <span class="gh-preview-label">latest commit</span>
            <a
              href={`${REPO_URL}/commit/${info()!.lastCommitSha}`}
              target="_blank"
              rel="noopener"
              class="gh-preview-msg"
            >
              {info()!.lastCommitMsg}
            </a>
            <span class="gh-preview-meta">
              {info()!.lastCommitAuthor} &middot; {info()!.lastCommitTime}
            </span>
          </div>
        </div>
      </Show>
    </span>
  );
}
