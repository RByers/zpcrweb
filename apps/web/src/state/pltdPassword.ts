import { useSyncExternalStore } from "react";

/**
 * Client-side store for the CFX plate-file (`.pltd`/`.prcl`) decryption password.
 *
 * The password is **not** shipped with the app — the user enters it once (see
 * `pltd.md` for how a licensed CFX Manager user obtains it) and it is persisted to
 * `localStorage`, then reused for every plate. Kept in `localStorage` (not IndexedDB) so it's
 * a trivial single-value read that any component can subscribe to synchronously.
 */
const KEY = "zpcr:pltdPassword";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Persist the password (empty string clears it) and notify subscribers. */
export function setStoredPltdPassword(value: string): void {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore storage failures (private mode, etc.) */
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
