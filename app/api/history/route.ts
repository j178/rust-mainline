import {
  parseCommit,
  type GitHubCommit,
  type HistoryItem,
  type HistoryResponse,
} from "@/app/lib/history";
import { fetchGitHubJson } from "@/app/lib/github-api";
import {
  readCachedCommitBatch,
  writeCachedCommitBatch,
  type CachedCommitBatch,
} from "@/db";

const GITHUB_COMMITS_URL = "https://api.github.com/repos/rust-lang/rust/commits";
const MAX_BATCHES = 3;
const MAIN_CACHE_TTL_MS = 5 * 60 * 1000;
const MAIN_RESPONSE_CACHE_CONTROL = "no-store";
const IMMUTABLE_RESPONSE_CACHE_CONTROL = "public, max-age=31536000, immutable";

async function fetchGitHubCommitBatch(ref: string): Promise<GitHubCommit[]> {
  const url = new URL(GITHUB_COMMITS_URL);
  url.searchParams.set("sha", ref);
  url.searchParams.set("per_page", "100");
  return fetchGitHubJson<GitHubCommit[]>(url);
}

async function fetchCommitBatch(ref: string): Promise<CachedCommitBatch> {
  let cached = null;
  try {
    cached = await readCachedCommitBatch(ref);
  } catch (error) {
    console.warn("Unable to read the GitHub commit cache.", error);
  }

  if (cached && (ref !== "main" || Date.now() - cached.fetchedAt < MAIN_CACHE_TTL_MS)) {
    return cached;
  }

  try {
    const commits = await fetchGitHubCommitBatch(ref);
    const fetchedAt = Date.now();
    try {
      await writeCachedCommitBatch(ref, commits, fetchedAt);
    } catch (error) {
      console.warn("Unable to update the GitHub commit cache.", error);
    }
    return { commits, fetchedAt };
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

function isValidRef(ref: string) {
  return ref === "main" || /^[0-9a-f]{7,40}$/i.test(ref);
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const requestedRef = requestUrl.searchParams.get("sha") ?? "main";
  const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? 9);

  if (!isValidRef(requestedRef)) {
    return Response.json({ error: "Invalid commit reference." }, { status: 400 });
  }

  const limit = Math.max(1, Math.min(15, requestedLimit || 9));
  const items: HistoryItem[] = [];
  const traversed = new Set<string>();
  let cursor = requestedRef;
  let nextSha: string | null = null;

  try {
    batchLoop: for (let batchIndex = 0; batchIndex < MAX_BATCHES; batchIndex += 1) {
      const batch = (await fetchCommitBatch(cursor)).commits;
      if (batch.length === 0) break;

      const bySha = new Map(batch.map((commit) => [commit.sha, commit]));

      let current = bySha.get(cursor) ?? batch[0];

      while (current && !traversed.has(current.sha)) {
        traversed.add(current.sha);
        items.push(parseCommit(current));

        const parentSha = current.parents[0]?.sha ?? null;
        nextSha = parentSha;

        if (items.length >= limit || !parentSha) {
          break batchLoop;
        }

        const parent = bySha.get(parentSha);
        if (!parent) {
          cursor = parentSha;
          continue batchLoop;
        }

        current = parent;
      }

      break;
    }

    const payload: HistoryResponse = {
      items,
      nextSha,
    };

    return Response.json(payload, {
      headers: {
        "Cache-Control": requestedRef === "main"
          ? MAIN_RESPONSE_CACHE_CONTROL
          : IMMUTABLE_RESPONSE_CACHE_CONTROL,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load history.";
    return Response.json(
      { error: message },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
