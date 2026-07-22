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

/** One plate read == one PCR cycle == one `.Plateread` file, fully decoded. */
export interface PlateRead {
  /** 1-based position in the ordered read series (by filename suffix). */
  index: number;
  /** Cycle number as recorded in the file header (int32 at 0x120). */
  cycle: number;
  /** Source file name inside the archive, e.g. `Read00045.Plateread`. */
  fileName: string;
  /** Block temperature in °C, if it could be read from the header (best-effort). */
  blockTempC?: number;
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
  darkCurves(): DarkCurve[];
}
