/**
 * Reading files out of a GitHub repository — the API client, and nothing else.
 *
 * A repository is the third kind of folder the app can list, after a folder on the user's disk and
 * the bundled `samples` (`state/diskFolders.ts`, `lib/samples.ts`). It behaves like the samples
 * folder rather than like the disk: files are **fetched, and what you open is a copy**, because
 * there is no writing back — this app has no commit, no branch and no push, and pretending
 * otherwise would mean an edit silently living in one browser while the repo went on saying
 * something else. `state/githubRepos.ts` owns which repositories the app knows about and what they
 * are labelled; this module owns the two questions the network can answer.
 *
 * **Two calls, both to `/repos/{owner}/{repo}/contents/{path}`**, which is the one endpoint that
 * answers both of them:
 *
 * - with `Accept: application/vnd.github+json` it lists one directory level — the same shape
 *   `listDirectory` gives for a folder on disk, and the same promise: **one level, never a walk.**
 *   A repo of runs is listed as it is opened, not scanned up front (the Git trees API could fetch
 *   the whole tree in one call, and is deliberately not used: a repository is somebody's whole
 *   history, and this app only ever needs the directory in front of the user).
 * - with `Accept: application/vnd.github.raw` it returns the file's bytes directly, up to 100 MB.
 *   The JSON form of the same call carries base64 `content` instead, but only below 1 MB — which a
 *   `.zpcr` run archive can exceed — so the raw form is the one that works for every file the app
 *   can open.
 *
 * **The token, when there is one, goes in a header** (`state/githubToken.ts` holds it). That is
 * what reaches a private repository, and it is also what raises the rate limit from GitHub's
 * 60 requests an hour for anonymous callers to 5,000 — worth knowing, because 60 an hour is few
 * enough that browsing a repo by hand can reach it, and {@link GithubError} says so when it does.
 */

/** A repository, and optionally the branch, tag or commit to read it at. */
export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit SHA. Absent means the repository's default branch. */
  ref?: string;
}

/** One row of a directory listing — shaped like `diskFolders.ts`'s `DiskEntry` on purpose, since
 * the same component draws a repository's files and a disk folder's. There is no modification
 * time: the API's listing doesn't carry one, and getting it would mean a commits query per file. */
export interface RepoEntry {
  name: string;
  kind: "file" | "directory";
  /** Files only. */
  size?: number;
}

/** A failed GitHub request, carrying the HTTP status so a caller can tell "no such file" from
 * "not allowed" — and a `message` already written for a human to read. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

const API = "https://api.github.com";

/**
 * Parse `owner/repo`, or `owner/repo@ref` for a branch, tag or commit — the form the `#github=`
 * link carries, and the form a person would type.
 *
 * `null` for anything that isn't two non-empty path segments, which is how a mistyped link is
 * reported rather than turned into a request that would 404 much later.
 */
export function parseRepoSpec(spec: string): RepoRef | null {
  const trimmed = spec.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return null;
  const at = trimmed.indexOf("@");
  const ref = at === -1 ? undefined : trimmed.slice(at + 1) || undefined;
  const parts = (at === -1 ? trimmed : trimmed.slice(0, at)).split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return ref ? { owner, repo, ref } : { owner, repo };
}

/** The `owner/repo[@ref]` string {@link parseRepoSpec} reads — what a link carries and what the
 * folder's heading says it is showing. */
export function formatRepoSpec(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}${repo.ref ? `@${repo.ref}` : ""}`;
}

function contentsUrl(repo: RepoRef, path: readonly string[]): string {
  const encoded = path.map(encodeURIComponent).join("/");
  const query = repo.ref ? `?ref=${encodeURIComponent(repo.ref)}` : "";
  return `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${encoded}${query}`;
}

async function request(url: string, accept: string, token: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  // Bearer rather than the URL: a token in a query string ends up in logs and history, and the
  // header is what GitHub documents for a fine-grained PAT.
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    // `credentials: "omit"` for the same reason `#load=` uses it: the repository comes from a
    // link, and a link must not be able to spend the recipient's cookies.
    res = await fetch(url, { headers, credentials: "omit" });
  } catch {
    // A network-level failure has no status and no body worth quoting — offline, DNS, CORS.
    throw new GithubError("couldn't reach GitHub — check the network connection", 0);
  }
  if (!res.ok) throw new GithubError(await describeFailure(res, token), res.status);
  return res;
}

/**
 * What went wrong, said in a sentence the person reading it can act on.
 *
 * GitHub's own `message` is usually good ("Not Found", "Bad credentials"), but the two failures
 * this app actually provokes deserve better than it: an exhausted anonymous rate limit (which
 * arrives as a 403 about "API rate limit exceeded for <ip>") and a private repository seen without
 * a token (which arrives, deliberately, as an ordinary 404 — GitHub does not admit that a private
 * repo exists). Both have the same fix, and it is a fix the app can name.
 */
async function describeFailure(res: Response, token: string): Promise<string> {
  const rateLimited =
    (res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0";
  if (rateLimited) {
    return token
      ? "GitHub's rate limit for this token is used up — try again shortly"
      : "GitHub's rate limit for anonymous requests (60 an hour) is used up — a token raises it";
  }
  if (res.status === 401) return "GitHub rejected the token — it may have expired";
  if (res.status === 404) {
    return token
      ? "not found in this repository — check the path, and that the token can read it"
      : "not found — if the repository is private, it needs a token";
  }
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    detail = typeof body.message === "string" ? body.message : "";
  } catch {
    /* not JSON, or an empty body — the status is the whole answer */
  }
  return detail ? `GitHub: ${detail}` : `GitHub request failed (HTTP ${res.status})`;
}

/**
 * One directory of a repository — its subdirectories and its files, sorted directories-first the
 * way a disk listing is.
 *
 * `path` is the directory within the repository, empty for its root. Symlinks and submodules are
 * dropped: a submodule is a pointer at another repository, and a symlink's target may be outside
 * the tree — neither is a file this app can fetch by path.
 *
 * Every file is listed, whatever its extension. Filtering to what the app can open is the caller's
 * job (`state/githubRepos.ts`), so that this stays a description of the repository.
 */
export async function listRepoDirectory(
  repo: RepoRef,
  path: readonly string[],
  token: string,
): Promise<RepoEntry[]> {
  const res = await request(contentsUrl(repo, path), "application/vnd.github+json", token);
  const body: unknown = await res.json();
  // A path that names a *file* answers with an object rather than an array. Reaching that means
  // the tree asked to list something it had been told was a file, which is a bug rather than a
  // state to render, but an empty listing is a safer answer than a crash.
  if (!Array.isArray(body)) return [];
  const entries: RepoEntry[] = [];
  for (const item of body as { name?: unknown; type?: unknown; size?: unknown }[]) {
    if (typeof item.name !== "string") continue;
    if (item.type === "dir") entries.push({ name: item.name, kind: "directory" });
    else if (item.type === "file") {
      entries.push({
        name: item.name,
        kind: "file",
        size: typeof item.size === "number" ? item.size : undefined,
      });
    }
  }
  entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.kind === "directory"
        ? -1
        : 1,
  );
  return entries;
}

/** One file's bytes, as they are in the repository. */
export async function fetchRepoFile(
  repo: RepoRef,
  path: readonly string[],
  token: string,
): Promise<Uint8Array> {
  const res = await request(contentsUrl(repo, path), "application/vnd.github.raw", token);
  return new Uint8Array(await res.arrayBuffer());
}
