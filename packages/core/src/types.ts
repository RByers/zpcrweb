/**
 * Public types for the zpcr library.
 *
 * A `.zpcr` file is a zip archive produced by a Bio-Rad CFX qPCR instrument. It contains
 * one `.Plateread` binary file per PCR cycle (the fluorescence data), a `RunInfo.xml`
 * metadata file, and various protocol / log / calibration files. See `plateread.md` for
 * the reverse-engineered `.Plateread` binary format.
 */

/** A single well/channel optical reading: four floats from the WELLDATA table. */
export interface WellReading {
  /** Mean fluorescence — the primary value that forms the amplification curve. */
  mean: number;
  /** Standard deviation across the raw samples for this reading. */
  std: number;
  /** Minimum raw sample. */
  min: number;
  /** Maximum raw sample. */
  max: number;
}

/** Whether a temperature is an instrument reading or a configured threshold. */
export type TempKind = "measured" | "setpoint";

/** One temperature field from a plateread's descriptor dictionary. */
export interface PlateReadTemp {
  /** Raw field name, e.g. `BLOCKTEMP`. Stable identity across reads. */
  key: string;
  /** Human label, e.g. `Block`; derived for unknown fields (`ROWTEMPA` → `Row A`). */
  label: string;
  /** Plate row letter (`A`–`H`) for per-row block temperatures, else undefined. */
  row?: string;
  /** Temperature in °C. */
  celsius: number;
  /** Measured value vs a configured set point (the fan on/off thresholds). */
  kind: TempKind;
}

/** A temperature series across the reads of a run — one field, one value per cycle. */
export interface TemperatureCurve {
  /** Field name, e.g. `BLOCKTEMP`. */
  key: string;
  /** Human label, e.g. `Block`. */
  label: string;
  /** Plate row letter (`A`–`H`) for per-row block temperatures, else undefined. */
  row?: string;
  /** Measured value vs a configured set point. */
  kind: TempKind;
  /** Cycle numbers, ascending — aligned index-for-index with {@link celsius}. */
  cycles: number[];
  /** °C per cycle, aligned with {@link cycles}; null where the read lacked the field. */
  celsius: (number | null)[];
}

/** One plate read == one PCR cycle == one `.Plateread` file, fully decoded. */
export interface PlateRead {
  /** 1-based position in the ordered read series (by filename suffix). */
  index: number;
  /** Cycle number within this read's protocol step (resets at each PLATEREAD step). */
  cycle: number;
  /**
   * Protocol step this read belongs to, from the `STEP` field. Protocols with more than one
   * PLATEREAD produce reads with different step values; use this to separate them.
   */
  step: number;
  /**
   * Scanned-channel bitmask (`CHANNELMASK`). The low 6 bits are the optical channels that
   * hold data (e.g. `0x3F` = all six, `0x81` = C1 only); bit 7 is a flag.
   */
  channelMask: number;
  /** Source file name inside the archive, e.g. `Read00045.Plateread`. */
  fileName: string;
  /** Block temperature in °C, if it could be read from the header (best-effort). */
  blockTempC?: number;
  /**
   * Every temperature in the file's descriptor dictionary, in file order — any field whose
   * name contains `TEMP`, so per-row block temperatures would appear here automatically.
   * Observed CFX96 firmware emits block/ambient/shuttle/sample/lid plus the fan set points.
   */
  temps: PlateReadTemp[];
  /** Read timestamp string from the header, if present (best-effort). */
  timestamp?: string;
  /**
   * The full WELLDATA fluorescence table, channel-major: 6 channels × 108 wells = 648
   * records. Index with `record = channel * 108 + row * 12 + col`, or use {@link get}.
   */
  wells: WellReading[];
  /** DARKDATA: the LED-off background reading, one record per channel (6 total). */
  dark: WellReading[];
  /**
   * Convenience accessor for a single well reading.
   * @param channel optical channel 0–5
   * @param row 0–7 = plate rows A–H, 8 = the reference row
   * @param col 0–11 = plate columns 1–12
   */
  get(channel: number, row: number, col: number): WellReading;
}

/** Run-level metadata, primarily sourced from `RunInfo.xml`. */
export interface RunMetadata {
  /** Run identifier GUID (`Identifier` key). */
  identifier: string;
  /** Data file name recorded by the instrument (`DataFile` key). */
  dataFile: string;
  /** Base (block) serial number (`BaseSerialNumber` key), e.g. `CT019138`. */
  baseSerialNumber: string;
  /** Block description (`BlockDescription` key), e.g. `"96FX"`. */
  blockDescription: string;
  /** Raw run start time string (`RunStartTime` key). */
  runStartTime: string;
  /** Parsed {@link runStartTime}, or null if it could not be parsed. */
  runStartDate: Date | null;
  /** Scan mask bitfield (`ScanMask` key); 63 = all six optical channels. */
  scanMask: number;
  /** Number of active optical channels — popcount of {@link scanMask}. */
  channelCount: number;
  /** Plate columns (`NumberPlateColumns` key), typically 12. */
  numberPlateColumns: number;
  /** Plate sample rows (`NumberPlateRows` key), typically 8 (A–H). */
  numberPlateRows: number;
  /** Number of reference rows (`NumberReferenceRows` key), typically 1. */
  numberReferenceRows: number;
  /** Total stored rows including reference rows. */
  rowsIncludingReference: number;
  /** Every key/value pair from `RunInfo.xml`, unparsed, for advanced use. */
  raw: Record<string, string>;
}

