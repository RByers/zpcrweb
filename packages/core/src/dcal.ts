/**
 * `.Dcal` pure-dye calibration files.
 *
 * A `.Dcal` describes, for one dye on one plate type, how much fluorescence that dye
 * contributes to each of the 6 optical channels, measured at four block temperatures — plus a
 * matching empty-plate measurement to baseline against. See `dcal.md` for the full format.
 *
 * Built on the ICFF container (`icff.ts`): metadata fields are decoded directly from their
 * ICFF entries (not via the entry's generic `int`/`float`/`text` guess, since a `.Dcal`'s
 * short string fields — `DYE`, `MODEL`, … — can be exactly 4 bytes, the same length as a
 * scalar, so the field *name* has to decide how to read it).
 */

import { parseIcff, type IcffEntry } from "./icff.js";

/** Matches a payload block key, e.g. `Dye0:60:PR` or `Empty180:20:PR`. */
const BLOCK_RE = /^(Dye|Empty)(0|180):(\d+):PR$/;

/** One payload block: a dye-filled or empty plate read at one temperature and rotation. */
export interface DcalBlock {
  /** Whether this block was read with the dye plate loaded or an empty plate. */
  kind: "dye" | "empty";
  /** Plate rotation the read was taken at. Every file observed in the wild uses `0`. */
  rotationDeg: 0 | 180;
  /** Block temperature in °C — one of the four calibration points (20/40/60/80). */
  temperatureC: number;
  /** Optical channel count in {@link values} (the block's own `COLORS`-equivalent header byte). */
  channelCount: number;
  /** Wells per channel in {@link values} (includes the reference row). */
  wellCount: number;
  /**
   * Fluorescence readings, channel-major: `values[channel * wellCount + well]`. One float per
   * (channel, well) — a mean, not a std/min/max tuple. In every file observed, every well
   * within a channel carries the same value (see `dcal.md`), but the format supports a full
   * per-well map, so don't assume uniformity without checking.
   */
  values: number[];
}

/** Who/when a calibration was performed, from the `SECURITY*` fields. */
export interface DcalSecurity {
  /** Calibration timestamp, built from the `SECURITYYEAR..SEC` fields; unset if year is 0. */
  date?: Date;
  /** Timezone offset in minutes, when present (`SECURITYTIMEZONE`). */
  timezoneOffsetMin?: number;
  username?: string;
  fullName?: string;
  /** Application name that wrote the file (`SECURITYAPP`). */
  app?: string;
  /** Application version (`SECURITYAPPVER`). */
  appVersion?: string;
}

/** Instrument serial numbers the calibration was recorded against. */
export interface DcalSerials {
  /** Shuttle/optics serial (`ALPHASERIALNUMBER`). */
  alpha?: string;
  /** Block/base serial (`BASESERIALNUMBER`). */
  base?: string;
  /** Optical head serial (`HEADSERIALNUMBER`). */
  head?: string;
}

/** A fully decoded `.Dcal` pure-dye calibration file. */
export interface Dcal {
  /** Dye name this file calibrates, e.g. `FAM`, `HEX`, `Cal Gold 540` (`DYE`). */
  dye: string;
  /** Plate type this calibration was measured on, e.g. `BR Clear` (`PLATE`). */
  plate: string;
  /**
   * 0-based optical channel this dye primarily loads — the channel→dye mapping. Converted
   * from the on-disk 1-based `PRIMARYCHANNEL` field for consistency with the rest of this
   * library (channels are 0-based everywhere else, e.g. `PlateRead`).
   */
  primaryChannel: number;
  /** Optical channel count in the payload blocks (`COLORS`), typically 6. */
  channelCount: number;
  /** Wells per channel in the payload blocks (`WELLS`) — 108 for CFX96, 408 for CFX384. */
  wellCount: number;
  /** True for a factory calibration; false for a user-run calibration (`FACTORY`). */
  factory: boolean;
  /** Ambient temperature during calibration, °C (`AMBIENTTEMP`), if present. */
  ambientTempC?: number;
  /** Shuttle temperature during calibration, °C (`SHUTTLETEMP`), if present. */
  shuttleTempC?: number;
  /** Free-text notes, often `|`-separated (`NOTES`), if present. */
  notes?: string;
  /** Instrument serial numbers this calibration was recorded against. */
  serials: DcalSerials;
  /** Who/when the calibration was performed. */
  security: DcalSecurity;
  /** Every dye/empty × temperature (× rotation) payload block present in the file. */
  blocks: DcalBlock[];
  /** Every ICFF field in the file, for advanced/raw access (see `icff.ts`). */
  fields: IcffEntry[];
}

