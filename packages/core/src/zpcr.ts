import type { CurveOptions, PlateRead, Zpcr } from "./types.js";
import { createArchiveAccess, unzipArchive } from "./archive.js";
import {
  decodePlateRead,
  isPlateReadName,
  plateReadNumber,
} from "./plateread.js";
import { parseRunInfo } from "./runinfo.js";
import { toCurves } from "./pivot.js";

const RUNINFO_NAME = "RunInfo.xml";
const textDecoder = new TextDecoder("utf-8");

/** Normalize the accepted isomorphic input types into a `Uint8Array`. */
function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Parse a `.zpcr` file (raw bytes) into a fully typed {@link Zpcr}. Accepts either a
 * `Uint8Array` or an `ArrayBuffer`, so the same call works with bytes read from disk in
 * Node or from an uploaded file in the browser. The archive is small enough to fully
 * decompress in memory, so this is synchronous.
 */
export function parseZpcr(data: Uint8Array | ArrayBuffer): Zpcr {
  const files = unzipArchive(toBytes(data));
  const archive = createArchiveAccess(files);

  const runInfoBytes = files[RUNINFO_NAME];
  if (runInfoBytes === undefined) {
    throw new Error(`Not a valid .zpcr archive: missing ${RUNINFO_NAME}`);
  }
  const metadata = parseRunInfo(textDecoder.decode(runInfoBytes));

  const reads: PlateRead[] = Object.keys(files)
    .filter(isPlateReadName)
    .sort((a, b) => (plateReadNumber(a) ?? 0) - (plateReadNumber(b) ?? 0))
    .map((name, i) => decodePlateRead(files[name] as Uint8Array, i + 1, name));

  return {
    metadata,
    reads,
    archive,
    curves: (options?: CurveOptions) => toCurves(reads, options),
  };
}

/**
 * Convenience for browser uploads: read a `Blob`/`File` and parse it. `Blob` is available
 * in both modern browsers and Node, so this works in either environment.
 */
export async function zpcrFromBlob(blob: Blob): Promise<Zpcr> {
  return parseZpcr(await blob.arrayBuffer());
}