/** A well-centric amplification curve: mean fluorescence across cycles for one channel. */
export interface WellCurve {
  /** Optical channel 0–5. */
  channel: number;
  /** Row index 0–8 (8 = reference row). */
  row: number;
  /** Column index 0–11. */
  col: number;
  /** Human label such as `A3` (reference row uses `R`). */
  wellLabel: string;
  /** True when this curve is from the reference row. */
  isReference: boolean;
  /** Cycle numbers, ascending — aligned index-for-index with {@link mean}. */
  cycles: number[];
  /** Mean fluorescence per cycle, aligned with {@link cycles}. */
  mean: number[];
  /** Standard deviation per cycle, aligned with {@link cycles}. */
  std: number[];
  /** Minimum raw sample per cycle, aligned with {@link cycles}. */
  min: number[];
  /** Maximum raw sample per cycle, aligned with {@link cycles}. */
  max: number[];
}

// Re-exported so the Zpcr interface can reference them without a circular import.
import type { RefWellCal, RefCalComparison } from "./refcal.js";
export type { RefWellCal, RefCalComparison } from "./refcal.js";
import type { Pltd } from "./pltd.js";
import type { Dcal } from "./dcal.js";

/** A `.pltd` archive entry paired with its decoded plate definition. */
export interface PltdEntry {
  /** Archive entry name, e.g. `Qualification_Plate_96.pltd`. */
  name: string;
  /** The parsed container + plate (see {@link Pltd}). */
  pltd: Pltd;
}

/** A `.Dcal` archive entry paired with its decoded pure-dye calibration. */
export interface DcalEntry {
  /** Archive entry name, e.g. `FAM_BR Clear.Dcal`. */
  name: string;
  /** The parsed calibration (see {@link Dcal}). */
  dcal: Dcal;
}

/** A per-channel dark (LED-off background) reading across cycles, from DARKDATA. */
export interface DarkCurve {
  /** Optical channel 0–5. */
  channel: number;
  /** Cycle numbers, ascending — aligned index-for-index with the value arrays. */
  cycles: number[];
  /** Dark mean per cycle. */
  mean: number[];
  /** Dark std per cycle. */
  std: number[];
  /** Dark min per cycle. */
  min: number[];
  /** Dark max per cycle. */
  max: number[];
}

/** Options for {@link Zpcr.curves}. */
export interface CurveOptions {
  /** Restrict to a single channel; omit for all channels. */
  channel?: number;
  /** Include reference-row wells (row 8). Default false. */
  includeReference?: boolean;
  /** Restrict to reads from a single protocol step; omit for all reads. */
  step?: number;
}

/** A distinct protocol PLATEREAD step and how many reads it produced. */
export interface PlateReadStep {
  /** The `STEP` field value shared by this step's reads. */
  step: number;
  /** Number of reads (cycles) in this step. */
  readCount: number;
}

/** Low-level access to the raw files inside the archive. */
export interface ArchiveAccess {
  /** All file names contained in the archive, in archive order. */
  entries: string[];
  /** Raw bytes for a named entry. Throws if the entry does not exist. */
  bytes(name: string): Uint8Array;
  /** UTF-8 decoded text for a named entry. Throws if the entry does not exist. */
  text(name: string): string;
  /** Canonical hex + ASCII dump of a named entry. Throws if the entry does not exist. */
  hexDump(name: string, options?: HexDumpOptions): string;
}

/** Options for {@link ArchiveAccess.hexDump}. */
export interface HexDumpOptions {
  /** Bytes per row. Default 16. */
  bytesPerRow?: number;
  /** Maximum number of bytes to render; omit for the whole file. */
  maxBytes?: number;
}

/** The fully parsed result of reading a `.zpcr` file. */
export interface Zpcr {
  /** Run-level metadata from `RunInfo.xml`. */
  metadata: RunMetadata;
  /** All plate reads, ordered by cycle. */
  reads: PlateRead[];
  /** Low-level access to every file in the archive. */
  archive: ArchiveAccess;
  /** Pivot the run-centric reads into well-centric amplification curves. */
  curves(options?: CurveOptions): WellCurve[];
  /** The per-channel dark (LED-off background) reading across cycles. */
  darkCurves(step?: number): DarkCurve[];
  /** Every temperature field's series across cycles, for plotting against the curves. */
  temperatureCurves(step?: number): TemperatureCurve[];
  /** Distinct protocol PLATEREAD steps, in first-appearance order. */
  steps(): PlateReadStep[];
  /**
   * Decode every `.pltd` plate-definition entry in the archive. Encrypted entries need the
   * `password` (this library ships none); without it each entry reports `needsPassword`.
   */
  plates(password?: string): PltdEntry[];
  /** Decode every `.Dcal` pure-dye calibration entry in the archive (unencrypted). */
  calibrations(): DcalEntry[];
  /** Optical channel indices that hold data, from `CHANNELMASK` (e.g. `[0]` or `[0..5]`). */
  channels(): number[];
  /** Factory calibration of the reference row, from `RunInfo.xml`'s `FactoryRefRowCal`. */
  factoryRefCal(): RefWellCal[];
  /** Live reference row vs factory calibration, per channel/column (optical drift). */
  refCalComparison(): RefCalComparison[];
}
