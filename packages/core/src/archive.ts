import { unzipSync } from "fflate";
import type { ArchiveAccess, HexDumpOptions } from "./types.js";
import { hexDump } from "./hex.js";

const textDecoder = new TextDecoder("utf-8");

/** The decompressed archive: file name → raw bytes. */
export type ArchiveFiles = Record<string, Uint8Array>;

/**
 * Decompress a `.zpcr` (zip) archive fully into memory. The files inside are small
 * (hundreds of KB total), so decompressing everything up front is simplest and keeps the
 * rest of the library synchronous.
 */
export function unzipArchive(data: Uint8Array): ArchiveFiles {
  return unzipSync(data);
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
