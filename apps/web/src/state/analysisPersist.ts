/**
 * Write-behind persistence for file-backed analysis settings (see `analysisSettings.ts`).
 *
 * Saving one threshold means writing the run's whole archive back to IndexedDB — and, for a
 * finished run, re-zipping several hundred KB to do it — while the controls that produce these
 * edits are a slider and a number field. So the scheduling is the shared {@link WriteThrottle}
 * (`writeThrottle.ts`), which is where the rate-limit-not-debounce policy and the page-teardown
 * flushes are explained. What lives here is only the part specific to analysis settings: which
 * files can hold them, and the archive rewrite itself.
 *
 * At most one archive rewrite per file per minute; a continuously-dragged slider therefore costs
 * one rewrite per minute, and the last position always lands because the trailing write reads
 * current state rather than a captured value. (A run still in progress is held open rather than
 * zipped — `fileContent.ts` — so its rewrite is one small JSON entry and a re-put of entries the
 * app already has; the throttle still applies, since the IndexedDB write itself is the cost there.)
 */

import { writeZpcrwebSettings, type ZpcrArchive } from "@zpcrweb/core";
import { putFile, type FileIdentity } from "./db";
import { zpcrwebFromAnalysis, type AnalysisSettings } from "./analysisSettings";
import { runContent, toStoredContent } from "./fileContent";
import { WriteThrottle } from "./writeThrottle";

/** At most one archive rewrite per file per minute. */
const MIN_INTERVAL_MS = 60_000;

/** What the persister needs to know about a file at flush time. Resolved lazily, per flush, so
 * a rewrite always uses the newest archive (e.g. after a plate was attached) and the newest
 * settings, never a value captured when the edit happened. */
interface AnalysisFlushTarget {
  /** Who the rewritten archive is being stored as — {@link AnalysisFlushTarget.files} is the
   * archive itself, and the representation to store it in is decided at write time. */
  identity: FileIdentity;
  /** The run's archive, open (`fileContent.ts`'s `contentFiles`). */
  files: ZpcrArchive;
  settings: AnalysisSettings;
}

export interface AnalysisPersisterOptions {
  /** Resolve a file id to its current archive + analysis settings, or `null` when it can't be
   * written — an unknown id, or a format with no archive to put an entry in (`.pcrd` and the
   * standalone plate formats; see the store for what that means for the user). */
  resolve: (fileId: string) => AnalysisFlushTarget | null;
  /** Overridable for tests. */
  now?: () => number;
  onError?: (error: unknown) => void;
}

export class AnalysisPersister {
  #throttle: WriteThrottle;

  constructor(options: AnalysisPersisterOptions) {
    this.#throttle = new WriteThrottle({
      minIntervalMs: MIN_INTERVAL_MS,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      write: async (fileId) => {
        const target = options.resolve(fileId);
        // Not writable (a `.pcrd`, or a file that's since been removed): drop the pending edit
        // rather than retrying forever. The in-memory value stays live for this session.
        if (!target) return;
        const content = runContent(
          writeZpcrwebSettings(target.files, zpcrwebFromAnalysis(target.settings)),
        );
        // `size` is deliberately left at the stored value rather than the rewritten length: it is
        // the size of the file the user loaded (what the UI labels, and what `fileId()` hashes),
        // and re-adding that same file from disk should still resolve to this record instead of
        // creating a duplicate that differs only by however many bytes of settings we added.
        await putFile(target.identity, toStoredContent(content));
      },
    });
  }

  /** Record that a file's analysis settings changed, and schedule the write. */
  markDirty(fileId: string): void {
    this.#throttle.markDirty(fileId);
  }

  /** Write one file now, if it has anything pending. Resolves once IndexedDB has the bytes. */
  flush(fileId: string): Promise<void> {
    return this.#throttle.flush(fileId);
  }

  /** Write every pending file now — the page-teardown path, and used when the active file
   * changes so switching away bounds the loss window to one file's edits. */
  flushAll(): Promise<void> {
    return this.#throttle.flushAll();
  }

  /** Forget a file (it was removed) without writing it. */
  forget(fileId: string): void {
    this.#throttle.forget(fileId);
  }

  /** Subscribe to the page-teardown events; see {@link WriteThrottle.attach}. */
  attach(): () => void {
    return this.#throttle.attach();
  }
}
