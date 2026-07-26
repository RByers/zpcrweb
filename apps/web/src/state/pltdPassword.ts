import { useSyncExternalStore } from "react";

/**
 * Client-side store for the CFX file decryption password — one fixed standard-mode password
 * shared by `.pltd`/`.prcl` *and* `.pcrd` (see `pltd.md` §2, `pcrd.md` §2).
 *
 * The password is **not** shipped with the app — the user enters it once (see
 * `pltd.md` for how a licensed CFX Manager user obtains it) and it is persisted to
 * `localStorage`, then reused for every plate/protocol/`.pcrd`. Kept in `localStorage` (not
 * IndexedDB) so it's a trivial single-value read that any component can subscribe to
 * synchronously.
 *
 * It can also be supplied via the URL as `#cfxPassword=…` (e.g. for scripted/UI testing, where
 * there's no human to click through `PasswordPrompt`) — present on load, it seeds
 * `localStorage` just like a manual submit would.
 *
 * **In the hash, not the query string, because it is a secret.** A URL fragment is never sent
 * to the server: it isn't in the HTTP request line, so it can't be captured by access logs,
 * proxies/CDNs, or a `Referer` header leaking it to a third party. `?cfxPassword=` would be
 * exposed to all of those. The legacy query form is still accepted so existing links and
 * scripts keep working, but it is deprecated.
 *
 * Either form is **stripped from the URL immediately after being read** (see below), so the
 * password doesn't linger in the address bar to be shoulder-surfed, bookmarked, or copied into
 * a shared link. It's already in `localStorage` by then, so a reload still works.
 */
const KEY = "zpcr:pltdPassword";
const QUERY_PARAM = "cfxPassword";
const listeners = new Set<() => void>();

// In-memory fallback, kept in sync with localStorage. `localStorage` can throw (private
// mode, sandboxed iframe, third-party-storage blocking) — when it does, a URL-supplied
// password must still be readable for the rest of this page load rather than silently
// dropped just because it couldn't be persisted.
let memoryPassword = "";
try {
  memoryPassword = localStorage.getItem(KEY) ?? "";
} catch {
  /* ignore (private mode, etc.) */
}

// Read the password out of the URL and seed the store *immediately* — the first thing this
// module does, before any export below is even reachable by a caller — so every other
// component/hook that reads the password sees it from its very first read, regardless of
// where in the import graph this module happens to sit.
//
// This also has to run before `urlHash.ts`'s first write, which rebuilds the hash from
// file/view alone and would otherwise drop the password before it was consumed. Module
// evaluation happens long before that write (it waits on IndexedDB hydration), so the
// ordering holds without any explicit coordination.
try {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const fromUrl = hash.get(QUERY_PARAM) ?? query.get(QUERY_PARAM);
  if (fromUrl) {
    memoryPassword = fromUrl;
    // Strip it from the address bar, preserving every other hash/query key.
    hash.delete(QUERY_PARAM);
    query.delete(QUERY_PARAM);
    const q = query.toString();
    const h = hash.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${q ? `?${q}` : ""}${h ? `#${h}` : ""}`,
    );
  }
} catch {
  /* ignore (e.g. no window, malformed URL, history quota) */
}
try {
  if (memoryPassword) localStorage.setItem(KEY, memoryPassword);
} catch {
  /* ignore storage failures (private mode, etc.) — memoryPassword still holds it */
}

function read(): string {
  return memoryPassword;
}

/** Persist the password (empty string clears it) and notify subscribers. */
export function setStoredPltdPassword(value: string): void {
  memoryPassword = value;
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore storage failures (private mode, etc.) — memoryPassword still holds it */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook: `[password, setPassword]`, backed by `localStorage`. */
export function usePltdPassword(): [string, (value: string) => void] {
  const password = useSyncExternalStore(subscribe, read, () => "");
  return [password, setStoredPltdPassword];
}
