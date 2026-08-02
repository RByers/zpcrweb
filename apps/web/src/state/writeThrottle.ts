/**
 * Write-behind rate limiting for the two kinds of edit that end up rewriting a whole file in
 * IndexedDB: analysis settings into a `.zpcr`'s `zpcrweb.json` (`analysisPersist.ts`), and a
 * protocol edit into a `.prcl.txt` (`useZpcrStore`'s `setProtocolText`). Both are driven by
 * controls a person operates continuously — a slider, a number field, a held arrow key — so a
 * naive save-on-change would rewrite the file tens of times a second.
 *
 * It is a **rate limiter, not a debounce**, and the difference is what makes it usable for both:
 * an edit to an idle file is written *immediately*, so the common "change one thing, close the
 * tab" case is durable at once, and any further edit within `minIntervalMs` is coalesced into a
 * single trailing write at the end of that window. A continuously-dragged control costs one
 * rewrite per window, and the last value always lands because the trailing write asks the owner
 * for current state ({@link WriteThrottleOptions.write} is called at flush time, with nothing
 * captured when the edit happened).
 *
 * The page can still go away with a write pending, so {@link WriteThrottle.attach} flushes on the
 * two events that actually fire when it does:
 *
 * - `visibilitychange` → `hidden`, which fires when the tab is backgrounded, switched away from,
 *   or closed — while the page is still fully alive, so the IndexedDB transaction has a normal
 *   chance to complete. This is the one that does the real work.
 * - `pagehide`, the reliable last-rites event (unlike `beforeunload`/`unload`, it fires on mobile
 *   and is bfcache-compatible). By the time it fires the write may not complete, so it is a
 *   backstop for the case `visibilitychange` didn't cover, not the primary path.
 *
 * Neither can be made a hard guarantee — IndexedDB is asynchronous and a torn-down page won't
 * wait for it. The exposure is bounded to edits made in the last window of a session that ended
 * without the tab ever being hidden.
 */

/** What a throttle needs from its owner. */
export interface WriteThrottleOptions {
  /**
   * Persist one id's current state. Called at flush time, never with a captured value, so it
   * must read whatever is current.
   *
   * Returning normally clears the pending write; **throwing re-arms it**, which is the whole
   * error contract. So a target that turns out to have nowhere to be written (an unknown id, a
   * file format with no room for the state) should return rather than throw — retrying it
   * forever would never succeed.
   */
  write: (id: string) => Promise<void> | void;
  /** Minimum spacing between writes for one id. */
  minIntervalMs: number;
  /** Overridable for tests. */
  now?: () => number;
  onError?: (error: unknown) => void;
}

interface EntryState {
  dirty: boolean;
  lastFlush: number;
  timer: number | undefined;
}

export class WriteThrottle {
  #entries = new Map<string, EntryState>();
  #options: WriteThrottleOptions;
  #now: () => number;

  constructor(options: WriteThrottleOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  #state(id: string): EntryState {
    let s = this.#entries.get(id);
    if (!s) {
      // `lastFlush: 0` (rather than "now") is what makes the first edit to an id save
      // immediately instead of waiting out a window it never used.
      s = { dirty: false, lastFlush: 0, timer: undefined };
      this.#entries.set(id, s);
    }
    return s;
  }

  /** Record that `id` changed, and schedule the write. */
  markDirty(id: string): void {
    const s = this.#state(id);
    s.dirty = true;
    if (s.timer !== undefined) return; // a trailing write is already queued
    const wait = Math.max(0, this.#options.minIntervalMs - (this.#now() - s.lastFlush));
    s.timer = window.setTimeout(() => {
      s.timer = undefined;
      void this.flush(id);
    }, wait);
  }

  /** True when `id` has an edit not yet written — what a "saving…" indicator reads. */
  isDirty(id: string): boolean {
    return this.#entries.get(id)?.dirty ?? false;
  }

  /** Write one id now, if it has anything pending. Resolves once IndexedDB has the bytes. */
  async flush(id: string): Promise<void> {
    const s = this.#state(id);
    if (!s.dirty) return;
    s.dirty = false;
    s.lastFlush = this.#now();
    if (s.timer !== undefined) {
      window.clearTimeout(s.timer);
      s.timer = undefined;
    }
    try {
      await this.#options.write(id);
    } catch (e) {
      // Re-arm: a failed write (quota, a torn-down page) shouldn't silently lose the edit.
      s.dirty = true;
      this.#options.onError?.(e);
    }
  }

  /** Write every pending id now — the page-teardown path, and whenever the active file changes
   * so switching away bounds the loss window to one file's edits. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.flush(id)));
  }

  /** Forget an id (its file was removed) without writing it. */
  forget(id: string): void {
    const s = this.#entries.get(id);
    if (s?.timer !== undefined) window.clearTimeout(s.timer);
    this.#entries.delete(id);
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
