/**
 * Write-behind persistence for file-backed analysis settings (see `analysisSettings.ts`).
 *
 * Saving one threshold means re-zipping the whole archive and writing several hundred KB back
 * to IndexedDB. The controls that produce these edits are a slider and a number field, so a
 * naive save-on-change would do that tens of times a second. This is therefore a **rate
 * limiter, not a debounce**: an edit to an idle file is written immediately (so the common
 * "change one thing, close the tab" case is already durable), and any further edit within
 * {@link MIN_INTERVAL_MS} is coalesced into a single trailing write at the end of that window.
 * A continuously-dragged slider costs one archive rewrite per minute, and the last position
 * always lands because the trailing write reads current state rather than a captured value.
 *
 * The page can still go away with an edit pending, so {@link AnalysisPersister.attach} flushes
 * on the two events that actually fire when it does:
 *
 * - `visibilitychange` → `hidden`, which fires when the tab is backgrounded, switched away
 *   from, or closed — while the page is still fully alive, so the IndexedDB transaction has a
 *   normal chance to complete. This is the one that does the real work.
 * - `pagehide`, the reliable last-rites event (unlike `beforeunload`/`unload`, it fires on
 *   mobile and is bfcache-compatible). By the time it fires the write may not complete, so it
 *   is a backstop for the case `visibilitychange` didn't cover, not the primary path.
 *
 * Neither can be made a hard guarantee — IndexedDB is asynchronous and a torn-down page won't
 * wait for it. The exposure is bounded to edits made in the last minute of a session that ended
 * without the tab ever being hidden; a synchronous journal elsewhere (localStorage) would close
 * it, at the cost of putting analysis state back outside the file, which is exactly what this
 * change exists to stop.
 */

import { writeZpcrwebSettings } from "@zpcrweb/core";
import { putFile, type StoredFile } from "./db";
import { zpcrwebFromAnalysis, type AnalysisSettings } from "./analysisSettings";

/** At most one archive rewrite per file per minute. */
export const MIN_INTERVAL_MS = 60_000;

/** What the persister needs to know about a file at flush time. Resolved lazily, per flush, so
 * a rewrite always uses the newest bytes (e.g. after a plate was attached) and the newest
 * settings, never a value captured when the edit happened. */
export interface AnalysisFlushTarget {
  file: StoredFile;
  settings: AnalysisSettings;
}

export interface AnalysisPersisterOptions {
  /** Resolve a file id to its current bytes + analysis settings, or `null` when it can't be
   * written — an unknown id, or a format with no archive to put an entry in (`.pcrd` and the
   * standalone plate formats; see the store for what that means for the user). */
  resolve: (fileId: string) => AnalysisFlushTarget | null;
  /** Overridable for tests. */
  now?: () => number;
  onError?: (error: unknown) => void;
}

interface FileState {
  dirty: boolean;
  lastFlush: number;
  timer: number | undefined;
}

export class AnalysisPersister {
  #files = new Map<string, FileState>();
  #options: AnalysisPersisterOptions;
  #now: () => number;

  constructor(options: AnalysisPersisterOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  #state(fileId: string): FileState {
    let s = this.#files.get(fileId);
    if (!s) {
      // `lastFlush: 0` (rather than "now") is what makes the first edit to a file save
      // immediately instead of waiting out a window it never used.
      s = { dirty: false, lastFlush: 0, timer: undefined };
      this.#files.set(fileId, s);
    }
    return s;
  }

  /** Record that a file's analysis settings changed, and schedule the write. */
  markDirty(fileId: string): void {
    const s = this.#state(fileId);
    s.dirty = true;
    if (s.timer !== undefined) return; // a trailing write is already queued
    const wait = Math.max(0, MIN_INTERVAL_MS - (this.#now() - s.lastFlush));
    s.timer = window.setTimeout(() => {
      s.timer = undefined;
      void this.flush(fileId);
    }, wait);
  }

  /** Write one file now, if it has anything pending. Resolves once IndexedDB has the bytes. */
  async flush(fileId: string): Promise<void> {
    const s = this.#state(fileId);
    if (!s.dirty) return;
    const target = this.#options.resolve(fileId);
    // Not writable (a `.pcrd`, or a file that's since been removed): drop the pending edit
    // rather than retrying forever. The in-memory value stays live for this session.
    if (!target) {
      s.dirty = false;
      return;
    }
    s.dirty = false;
    s.lastFlush = this.#now();
    if (s.timer !== undefined) {
      window.clearTimeout(s.timer);
      s.timer = undefined;
    }
    try {
      const bytes = writeZpcrwebSettings(
        new Uint8Array(target.file.bytes),
        zpcrwebFromAnalysis(target.settings),
      );
      // `size` is deliberately left at the stored value rather than the rewritten length: it is
      // the size of the file the user loaded (what the UI labels, and what `fileId()` hashes),
      // and re-adding that same file from disk should still resolve to this record instead of
      // creating a duplicate that differs only by however many bytes of settings we added.
      await putFile({ ...target.file, bytes: bytes.slice().buffer });
    } catch (e) {
      // Re-arm: a failed write (quota, a torn-down page) shouldn't silently lose the edit.
      s.dirty = true;
      this.#options.onError?.(e);
    }
  }

  /** Write every pending file now — the page-teardown path, and used when the active file
   * changes so switching away bounds the loss window to one file's edits. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.#files.keys()].map((id) => this.flush(id)));
  }

  /** Forget a file (it was removed) without writing it. */
  forget(fileId: string): void {
    const s = this.#files.get(fileId);
    if (s?.timer !== undefined) window.clearTimeout(s.timer);
    this.#files.delete(fileId);
  }

  /** Subscribe to the page-teardown events. Returns an unsubscribe that also flushes, so a
   * React strict-mode remount (or a real unmount) doesn't drop pending edits. */
  attach(): () => void {
    const onHide = () => {
      void this.flushAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      void this.flushAll();
    };
  }
}
