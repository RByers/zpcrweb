import { unzipSync, zipSync } from "fflate";
import type { ArchiveAccess, HexDumpOptions } from "./types.js";
import { hexDump } from "./hex.js";

const textDecoder = new TextDecoder("utf-8");

/**
 * The decompressed archive: file name → raw bytes.
 *
 * This — not the zipped bytes — is the form every operation in this library actually works in: a
 * `.zpcr` is only ever a ZIP at rest. So each archive-writing function comes in a pair, a
 * `…Files` one that takes and returns this map and a byte-level wrapper that unzips, calls it and
 * re-zips (`attachPlateToFiles`/`attachPlateToZpcr`, `markFilesBegun`/`markExperimentBegun`, and
 * so on). A caller that keeps the archive open — the web app does, for a run still being written
 * to; see its `state/fileContent.ts` — uses the map-level half and pays neither the unzip nor the
 * re-zip.
 */
export type ArchiveFiles = Record<string, Uint8Array>;

/**
 * Decompress a `.zpcr` (zip) archive fully into memory. The files inside are small
 * (hundreds of KB total), so decompressing everything up front is simplest and keeps the
 * rest of the library synchronous.
 */
export function unzipArchive(data: Uint8Array): ArchiveFiles {
  return unzipSync(data);
}

/**
 * Zip an {@link ArchiveFiles} map back into `.zpcr` bytes — the inverse of {@link unzipArchive},
 * and what every archive writer in this library ends with. One name for the pairing, so "which
 * entries a `.zpcr` holds" and "how they are packed" stay one decision in one place.
 */
export function zipArchive(files: ArchiveFiles): Uint8Array {
  return zipSync(files);
}

/** Build the low-level {@link ArchiveAccess} facade over decompressed archive files. */
export function createArchiveAccess(files: ArchiveFiles): ArchiveAccess {
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
