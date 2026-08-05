/**
 * How a loaded file's content is held — in memory and in IndexedDB — and the one rule that decides
 * which of the two forms it takes.
 *
 * Most files are just bytes. A `.zpcr` is not: it is a ZIP of ~40 small entries, and the app
 * *writes* to it — a plate read arrives every cycle of a live run, an experiment is renamed, a
 * protocol is typed at, a threshold is dragged. Held as bytes, each of those edits costs an unzip
 * of the whole archive, an edit to one entry, and a re-zip of everything else, on the main thread,
 * for a 400 KB archive whose reads compress slowly. A 45-cycle run pays that ~45 times over while
 * doing nothing but appending files it was handed already decompressed.
 *
 * So a run that is still being written to is stored **exploded**: the archive's entries as they
 * are, each one its own value in the record, and no ZIP anywhere. Appending a plate read is
 * `{...files, [name]: bytes}`. Renaming the experiment rewrites one 200-byte JSON entry. Parsing
 * it (`parseZpcrArchive`) doesn't decompress at all, because there is nothing compressed.
 *
 * **The user never sees this.** The two forms are the same archive; `contentBytes` zips an exploded
 * one on demand, which is what download, clone and "attach to something else" get, so a `.zpcr`
 * leaving the browser is an ordinary `.zpcr` either way. The cost moves from every edit to the one
 * moment a file is actually asked for as a file.
 *
 * ## Which form, and when it changes
 *
 * {@link runContent} decides, from the archive's own marker files and nothing else (`runFolder.ts`
 * — the same derivation the rest of the app reads run state from, so there is no second source of
 * truth to keep in sync):
 *
 * - **pending** (no `begun`) — an experiment being prepared: exploded.
 * - **in progress** (`begun`, no `ended`) — a run being followed: exploded.
 * - **finished** (`ended`) — nothing more will be appended: zipped, as a `.zpcr` on disk is.
 *
 * The transition is therefore automatic and happens exactly once, on the write that first carries
 * `ended` — the end-of-run pass in `useRunWatch`. That write replaces the exploded record with a
 * normal zipped one, which is also when the run stops being cheap to edit and starts being worth
 * compressing (a finished 45-cycle archive is ~400 KB zipped against ~1.1 MB exploded).
 *
 * Every store path that writes a `.zpcr` goes through {@link runContent}, so a file that arrives
 * finished (dropped from disk, or opened off the instrument after the fact) is stored zipped and
 * never explodes, and a file whose run ends collapses whichever way it was being held.
 */

import {
  parseZpcr,
  parseZpcrArchive,
  runProgressFromNames,
  unzipArchive,
  zipArchive,
  type ZpcrArchive,
  type Zpcr,
} from "@zpcrweb/core";
import type { StoredFile } from "./db";

/**
 * A loaded file's content, in one of the two forms above.
 *
 * A `zipped` content is any file's bytes — a `.pcrd`, a `.pltd`, a `.prcl.txt`, a finished
 * `.zpcr`. An `exploded` one is only ever a `.zpcr` still being written to.
 */
export type FileContent =
  | { exploded: false; bytes: Uint8Array }
  | { exploded: true; files: ZpcrArchive };

/** Hold plain bytes — every non-`.zpcr` kind, and a finished run. */
export function zippedContent(bytes: Uint8Array): FileContent {
  return { exploded: false, bytes };
}

/**
 * Hold a `.zpcr`'s entries in whichever form its own run state calls for — see the module comment.
 * The single decision point: every path that writes a run's archive ends here, so "when does a run
 * stop being exploded" is one rule in one place rather than a condition at each call site.
 */
export function runContent(files: ZpcrArchive): FileContent {
  return runProgressFromNames(Object.keys(files)).ended
    ? { exploded: false, bytes: zipArchive(files) }
    : { exploded: true, files };
}

/**
 * The form to keep a `.zpcr` that arrived as bytes and has already been unzipped — a dropped file,
 * a fetched `#load=`, a clone.
 *
 * Same rule as {@link runContent}, but it keeps the bytes it was given for a finished run instead
 * of zipping the entries back up: they are the same archive and one of them is already in hand.
 * Re-zipping there would be the most expensive thing about opening a file, for no change to it.
 */
export function loadedRunContent(bytes: Uint8Array, files: ZpcrArchive): FileContent {
  return runProgressFromNames(Object.keys(files)).ended
    ? { exploded: false, bytes }
    : { exploded: true, files };
}

/**
 * The content as a real file's bytes: a `.zpcr` you could write to disk, a `.prcl.txt` as typed.
 *
 * This is the *only* place an exploded archive is zipped, and every caller of it is a moment the
 * user asked for the file itself — download, clone, hand-off to `addFiles`. Nothing on the edit
 * path may call it, which is the whole point of the exploded form.
 */
export function contentBytes(content: FileContent): Uint8Array {
  return content.exploded ? zipArchive(content.files) : content.bytes;
}

/**
 * The content as a {@link ZpcrArchive}, ready to be edited by any of the library's writers and
 * handed back to {@link runContent}. Free for an exploded file; an unzip for a zipped one (a
 * finished run being edited — attaching a plate to an old file, say — which costs exactly what it
 * did before this existed).
 *
 * Only meaningful for a `.zpcr`: anything else throws, from `unzipArchive`, as it would have.
 */
export function contentFiles(content: FileContent): ZpcrArchive {
  return content.exploded ? content.files : unzipArchive(content.bytes);
}

/**
 * Parse a run's content into a {@link Zpcr}, without decompressing when it is already open.
 *
 * The reason the exploded form pays off twice over: the app re-parses a file on every change to it
 * (`useZpcrStore`'s `runs` is derived state), so a live run was unzipping the whole archive per
 * render as well as re-zipping it per edit.
 */
export function parseContent(content: FileContent): Zpcr {
  return content.exploded ? parseZpcrArchive(content.files) : parseZpcr(content.bytes);
}

/**
 * What the app reports as the file's size, and what its id is hashed from (`db.ts`'s `fileId`).
 *
 * For a zipped file this is the file's length, as it always was. For an exploded one it is what
 * its entries add up to — the run's actual content, and what it costs in IndexedDB — because the
 * zipped length isn't known without doing the zip this form exists to avoid. A run therefore
 * reports its unpacked size while it is being written and its `.zpcr` size once it has finished,
 * which is in both cases the size of the thing the app is actually holding.
 */
export function contentSize(content: FileContent): number {
  if (!content.exploded) return content.bytes.byteLength;
  let total = 0;
  for (const bytes of Object.values(content.files)) total += bytes.byteLength;
  return total;
}

/** Split a content into the two fields an IndexedDB record carries — see `StoredFile`. Copies out
 * of the app's own buffers (`slice`), like every other write to the store. */
export function toStoredContent(content: FileContent): Pick<StoredFile, "bytes" | "files"> {
  if (!content.exploded) return { bytes: content.bytes.slice().buffer };
  const files: Record<string, ArrayBuffer> = {};
  for (const [name, bytes] of Object.entries(content.files)) files[name] = bytes.slice().buffer;
  return { files };
}

/** Rebuild a content from a stored record. A record written before the exploded form existed has
 * only `bytes`, which is exactly what a zipped content is. */
export function fromStoredContent(stored: StoredFile): FileContent {
  if (stored.files) {
    const files: ZpcrArchive = {};
    for (const [name, buffer] of Object.entries(stored.files)) files[name] = new Uint8Array(buffer);
    return { exploded: true, files };
  }
  return { exploded: false, bytes: new Uint8Array(stored.bytes ?? new ArrayBuffer(0)) };
}
