import { useSyncExternalStore } from "react";

/**
 * The GitHub personal access token, if the user has given one — what reaches a **private**
 * repository, and what raises GitHub's anonymous rate limit of 60 requests an hour.
 *
 * Optional in every sense: a public repository needs none, and the app asks for none. It is
 * supplied through the URL as `#githubToken=…`, alongside the `#github=owner/repo` that says which
 * repository to read (`state/githubRepos.ts`), and persisted to `localStorage` so a reload — or a
 * link to a file in that repo, sent later — still works.
 *
 * **In the hash, not the query string, and stripped the moment it is read** — exactly as the CFX
 * decryption password is, and for exactly the same reasons (`state/pltdPassword.ts` has the long
 * version): a fragment is never sent to the server, so it cannot reach an access log, a proxy or a
 * `Referer` header, and taking it out of the address bar means a URL copied afterwards is safe to
 * share. There is no legacy `?githubToken=` form to accept here, so the query string is not read at
 * all: a token in a query string is a token in somebody's server logs.
 *
 * A token is a credential for the user's own GitHub account, so it is held exactly like the
 * password: in this browser, sent to nobody but `api.github.com`, and clearable
 * ({@link setGithubToken} with an empty string forgets it).
 */
const KEY = "zpcr:githubToken";
const HASH_PARAM = "githubToken";
const listeners = new Set<() => void>();

// In-memory copy, kept in sync with localStorage — which can throw (private mode, sandboxed
// iframe, blocked third-party storage), and a URL-supplied token must still work for the rest of
// this page load when it does.
let memoryToken = "";
try {
  memoryToken = localStorage.getItem(KEY) ?? "";
} catch {
  /* ignore (private mode, etc.) */
}

/**
 * Read the token out of the hash and seed the store immediately, at module evaluation — before any
 * export below can be called, and before `urlHash.ts` first rewrites the hash from file/view alone,
 * which would otherwise drop it unread. Same ordering argument as `pltdPassword.ts`; the hash
 * rewrite waits on IndexedDB hydration, which is long after every module has evaluated.
 *
 * Stripping is done here rather than left to the hash rewrite so that the token is out of the
 * address bar even on a page that never rewrites the hash at all.
 */
try {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fromUrl = hash.get(HASH_PARAM);
  if (fromUrl) {
    memoryToken = fromUrl;
    hash.delete(HASH_PARAM);
    const h = hash.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${h ? `#${h}` : ""}`,
    );
  }
} catch {
  /* ignore (malformed URL, history quota) */
}
try {
  if (memoryToken) localStorage.setItem(KEY, memoryToken);
} catch {
  /* ignore storage failures — memoryToken still holds it for this page load */
}

function read(): string {
  return memoryToken;
}

/** The token as it stands right now — for the fetch paths, which ask outside a render. */
export function currentGithubToken(): string {
  return read();
}

/** Persist the token (an empty string forgets it) and notify subscribers. */
export function setGithubToken(value: string): void {
  memoryToken = value;
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore storage failures — memoryToken still holds it */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook: `[token, setToken]`, backed by `localStorage`. */
export function useGithubToken(): [string, (value: string) => void] {
  const token = useSyncExternalStore(subscribe, read, () => "");
  return [token, setGithubToken];
}
