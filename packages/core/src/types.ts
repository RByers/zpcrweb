/**
 * Public types for the zpcr library.
 *
 * A `.zpcr` file is a zip archive produced by a Bio-Rad CFX qPCR instrument. It contains
 * one `.Plateread` binary file per PCR cycle (the fluorescence data), a `RunInfo.xml`
 * metadata file, and various protocol / log / calibration files. See `plateread.md` for
 * the reverse-engineered `.Plateread` binary format.
 */

import type { IcffEntry } from "./icff.js";

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
  /** Human label, e.g. `Block`; derived for unknown fields (`HEATSINKTEMP` → `Heatsink`). */
  label: string;
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
  /** Measured value vs a configured set point. */
  kind: TempKind;
  /** Cycle numbers, ascending — aligned index-for-index with {@link celsius}. */
  cycles: number[];
  /** °C per cycle, aligned with {@link cycles}; null where the read lacked the field. */
  celsius: (number | null)[];
}

/**
 * One field of a plate read's header, as a display-ready key/value pair — the format-neutral
 * unit of {@link PlateRead.fields}.
 */
export interface PlateReadField {
  /** Field name as the source spells it: `BLOCKTEMP` from a binary read, `BlockTmp` from XML. */
  name: string;
  /**
   * Human-readable value. For an XML-sourced read this is the element's text verbatim; for a
   * binary one it is a best-effort decoding of an untyped ICFF field (see
   * {@link PlateReadField.binary}).
   */
  value: string;
  /**
   * The raw ICFF index entry behind a binary-sourced field — offset, length, flag and every
   * possible scalar decoding. Absent for an XML-sourced read, which has typed text instead of
   * an untyped byte range. Consumers that just want a key/value table can ignore this.
   */
  binary?: IcffEntry;
}

/** The binary `.Plateread` file a read was decoded from, when there was one. */
export interface PlateReadBinaryFile {
  /** File size in bytes. */
  size: number;
  /** The three big-endian version/magic words at 0x000 (see `plateread.md` §2). */
  versionWords: number[];
}

/**
 * One LED drive-current field from a plateread's descriptor dictionary — the excitation LED's
 * calibrated DAC setting for one optical channel (`RunInfo.xml`'s `LEDDACValsCal`).
 */
export interface PlateReadLed {
  /** Raw field name, e.g. `LEDCURRENT01`. Stable identity across reads. */
  key: string;
  /** Human label — the channel driven, e.g. `Ch1`; the raw name for an unrecognized field. */
  label: string;
  /** 0-based optical channel the LED drives, or undefined if the name carries no channel. */
  channel?: number;
  /**
   * Drive setting in DAC counts, **not** milliamps: the archive records the calibrated DAC
   * value with no DAC→current transfer function, so no conversion is invented.
   */
  dac: number;
}

/** An LED drive-current series across the reads of a run — one channel, one value per cycle. */
export interface LedCurve {
  /** Field name, e.g. `LEDCURRENT01`. */
  key: string;
  /** Human label, e.g. `Ch1`. */
  label: string;
  /** 0-based optical channel the LED drives, or undefined if the field names none. */
  channel?: number;
  /** Cycle numbers, ascending — aligned index-for-index with {@link dac}. */
  cycles: number[];
  /** DAC counts per cycle, aligned with {@link cycles}; null where the read lacked the field. */
  dac: (number | null)[];
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
   * name contains `TEMP`, so a temperature this code has never seen appears here anyway.
   * Observed CFX96 firmware emits block/ambient/shuttle/sample/lid plus the fan set points.
   */
  temps: PlateReadTemp[];
  /**
   * Every LED drive current in the file's descriptor dictionary, in file order — any
   * `LEDCURRENT*` field, so a firmware emitting a different channel count surfaces
   * automatically. Observed CFX96 firmware emits one per optical channel (six).
   */
  leds: PlateReadLed[];
  /** Read timestamp string from the header, if present (best-effort). */
  timestamp?: string;
  /**
   * Every field in this read's header, in source order — one key/value table whatever the
   * read was decoded from. A binary read fills it from the file's own descriptor dictionary
   * (`plateread.md` §3), a `.pcrd`-origin read from the child elements of
   * `Hdr/PlateReadDataHeader` (`pcrd.md` §2.2). Field *names* still differ between the two
   * formats (`BLOCKTEMP` vs `BlockTmp`) — this unifies the shape, not the instrument's
   * vocabulary; {@link temps} is where the two are reconciled to common keys.
   *
   * The nested `DrkCrnt` element is omitted on the XML side (it is the DARKDATA array, not a
   * header scalar — see {@link dark}); the binary side's WELLDATA/DARKDATA entries are kept,
   * since there the dictionary is the file's complete schema and their offsets are the point.
   */
  fields: PlateReadField[];
  /**
   * The binary `.Plateread` file this read came from — present only for a read decoded from
   * one. A `.pcrd`-origin read is an element inside a larger document, with no file of its
   * own, so this is undefined and {@link fileName} is a synthetic label.
   */
  binaryFile?: PlateReadBinaryFile;
  /**
   * The full WELLDATA fluorescence table as `wells[channel][row][col]` — 6 optical
   * channels × 9 rows × 12 columns = 648 records. Rows 0–7 are plate rows A–H; row 8
   * is the reference row. Columns 0–11 are plate columns 1–12.
   */
  wells: WellTable;
  /** DARKDATA: the LED-off background reading, one record per channel (6 total). */
  dark: WellReading[];
}

/**
 * The WELLDATA table of a single plate read, indexed `[channel][row][col]`. Dimensions are
 * the `CHANNELS` × `ROWS` × `COLUMNS` constants; every slot is populated.
 */