/** NUL-terminated ASCII text at an ICFF entry's own offset/length, ignoring its guessed type. */
function textAt(bytes: Uint8Array, entry: IcffEntry | undefined): string | undefined {
  if (!entry || entry.offset <= 0) return undefined;
  const end = Math.min(bytes.length, entry.offset + entry.length);
  let s = "";
  for (let i = entry.offset; i < end; i++) {
    const b = bytes[i] as number;
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s || undefined;
}

function intAt(view: DataView, entry: IcffEntry | undefined): number | undefined {
  return entry && entry.length === 4 ? view.getInt32(entry.offset, false) : undefined;
}

function floatAt(view: DataView, entry: IcffEntry | undefined): number | undefined {
  return entry && entry.length === 4 ? view.getFloat32(entry.offset, false) : undefined;
}

/** Decode one `Dye*:*:PR`/`Empty*:*:PR` payload block from its ICFF entry. */
function parseBlock(name: string, entry: IcffEntry, view: DataView): DcalBlock | null {
  const m = BLOCK_RE.exec(name);
  if (!m) return null;
  const base = entry.offset;
  const channelCount = view.getUint8(base + 1);
  const wellCount = view.getUint32(base + 5, true);
  const dataStart = base + 25;
  const values = new Array<number>(channelCount * wellCount);
  for (let i = 0; i < values.length; i++) {
    values[i] = view.getFloat32(dataStart + i * 4, true);
  }
  return {
    kind: m[1] === "Dye" ? "dye" : "empty",
    rotationDeg: m[2] === "180" ? 180 : 0,
    temperatureC: Number(m[3]),
    channelCount,
    wellCount,
    values,
  };
}

/**
 * Parse a `.Dcal` pure-dye calibration file: the ICFF index, every dye/empty payload block,
 * and the calibration metadata (dye, plate, primary channel, temperatures, who/when it was
 * recorded). See `dcal.md` for the format.
 */
export function parseDcal(bytes: Uint8Array): Dcal {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = parseIcff(bytes);
  const by = new Map(fields.map((f) => [f.name, f]));

  const blocks: DcalBlock[] = [];
  for (const f of fields) {
    const block = parseBlock(f.name, f, view);
    if (block) blocks.push(block);
  }

  const year = intAt(view, by.get("SECURITYYEAR"));
  const date = year
    ? new Date(
        Date.UTC(
          year,
          (intAt(view, by.get("SECURITYMONTH")) ?? 1) - 1,
          intAt(view, by.get("SECURITYDAY")) ?? 1,
          intAt(view, by.get("SECURITYHOUR")) ?? 0,
          intAt(view, by.get("SECURITYMIN")) ?? 0,
          intAt(view, by.get("SECURITYSEC")) ?? 0,
        ),
      )
    : undefined;

  return {
    dye: textAt(bytes, by.get("DYE")) ?? "",
    plate: textAt(bytes, by.get("PLATE")) ?? "",
    primaryChannel: (intAt(view, by.get("PRIMARYCHANNEL")) ?? 1) - 1,
    channelCount: intAt(view, by.get("COLORS")) ?? blocks[0]?.channelCount ?? 6,
    wellCount: intAt(view, by.get("WELLS")) ?? blocks[0]?.wellCount ?? 108,
    factory: (intAt(view, by.get("FACTORY")) ?? 0) !== 0,
    ambientTempC: floatAt(view, by.get("AMBIENTTEMP")),
    shuttleTempC: floatAt(view, by.get("SHUTTLETEMP")),
    notes: textAt(bytes, by.get("NOTES")),
    serials: {
      alpha: textAt(bytes, by.get("ALPHASERIALNUMBER")),
      base: textAt(bytes, by.get("BASESERIALNUMBER")),
      head: textAt(bytes, by.get("HEADSERIALNUMBER")),
    },
    security: {
      date,
      timezoneOffsetMin: intAt(view, by.get("SECURITYTIMEZONE")),
      username: textAt(bytes, by.get("SECURITYUSERNAME")),
      fullName: textAt(bytes, by.get("SECURITYFULLNAME")),
      app: textAt(bytes, by.get("SECURITYAPP")),
      appVersion: textAt(bytes, by.get("SECURITYAPPVER")),
    },
    blocks,
    fields,
  };
}

/** Find a specific payload block by kind/temperature/rotation, or undefined if absent. */
export function findDcalBlock(
  dcal: Dcal,
  kind: "dye" | "empty",
  temperatureC: number,
  rotationDeg: 0 | 180 = 0,
): DcalBlock | undefined {
  return dcal.blocks.find(
    (b) => b.kind === kind && b.temperatureC === temperatureC && b.rotationDeg === rotationDeg,
  );
}

/** True for archive entry names this module can parse (`.Dcal` calibration files). */
export function isDcalName(name: string): boolean {
  return /\.dcal$/i.test(name);
}
