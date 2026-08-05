/**
 * How a loaded file's content is held — in memory and in IndexedDB — and the one distinction left:
 * a `.zpcr` is an **archive of entries**, everything else is a blob of bytes.
 *
 * Most files are just bytes — a `.pcrd`, a `.pltd`, a `.plt.csv`, a `.prcl.txt`. A `.zpcr` is not:
 * it is a ZIP of ~40 small entries, and the app *writes* to it — a plate read arrives every cycle
 * of a live run, an experiment is renamed, a protocol is typed at, a threshold is dragged. Held as
 * ZIP bytes, each of those edits costs an unzip of the whole archive, an edit to one entry, and a
 * re-zip of everything else, on the main thread. A 45-cycle run would pay that ~45 times over while
 * doing nothing but appending files it was handed already decompressed.
 *
 * So a `.zpcr` is held as its entries and **stored as its entries**, one IndexedDB record each
 * (`db.ts`). Appending a plate read is `{...files, [name]: bytes}` and one small record written.
 * Renaming the experiment rewrites one 200-byte JSON entry. Parsing it (`parseZpcrArchive`) doesn't
 * decompress at all, because there is nothing compressed.
 *
 * ## Nothing is stored zipped
 *
 * A run used to collapse to a single ZIP record once it ended, on the reasoning that a finished
 * archive is worth compressing. The browser does that itself now: since Chrome 129, IndexedDB
 * compresses stored values — including large ones, which previously went to disk as plain files —
 * so our DEFLATE was a second compression pass over data the platform was about to compress anyway,
 * and the JS inflate on every load was the expensive half of it.
 *
 * Storing entries hands both to the platform: no zip at the end of a run, no inflate when a file is
 * opened, and no second rule about which form a `.zpcr` is in. What it costs is disk — the
 * browser's compressor optimizes for speed over ratio, so it will not match DEFLATE — and, for a
 * loaded finished run, memory: its entries are held unpacked where the ZIP bytes used to be.
 *
 * **The user never sees this.** {@link contentBytes} zips on demand, which is what download, clone
 * and "attach to something else" get, so a `.zpcr` leaving the browser is an ordinary `.zpcr`. The
 * cost moves from every edit and every load to the one moment a file is asked for *as a file*.
 *
 * ## Entry bytes are never mutated in place
 *
 * An archive's entries are treated as immutable: every writer in `packages/core` builds a new
 * archive by spread and leaves the arrays it didn't touch alone. That is what lets this module hand
 * the app's own arrays straight to IndexedDB and back without copying, and it is the assumption a
 * future writer must not quietly break.
 */

import {
  parseZpcr,
  parseZpcrArchive,
  unzipArchive,
  zipArchive,
  type ZpcrArchive,
  type Zpcr,
} from "@zpcrweb/core";
import { WHOLE_FILE, type FileBytes } from "./db";

/**
 * A loaded file's content: a `.zpcr`'s entries, or any other file's bytes.
 *
 * The discriminator is what the file *is*, not what state it is in — a `.zpcr` is an archive from
 * the moment it arrives to the moment it is downloaded, whether its run is pending, running or
 * long finished.
 */
export type FileContent =
  | { archive: false; bytes: Uint8Array }
  | { archive: true; files: ZpcrArchive };

/** Hold plain bytes — every kind that isn't a `.zpcr`. */
export function plainContent(bytes: Uint8Array): FileContent {
  return { archive: false, bytes };
}

/** Hold a `.zpcr`'s entries. Every path that writes a run's archive ends here. */
export function archiveContent(files: ZpcrArchive): FileContent {
  return { archive: true, files };
}

/**
 * The content as a real file's bytes: a `.zpcr` you could write to disk, a `.prcl.txt` as typed.
 *
 * This is the *only* place an archive is zipped, and every caller of it is a moment the user asked
 * for the file itself — download, clone, hand-off to `addFiles`. Nothing on the edit or storage
 * path may call it, which is the whole point of holding entries.
 */
export function contentBytes(content: FileContent): Uint8Array {
  return content.archive ? zipArchive(content.files) : content.bytes;
}

/**
 * The content as a {@link ZpcrArchive}, ready to be edited by any of the library's writers and
 * handed back to {@link archiveContent}. Free — a `.zpcr` is already its entries.
 *
 * Only meaningful for a `.zpcr`: anything else throws, from `unzipArchive`, as it always has.
 */
export function contentFiles(content: FileContent): ZpcrArchive {
  return content.archive ? content.files : unzipArchive(content.bytes);
}

/**
 * Parse a run's content into a {@link Zpcr}, without decompressing anything.
 *
 * The reason holding entries pays off twice over: the app re-parses a file on every change to it
 * (`useZpcrStore`'s `runs` is derived state), so a run used to be unzipped once per render as well
 * as re-zipped once per edit.
 */
export function parseContent(content: FileContent): Zpcr {
  return content.archive ? parseZpcrArchive(content.files) : parseZpcr(content.bytes);
}

/**
 * What the app reports as the file's size.
 *
 * Reported only. A file is identified by its **name** (`db.ts`'s `FileIdentity`), so this is free
 * to move as the content does — which it does constantly for a run being written to, and which is
 * exactly why hashing it into a key was a mistake.
 *
 * For a plain file this is the file's length. For a `.zpcr` it is what its entries add up to —
 * **uncompressed**, since that is what the app holds and what it costs in IndexedDB, and since the
 * zipped length is not knowable without doing the zip that storing entries exists to avoid. A
 * `.zpcr` therefore reports a larger number than the file it came from on disk, which is the honest
 * answer to "how big is this, here".
 */
export function contentSize(content: FileContent): number {
  if (!content.archive) return content.bytes.byteLength;
  let total = 0;
  for (const bytes of Object.values(content.files)) total += bytes.byteLength;
  return total;
}

/**
 * A content as the entry-keyed map IndexedDB stores — see `db.ts`'s `FileBytes`. An archive *is*
 * that map already and is handed over as it stands; a plain file becomes its one {@link WHOLE_FILE}
 * entry.
 *
 * Handed over rather than copied. The arrays are the app's own and IndexedDB clones them itself at
 * `put()`, so the defensive `slice()` this used to do bought nothing but a second copy of every
 * archive on every write. It is safe because entry bytes are never mutated in place (see the module
 * comment), and it is what lets the store tell an unchanged entry from a changed one by identity.
 */
export function toStoredContent(content: FileContent): FileBytes {
  return content.archive ? content.files : { [WHOLE_FILE]: content.bytes };
}

/**
 * Rebuild a content from what was stored: a lone {@link WHOLE_FILE} entry is a plain file's bytes,
 * anything else is a `.zpcr`'s entries as they were written. Uncopied, for the same reason
 * {@link toStoredContent} hands them over that way.
 */
export function fromStoredContent(stored: FileBytes): FileContent {
  const bytes = stored[WHOLE_FILE];
  return bytes !== undefined ? plainContent(bytes) : archiveContent(stored);
}
