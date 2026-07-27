import type { PlateRead, WellReading, WellTable } from "./types.js";
import { icffFieldMap, parseIcff, type IcffEntry } from "./icff.js";
import { extractTemps } from "./temps.js";

/**
 * Binary decoder for Bio-Rad CFX `.Plateread` files. See `plateread.md` for the full
 * reverse-engineered format. All multi-byte numbers are little-endian; fluorescence and
 * temperature values are IEEE-754 32-bit floats.
 */

/** Number of optical channels stored (ScanMask 63 = all six). */
export const CHANNELS = 6;
/** Wells per channel: 12 columns × 9 rows (8 sample rows A–H + 1 reference row). */
export const WELLS_PER_CHANNEL = 108;
/** Columns per row. */
export const COLUMNS = 12;
/** Rows per channel including the trailing reference row. */
export const ROWS = 9;

/** Each WELLDATA/DARKDATA record is four float32 values: mean, std, min, max. */
const RECORD_SIZE = 16;

function readRecord(view: DataView, offset: number): WellReading {
  // The fluorescence arrays are little-endian (unlike the big-endian metadata).
  return {
    mean: view.getFloat32(offset, true),
    std: view.getFloat32(offset + 4, true),
    min: view.getFloat32(offset + 8, true),
    max: view.getFloat32(offset + 12, true),
  };
}

/**
 * Build a `[channel][row][col]` well table from a source that is flat and channel-major
 * (`channel * 108 + row * 12 + col`), which is how both the binary WELLDATA array and the
 * `.pcrd` `PAr` list store the table.
 *
 * @param record returns the reading at a flat index, or a filler for missing data
 */
export function buildWellTable(record: (index: number) => WellReading): WellTable {
  return Array.from({ length: CHANNELS }, (_, channel) =>
    Array.from({ length: ROWS }, (_, row) =>
      Array.from({ length: COLUMNS }, (_, col) =>
        record(channel * WELLS_PER_CHANNEL + row * COLUMNS + col),
      ),
    ),
  );
}

/**
 * Decode a single `.Plateread` file.
 *
 * @param bytes raw file contents
 * @param index 1-based position in the ordered read series
 * @param fileName archive entry name, for reference
 */
export function decodePlateRead(
  bytes: Uint8Array,
  index: number,
  fileName: string,
): PlateRead {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The file's own ICFF index (see icff.md) locates every field by name. Scalars are
  // big-endian; the WELLDATA/DARKDATA float arrays are little-endian. Array entries point
  // at the int32 count; the float data starts 4 bytes later.
  const descriptors = parseIcff(bytes);
  const fields = icffFieldMap(descriptors);
  const wellField = fields.get("WELLDATA");
  const darkField = fields.get("DARKDATA");
  if (!wellField || !darkField) {
    throw new Error(`${fileName}: not a valid .Plateread (missing WELLDATA/DARKDATA)`);
  }
  const wellStart = wellField.offset + 4;
  const darkStart = darkField.offset + 4;

  const cycle = fields.get("CYCLE")?.int ?? 0;
  const step = fields.get("STEP")?.int ?? 0;
  const channelMask = fields.get("CHANNELMASK")?.int ?? 0;

  // Every `*TEMP*` field in the dictionary, so a temperature a future firmware adds needs no
  // code change here.
  const temps = extractTemps(descriptors);
  const blockTempC = temps.find((t) => t.key === "BLOCKTEMP")?.celsius;

  const dateTime = fields.get("DATETIME")?.text;
  const timestamp =
    dateTime && !Number.isNaN(Date.parse(dateTime)) ? dateTime : undefined;

  const wells = buildWellTable((i) => readRecord(view, wellStart + i * RECORD_SIZE));

  const dark: WellReading[] = new Array(CHANNELS);
  for (let i = 0; i < CHANNELS; i++) {
    dark[i] = readRecord(view, darkStart + i * RECORD_SIZE);
  }

  return {
    index,
    cycle,
    step,
    channelMask,
    fileName,
    blockTempC,
    temps,
    timestamp,
    wells,
    dark,
  };
}

/** Match `Read00045.Plateread` (case-insensitive) and capture its numeric suffix. */
const PLATEREAD_RE = /Read(\d+)\.Plateread$/i;

/** True if an archive entry name is a `.Plateread` file. */
export function isPlateReadName(name: string): boolean {
  return PLATEREAD_RE.test(name);
}

/** Extract the numeric suffix from a `.Plateread` name for ordering, or null. */
export function plateReadNumber(name: string): number | null {
  const match = PLATEREAD_RE.exec(name);
  return match ? Number(match[1]) : null;
}

/** The fully-decoded structural view of a `.Plateread` file. */
export interface PlatereadDetail {
  /** File size in bytes. */
  size: number;
  /** The three big-endian version/magic words at 0x000. */
  versionWords: number[];
  /** Every ICFF index entry, with decoded values. */
  fields: IcffEntry[];
}

/** Fully decode a `.Plateread` file's structure (version words + ICFF index entries). Tolerant
 * of a buffer too short to be a real `.Plateread` (e.g. empty bytes for a format with no
 * binary layout at all) — `versionWords` is empty and `fields` is `[]` rather than throwing,
 * matching `parseIcff`'s own graceful degradation just below. */
export function decodePlateReadDetail(bytes: Uint8Array): PlatereadDetail {
  const versionWords: number[] = [];
  if (bytes.length >= 12) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    versionWords.push(view.getInt32(0, false), view.getInt32(4, false), view.getInt32(8, false));
  }
  return { size: bytes.length, versionWords, fields: parseIcff(bytes) };
}
