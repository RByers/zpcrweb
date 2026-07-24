import type { PlateRead, WellReading } from "./types.js";
import { fieldMap, parseDescriptors } from "./descriptors.js";
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

const WELL_COUNT = CHANNELS * WELLS_PER_CHANNEL; // 648

function readRecord(view: DataView, offset: number): WellReading {
  // The fluorescence arrays are little-endian (unlike the big-endian metadata).
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

  // The file's own descriptor dictionary (self-describing schema) locates every field.
  // Scalars in the dictionary are big-endian; the WELLDATA/DARKDATA float arrays are
  // little-endian. Array descriptors point at the int32 count; the float data starts 4
  // bytes later.
  const descriptors = parseDescriptors(bytes);
  const fields = fieldMap(descriptors);
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

  // Every `*TEMP*` field in the dictionary, so per-row block temperatures (if a firmware
  // version ever emits them) need no code change here.
  const temps = extractTemps(descriptors);
  const blockTempC = temps.find((t) => t.key === "BLOCKTEMP")?.celsius;

  const dateTime = fields.get("DATETIME")?.text;
  const timestamp =
    dateTime && !Number.isNaN(Date.parse(dateTime)) ? dateTime : undefined;

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
    step,
    channelMask,
    fileName,
    blockTempC,
    temps,
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