export type WellTable = WellReading[][][];

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

/**
 * Per-well optical gain correction factors — the `wellFactor` divisor in `calibration.md` §4.1.
 * A run carries two independently-saved sets; `active` is whichever one the run actually has,
 * per the `snrSaved`/`flyovrSaved` flags. Only a `.pcrd` stores these (`wellFactorsCollection`);
 * a `.zpcr` archive has no equivalent, so `Zpcr.wellFactors` is undefined there.
 */
export interface WellFactors {
  /** Channel count the factors were recorded for. */
  channelCount: number;
  /** Well count per channel (108 for a 96-well block, including the reference row). */
  wellCount: number;
  /** Free-text provenance from the header's `user` field, e.g. how the set was created. */
  source?: string;
  /** Signal-to-noise well factors, `snr[channel][well]`, present only when `snrSaved`. */
  snr?: number[][];
  /** Dynamic ("flyover") well factors, `flyover[channel][well]`, present only when `flyovrSaved`. */
  flyover?: number[][];
  /**
   * The set to actually apply: `flyover` when saved, else `snr` when saved, else undefined —
   * a run with neither gets no gain correction at all (see `calibration.md` §4.1).
   */
  active?: number[][];
  /** Look up one well's factors across all channels, aligned with channel index. Undefined when no set is active. */
  get(row: number, col: number): number[] | undefined;
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
import type { Prcl, ProtocolDocument } from "./prcl.js";
export type { ProtocolDocument, ProtocolStep } from "./prcl.js";

/** A `.pltd` archive entry paired with its decoded plate definition. */
export interface PltdEntry {
  /** Archive entry name, e.g. `Qualification_Plate_96.pltd`. */
  name: string;
  /** The parsed container + plate (see {@link Pltd}). */
  pltd: Pltd;
}

/** A `.prcl` archive entry paired with its decoded protocol. */
export interface PrclEntry {
  /** Archive entry name, e.g. `Short Qualification_Plate_96.prcl`. */
  name: string;
  /** The parsed container + protocol (see {@link Prcl}). */
  prcl: Prcl;
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
  /**
   * Low-level access to every file in the archive. A `.zpcr` is a real multi-file ZIP, so this
   * lists real files. A `.pcrd` is a single XML document with no inner files — for a
   * `.pcrd`-derived `Zpcr`, `entries` is empty and the accessors throw; browse the real
   * document structure via the web app's `.pcrd` raw view instead.
   */
  archive: ArchiveAccess;
  /**
   * The thermal protocol's one-line program, e.g.
   * `METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;...;END;`. Sourced from the real
   * `ProtocolRunDefinition.txt` file (`.zpcr`) or the `protocol2` element's `runDefinition`
   * attribute (`.pcrd`) — the same real data either way. Empty string if unavailable.
   */
  protocolText: string;
  /**
   * The run's thermal-cycling protocol, decoded to whatever fidelity the source format
   * allows. For a `.pcrd`, this is a full decode (name + settings + ordered step list) of the
   * embedded `protocol2` XML — no password needed, since a `.pcrd`'s protocol isn't a separate
   * encrypted file. For a `.zpcr`, this is a best-effort {@link ProtocolDocument} built from
   * {@link protocolText} alone (name from the real `ProtocolName.txt`, settings recovered from
   * the `HOTLID`/`VOLUME` directives; no step list — decode a `.prcl` archive entry via
   * {@link protocols} for that, which needs the password). Undefined when {@link protocolText}
   * is empty.
   */
  protocol(): ProtocolDocument | undefined;
  /** Pivot the run-centric reads into well-centric amplification curves. */
  curves(options?: CurveOptions): WellCurve[];
  /** The per-channel dark (LED-off background) reading across cycles. */
  darkCurves(step?: number): DarkCurve[];
  /** Every temperature field's series across cycles, for plotting against the curves. */
  temperatureCurves(step?: number): TemperatureCurve[];
  /**
   * Every LED drive current's series across cycles (DAC counts), for plotting against the
   * curves on the same right-hand axis the temperatures use.
   */
  ledCurves(step?: number): LedCurve[];
  /** Distinct protocol PLATEREAD steps, in first-appearance order. */
  steps(): PlateReadStep[];
  /**
   * Decode every `.pltd` plate-definition entry in the archive. Encrypted entries need the
   * `password` (this library ships none); without it each entry reports `needsPassword`.
   */
  plates(password?: string): PltdEntry[];
  /**
   * Decode every `.prcl` protocol entry in the archive. Not every archive includes one
   * (`prcl.md` §1). Encrypted entries need the `password` (this library ships none); without
   * it each entry reports `needsPassword`.
   */
  protocols(password?: string): PrclEntry[];
  /** Decode every `.Dcal` pure-dye calibration entry in the archive (unencrypted). */
  calibrations(): DcalEntry[];
  /** Optical channel indices that hold data, from `CHANNELMASK` (e.g. `[0]` or `[0..5]`). */
  channels(): number[];
  /**
   * Per-well gain correction factors, when the source carries them: a `.pcrd`'s
   * `wellFactorsCollection`. Undefined for a `.zpcr`, which stores no equivalent — the gain
   * correction in `calibration.md` §4.1 is then simply inactive.
   */
  wellFactors?: WellFactors;
  /** Factory calibration of the reference row, from `RunInfo.xml`'s `FactoryRefRowCal`. */
  factoryRefCal(): RefWellCal[];
  /** Live reference row vs factory calibration, per channel/column (optical drift). */
  refCalComparison(): RefCalComparison[];
}
