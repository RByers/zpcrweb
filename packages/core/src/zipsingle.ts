/**
 * Shared ZIP-container parsing for the single-entry encrypted archives CFX uses for
 * `.pltd`/`.prcl` (plate/protocol) and `.pcrd` (saved experiment) files — see `pltd.md` §1.
 * All three share one writer and one container layout; only the payload differs.
 */

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** The single ZIP entry, decoded via the central directory. */
export interface SingleZipEntry {
  name: string;
  method: number;
  encrypted: boolean;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/**
 * Parse the single ZIP entry from a `.pltd`/`.prcl`/`.pcrd` buffer via its central
 * directory — the authoritative source for sizes and offsets across both container variants
 * (some files carry a data descriptor and a leading spanning marker, so the local header
 * alone is not reliable).
 */
export function parseSingleEntryZip(bytes: Uint8Array): SingleZipEntry {
  // Locate the End Of Central Directory record by scanning backwards.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a CFX single-entry ZIP: no end-of-central-directory record");

  const cdOffset = u32(bytes, eocd + 16);
  if (u32(bytes, cdOffset) !== CEN_SIG) {
    throw new Error("Not a CFX single-entry ZIP: central directory not found at expected offset");
  }

  const flags = u16(bytes, cdOffset + 8);
  const method = u16(bytes, cdOffset + 10);
  const crc32 = u32(bytes, cdOffset + 16);
  const compressedSize = u32(bytes, cdOffset + 20);
  const uncompressedSize = u32(bytes, cdOffset + 24);
  const nameLen = u16(bytes, cdOffset + 28);
  const localOffset = u32(bytes, cdOffset + 42);
  const name = new TextDecoder("utf-8").decode(
    bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen),
  );

  // Local header at localOffset: skip its (possibly different) name/extra to find the data.
  const lNameLen = u16(bytes, localOffset + 26);
  const lExtraLen = u16(bytes, localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  const data = bytes.subarray(dataStart, dataStart + compressedSize);

  return {
    name,
    method,
    encrypted: (flags & 0x1) === 1,
    crc32,
    compressedSize,
    uncompressedSize,
    data,
  };
}
