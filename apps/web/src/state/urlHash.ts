/**
 * URL hash ↔ app state (active file + selected view).
 *
 * The app is a hash-routed SPA with no router library. The hash carries a **query string**,
 * not a path — `#file=20260720.zpcr&view=curves`:
 *
 * - File names contain spaces, dots and `/`-unsafe characters, so a path-style `#/<file>/<view>`
 *   would need escaping anyway and would be ambiguous to split.
 * - Both keys are optional and order-independent, so an old or hand-edited link degrades to a
 *   sensible default rather than a parse error.
 * - It extends cleanly if more state (selected wells, fluorophores) ever becomes shareable.
 *
 * `URLSearchParams` handles the encoding in both directions.
 *
 * Files themselves live only in the browser's IndexedDB — a link naming a file the recipient
 * hasn't loaded can't fetch it, so {@link applyHash}'s caller falls back to the default file
 * and keeps the view. The hash is a bookmark within *this* browser's loaded set, plus a way to
 * make back/forward work across view switches.
 */
import type { ViewId } from "./useZpcrStore";

const VIEW_IDS: ViewId[] = ["overview", "curves", "plates", "reference", "raw"];

export interface HashState {
  /** Active file's `name` (not its id — ids hash name+size and aren't portable). */
  file?: string;
  view?: ViewId;
}

function isViewId(v: string | null): v is ViewId {
  return !!v && (VIEW_IDS as string[]).includes(v);
}

/** Parse the current `location.hash`. Unknown/missing keys come back undefined. */
export function readHash(): HashState {
  try {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return {};
    const q = new URLSearchParams(raw);
    const view = q.get("view");
    const file = q.get("file");
    return { file: file || undefined, view: isViewId(view) ? view : undefined };
  } catch {
    return {};
  }
}

/** Serialize state to a hash string (no leading `#`). */
export function formatHash(state: HashState): string {
  const q = new URLSearchParams();
  if (state.file) q.set("file", state.file);
  if (state.view) q.set("view", state.view);
  return q.toString();
}

/**
 * Write state into the URL, but only when it actually differs from what's already there — so
 * a state change echoed back from a `hashchange` doesn't push a duplicate history entry.
 *
 * `replace` is for the initial sync on load (the app deciding its own starting state shouldn't
 * create a history entry to go "back" to); user-driven changes push, which is what makes
 * back/forward step through view switches.
 */
export function writeHash(state: HashState, { replace = false } = {}): void {
  try {
    const next = formatHash(state);
    if (next === window.location.hash.replace(/^#/, "")) return;
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  } catch {
    /* ignore (sandboxed iframe, history quota) */
  }
}

/**
 * Subscribe to user-driven history navigation. `hashchange` alone misses `history.pushState`
 * calls; `popstate` alone misses manual edits to the address bar — back/forward through
 * pushed hash entries fires both, so listen for the pair and let the caller's own
 * "already in that state" check absorb the duplicate.
 */
export function onHashChange(fn: () => void): () => void {
  window.addEventListener("hashchange", fn);
  window.addEventListener("popstate", fn);
  return () => {
    window.removeEventListener("hashchange", fn);
    window.removeEventListener("popstate", fn);
  };
}
