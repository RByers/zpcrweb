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
 * It can also be supplied via the `cfxPassword` URL query parameter (e.g. for scripted/UI
 * testing, where there's no human to click through `PasswordPrompt`) — present on load, it
 * seeds `localStorage` just like a manual submit would.
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

// Read the `cfxPassword` URL param and seed the store *immediately* — the first thing this
// module does, before any export below is even reachable by a caller — so every other
// component/hook that reads the password sees it from its very first read, regardless of
// where in the import graph this module happens to sit.
try {
  const fromUrl = new URLSearchParams(window.location.search).get(QUERY_PARAM);
  if (fromUrl) memoryPassword = fromUrl;
} catch {
  /* ignore (e.g. no window, malformed URL) */
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
