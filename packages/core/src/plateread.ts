import type { PlateRead, WellReading } from "./types.js";
import { fieldMap, parseDescriptors } from "./descriptors.js";

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

const CYCLE_OFFSET = 0x120;
const BLOCK_TEMP_OFFSET = 0x133;
const TIMESTAMP_OFFSET = 0x182;
const TIMESTAMP_MAX_LEN = 64;

/** WELLDATA float array start (immediately after its int32 count at 0x1A4). */
const WELLDATA_OFFSET = 0x1a8;
/**
 * DARKDATA float array start (one record per channel). Like WELLDATA it is framed as
 * `[int32 count][float32 × count]`; the count (24) sits at 0x2A28 — immediately after
 * WELLDATA's 648×16 bytes — so the data begins 4 bytes later at 0x2A2C.
 */
const DARKDATA_OFFSET = 0x2a2c;
/** Each record is four float32 values: mean, std, min, max. */
const RECORD_SIZE = 16;

const WELL_COUNT = CHANNELS * WELLS_PER_CHANNEL; // 648

function readRecord(view: DataView, offset: number): WellReading {
  return {
    mean: view.getFloat32(offset, true),
    std: view.getFloat32(offset + 4, true),
    min: view.getFloat32(offset + 8, true),
    max: view.getFloat32(offset + 12, true),
  };
}

/** Compute the flat WELLDATA record index for a channel/row/col coordinate. */
export function wellIndex(channel: number, row: number, col: number): number {
  return channel * WELLS_PER_CHANNEL + row * COLUMNS + col;
}

/** Best-effort read of the NUL-terminated timestamp string in the header. */
function readTimestamp(bytes: Uint8Array): string | undefined {
  const end = Math.min(bytes.length, TIMESTAMP_OFFSET + TIMESTAMP_MAX_LEN);
  let str = "";
  for (let i = TIMESTAMP_OFFSET; i < end; i++) {
    const byte = bytes[i] as number;
    if (byte === 0) break;
    if (byte < 0x20 || byte >= 0x7f) return undefined; // not printable ASCII → give up
    str += String.fromCharCode(byte);
  }
  if (str.length === 0 || Number.isNaN(Date.parse(str))) return undefined;
  return str;
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

  // Prefer the file's own descriptor dictionary (self-describing schema); fall back to the
  // fixed offsets if it can't be parsed. Scalars in the dictionary are big-endian; the
  // WELLDATA/DARKDATA float arrays are little-endian.
  const fields = fieldMap(parseDescriptors(bytes));
  const wellField = fields.get("WELLDATA");
  const darkField = fields.get("DARKDATA");
  // Array descriptors point at the int32 count; the float data starts 4 bytes later.
  const wellStart = wellField ? wellField.offset + 4 : WELLDATA_OFFSET;
  const darkStart = darkField ? darkField.offset + 4 : DARKDATA_OFFSET;

  const cycle = fields.get("CYCLE")?.int ?? view.getInt32(CYCLE_OFFSET, true);

  const blockTempRaw =
    fields.get("BLOCKTEMP")?.float ?? view.getFloat32(BLOCK_TEMP_OFFSET, true);
  const blockTempC =
    blockTempRaw > -50 && blockTempRaw < 200 ? blockTempRaw : undefined;

  const dateTime = fields.get("DATETIME")?.text;
  const timestamp =
    dateTime && !Number.isNaN(Date.parse(dateTime)) ? dateTime : readTimestamp(bytes);

  const wells: WellReading[] = new Array(WELL_COUNT);
  for (let i = 0; i < WELL_COUNT; i++) {
    wells[i] = readRecord(view, wellStart + i * RECORD_SIZE);
  }

  const dark: WellReading[] = new Array(CHANNELS);
  for (let i = 0; i < CHANNELS; i++) {
    dark[i] = readRecord(view, darkStart + i * RECORD_SIZE);
  }

  return {
    index,
    cycle,
    fileName,
    blockTempC,
    timestamp,
    wells,
    dark,
    get(channel, row, col) {
      if (channel < 0 || channel >= CHANNELS) {
        throw new RangeError(`channel out of range 0–${CHANNELS - 1}: ${channel}`);
      }
      if (row < 0 || row >= ROWS) {
        throw new RangeError(`row out of range 0–${ROWS - 1}: ${row}`);
      }
      if (col < 0 || col >= COLUMNS) {
        throw new RangeError(`col out of range 0–${COLUMNS - 1}: ${col}`);
      }
      return wells[wellIndex(channel, row, col)] as WellReading;
    },
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
