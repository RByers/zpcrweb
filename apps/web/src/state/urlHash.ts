/**
 * URL hash ↔ app state (active file + selected view).
 *
 * The app is a hash-routed SPA with no router library. The hash carries a **query string**,
 * not a path — `#file=20260720_FirstQualification.zpcr&view=curves`:
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
 * hasn't loaded can't fetch it, so the caller falls back to the default file and keeps the
 * view. The hash is a bookmark within *this* browser's loaded set, plus a way to make
 * back/forward work across view switches.
 *
 * Two keys are **instructions rather than state**, and {@link formatHash} never writes either
 * back: `#load=` (fetch this file) and `#wells=` (enable these wells on it). Both are consumed
 * once and then replaced by the ordinary `#file=…&view=…` the app produces, which is what keeps
 * a reload from re-fetching and keeps a copied URL a plain bookmark.
 *
 * `#load=<url>` lets a link carry the file itself: the app fetches that URL and loads the result
 * as if it had been dropped on the drop zone (see `useZpcrStore`'s `addUrl`). By the time the
 * hash is rewritten the file is in IndexedDB, so a reload finds it by name instead of fetching
 * it again.
 *
 * `#wells=<selector>` carries a well selection for the file — `#file=run.zpcr&view=curves&
 * wells=A1,C4-E8` — and writes it into that file's display settings, where the user's own
 * selection lives (see `useZpcrStore`'s `pendingWells`).
 */
import type { ViewId } from "./useZpcrStore";

const VIEW_IDS: ViewId[] = [
  "overview",
  "protocol",
  "curves",
  "plates",
  "reference",
  "calibration",
  "raw",
  "instrument",
  "about",
  "files",
];

export interface HashState {
  /** Active file's `name` (not its id — ids hash name+size and aren't portable). */
  file?: string;
  view?: ViewId;
  /** URL to fetch a file from, relative to the app or absolute. Read-only: parsed from the
   * hash, never serialized back into it — see the module comment. */
  load?: string;
  /**
   * Wells to enable for the file being opened, as a well selector (`A1,A2,C4-E8` — core's
   * `parseWellSelection` defines the grammar). Like {@link load} this is **an instruction, not
   * state**: it is applied to the file's own display settings and never serialized back, so a
   * link can say "look at these wells" without every ordinary URL in the app growing a
   * 96-entry list, and without the selection you then make by hand being fought over by the
   * hash.
   */
  wells?: string;
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
    const load = q.get("load");
    const wells = q.get("wells");
    return {
      file: file || undefined,
      view: isViewId(view) ? view : undefined,
      load: load || undefined,
      wells: wells || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Serialize state to a hash string (no leading `#`). `load` and `wells` are deliberately not
 * written: each describes something to *do* to the app's state rather than a state to restore,
 * and what each produces — a loaded file, a well selection — is already held elsewhere (by
 * `file`, and by the file's own display settings).
 */
function formatHash(state: HashState): string {
  const q = new URLSearchParams();
  if (state.file) q.set("file", state.file);
  if (state.view) q.set("view", state.view);
  return q.toString();
}

/**
 * The hash (no leading `#`) that asks the app to fetch and load `url`. Assigning it to
 * `location.hash` is how in-app "load this file" links work — same code path as an external
 * deep link, rather than a second way in.
 */
export function formatLoadHash(url: string): string {
  return new URLSearchParams({ load: url }).toString();
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
