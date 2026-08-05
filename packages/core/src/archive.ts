import { unzipSync, zipSync } from "fflate";
import type { ArchiveAccess, HexDumpOptions } from "./types.js";
import { hexDump } from "./hex.js";

const textDecoder = new TextDecoder("utf-8");

/**
 * **A `.zpcr`, unpacked: entry name → raw bytes.** The one currency of every archive operation in
 * this library — every function that reads or writes a run's entries takes this and, if it writes,
 * returns a new one.
 *
 * A `.zpcr` is a ZIP only *at rest*. Zipping is therefore not part of any operation: it is one
 * step, {@link zipArchive}, that a caller takes when it wants a file, and {@link unzipArchive} is
 * the other. Keeping it out of the operations is what lets a caller hold an archive open across
 * many edits — the web app does, for any run still being written to (see its
 * `state/fileContent.ts`) — instead of unzipping and re-zipping several hundred KB per edit. A
 * caller that just has bytes and wants bytes writes the two steps itself:
 *
 * ```ts
 * zipArchive(attachPlate(unzipArchive(bytes), plate))
 * ```
 *
 * which is longer than a wrapper would be, and says exactly what it costs — the point, since
 * chaining two edits through such a wrapper would zip twice for no reason.
 */
export type ZpcrArchive = Record<string, Uint8Array>;

/**
 * Decompress `.zpcr` bytes into a {@link ZpcrArchive}. The files inside are small (hundreds of KB
 * total), so decompressing everything up front is simplest and keeps the rest of the library
 * synchronous.
 */
export function unzipArchive(data: Uint8Array): ZpcrArchive {
  return unzipSync(data);
}

/**
 * Pack a {@link ZpcrArchive} into `.zpcr` bytes — the inverse of {@link unzipArchive}, and the
 * only place in this library a ZIP is written. Anything that wants a `.zpcr` *file* ends here.
 */
export function zipArchive(archive: ZpcrArchive): Uint8Array {
  return zipSync(archive);
}

/** Build the low-level {@link ArchiveAccess} facade over an unpacked archive. */
export function createArchiveAccess(files: ZpcrArchive): ArchiveAccess {
  const get = (name: string): Uint8Array => {
    const bytes = files[name];
    if (bytes === undefined) {
      throw new Error(`No such entry in archive: ${name}`);
    }
    return bytes;
  };

  return {
    entries: Object.keys(files),
    bytes: get,
    text: (name) => textDecoder.decode(get(name)),
    hexDump: (name, options?: HexDumpOptions) => hexDump(get(name), options),
  };
}
