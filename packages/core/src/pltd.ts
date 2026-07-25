/**
 * `.pltd` plate-definition files (and the closely related `.prcl` protocol files).
 *
 * A `.pltd` is a single-entry ZIP archive whose entry is **ZipCrypto-encrypted** and
 * compressed with either DEFLATE (method 8) or **DEFLATE64** (method 9). The password is a
 * fixed string used by CFX for standard-mode files (Security-Edition files use a per-user
 * password). This library does **not** ship the password — the caller must supply it via
 * `options.password`; `pltd.md` explains how a licensed CFX Manager user can obtain it. When
 * no password is given for an encrypted entry, {@link parsePltd} returns the container with
 * `needsPassword: true` and no plate.
 *
 * Decrypted and inflated, the entry is a UTF-8 XML `<platesetup2>` document describing the
 * plate: its dye layers (one per fluorophore), and, per well, the loaded fluorophores, the
 * per-fluor target/gene, the sample name/condition, sample type, replicate and (for
 * standards) a quantity. See `pltd.md` for the full format.
 */

import { zipCryptoDecrypt } from "./zipcrypto.js";
import { inflateRaw } from "./inflate.js";
import { parseSingleEntryZip } from "./zipsingle.js";
import { allTagAttrs, firstTagAttrs, stripBomBytes } from "./xmlLite.js";

/** Normalized well sample type. `raw` preserves the original `wc*` code for the unknowns. */
export type SampleType =
  | "unknown" // wcSample
  | "standard" // wcStandard
  | "ntc" // wcNTC — no-template control
  | "nrt" // wcNRT — no reverse-transcriptase control
  | "positiveControl" // wcPostiveControl (Bio-Rad's spelling)
  | "negativeControl" // wcNegativeControl
  | "empty" // wcEmpty / wcBlank
  | "passiveRef" // wcPassiveRef
  | "custom" // wcCustom
  | "other"; // any other/unrecognized code (see WellDefinition.sampleTypeRaw)

const SAMPLE_TYPE_MAP: Record<string, SampleType> = {
  wcSample: "unknown",
  wcStandard: "standard",
  wcNTC: "ntc",
  wcNRT: "nrt",
  wcPostiveControl: "positiveControl", // sic — Bio-Rad's spelling
  wcPositiveControl: "positiveControl", // accept the correct spelling too
  wcNegativeControl: "negativeControl",
  wcEmpty: "empty",
  wcBlank: "empty",
  wcPassiveRef: "passiveRef",
  wcCustom: "custom",
};

/** One fluorophore loaded into a well, with its optical channel and (optional) target. */
export interface WellFluor {
  /** Fluorophore/dye name, e.g. `FAM`, `SYBR`, `HEX` — an open string set. */
  fluor: string;
  /** 0-based optical channel position the dye maps to (`channelPosition`). */
  channel: number;
  /** Target/gene name for this well+fluor, if assigned. */
  target?: string;
}

/** A single well of the plate. */
export interface WellDefinition {
  /** 0-based plate index, row-major (`row * columns + col`). */
  index: number;
  /** 0-based row (0 = A). */
  row: number;
  /** 0-based column (0 = column 1). */
  col: number;
  /** Human label such as `A1`, `H12`. */
  label: string;
  /** True if any dye layer loads this well (a real, loaded tube). */
  loaded: boolean;
  /** Fluorophores loaded in this well, in channel order. Empty when the well is not loaded. */
  fluors: WellFluor[];
  /** Normalized sample type. */
  sampleType: SampleType;
  /** Original `wellSampleType` code (e.g. `wcSample`). */
  sampleTypeRaw: string;
  /** Sample name (`sampleId`), when set. */
  sampleName?: string;
  /** Biological condition / group name (`conditionName`), when set. */
  condition?: string;
  /** Second condition (`condition2Name`), when set. */
  condition2?: string;
  /** Replicate number (`replicateNumber`), when set (the sentinel −1 is treated as unset). */
  replicate?: number;
  /** Standard concentration (`sampleQuantity`), when a finite number (NaN is treated as unset). */
  quantity?: number;
}

/** A dye layer of the plate: one fluorophore across all wells. */
export interface PlateFluor {
  /** Fluorophore/dye name. */
  fluor: string;
  /** 0-based optical channel position. */
  channel: number;
  /** Bio-Rad internal fluor id, when present. */
  fluorId?: string;
}

/** A fully decoded plate definition. */
export interface PlateDefinition {
  /**
   * Vessel type (`plateName`) — the plastic the reaction sits in, not a user-chosen label:
   * `BR Clear`, `BR White` or `MJ White`. Matches a `.Dcal`'s plate field (compare
   * case-insensitively) and so selects which calibration data applies. See `pltd.md` §2.
   */
  plateName: string;
  /** Row count (typically 8). */
  rows: number;
  /** Column count (typically 12). */
  columns: number;
  /** Declared dye count (`dyes`) — equals `fluors.length`. */
  dyeCount: number;
  /** Scan mode string (`scanMode`), e.g. `AllChannelsScan`. */
  scanMode: string;
  /** Plate type string (`plateType`). */
  plateType: string;
  /** Units for standard quantities (`standardUnits`), e.g. `copy number`. */
  standardUnits: string;
  /** All dye layers, in channel order. */
  fluors: PlateFluor[];
  /** All declared target/gene names (`geneNameList`). */
  targets: string[];
  /** All declared sample/condition names (`conditionNameList`). */
  conditions: string[];
  /** Wells in row-major order (length `rows * columns`). */
  wells: WellDefinition[];
  /** Header metadata (created/modified dates, app versions, guid, …) as raw strings. */
  meta: Record<string, string>;
}

/** Metadata about the `.pltd` ZIP container (independent of decryption success). */
export interface PltdContainer {
  /** Inner entry file name inside the `.pltd` ZIP. */
  innerName: string;
  /** ZIP compression method: 8 = DEFLATE, 9 = DEFLATE64. */
  compressionMethod: number;
  /** Whether the entry is ZipCrypto-encrypted (always true for CFX files). */
  encrypted: boolean;
  /** CRC-32 of the decompressed entry (from the central directory). */
  crc32: number;
  /** Compressed (and encrypted) size in bytes. */
  compressedSize: number;
  /** Decompressed size in bytes. */
  uncompressedSize: number;
}

/** The result of {@link parsePltd}: always the container, plus the plate when decoded. */
export interface Pltd {
  container: PltdContainer;
  /** The decoded plate, when decryption + parse succeeded. */
  plate?: PlateDefinition;
  /** The raw decoded XML, when decryption + inflate succeeded (before parsing). */
  xml?: string;
  /**
   * True when the entry is encrypted but no password was supplied — nothing was attempted.
   * (Distinct from {@link error}, which means a password was tried and failed.)
   */
  needsPassword?: boolean;
  /** Set when decoding failed (e.g. wrong password); `plate`/`xml` are then undefined. */
  error?: string;
}

/** Options for {@link parsePltd}. */
export interface PltdOptions {
  /** The decryption password. Required for encrypted entries (all CFX `.pltd`/`.prcl`). */
  password?: string;
}

// ---------------------------------------------------------------------------
// platesetup2 XML
// ---------------------------------------------------------------------------

function toSampleType(raw: string): SampleType {
  return SAMPLE_TYPE_MAP[raw] ?? "other";
}

/**
 * Parse a `<platesetup2>`/`<plateSetup2>` XML fragment into a typed {@link PlateDefinition}.
 * Exported so `pcrd.ts` can reuse it for the `plateSetup2` subtree embedded in a `.pcrd`
 * document (same schema, different root-tag case — tag matching here is case-insensitive).
 */
export function parsePlatesetup2(xml: string): PlateDefinition {
  const root = firstTagAttrs(xml, "platesetup2");
  const rows = Number(root.rows ?? 8) || 8;
  const columns = Number(root.columns ?? 12) || 12;

  const meta = firstTagAttrs(xml, "header");

  const targets = allTagAttrs(xml, "geneName")
    .map((a) => a.shortName ?? "")
    .filter((s) => s.length > 0);
  const conditions = allTagAttrs(xml, "conditionName")
    .map((a) => a.shortName ?? "")
    .filter((s) => s.length > 0);

  const wells: WellDefinition[] = [];
  for (let i = 0; i < rows * columns; i++) {
    wells.push({
      index: i,
      row: Math.floor(i / columns),
      col: i % columns,
      label: `${String.fromCharCode(65 + Math.floor(i / columns))}${(i % columns) + 1}`,
      loaded: false,
      fluors: [],
      sampleType: "empty",
      sampleTypeRaw: "",
    });
  }

  const fluors: PlateFluor[] = [];
  const layerRe = /<dyeLayer\b([^>]*)>([\s\S]*?)<\/dyeLayer>/gi;
  let layer: RegExpExecArray | null;
  while ((layer = layerRe.exec(xml)) !== null) {
    const body = layer[2]!;
    const fluorAttrs = firstTagAttrs(body, "fluor");
    const fluorName = fluorAttrs.fluorName ?? layer[1]!.match(/plateName="([^"]*)"/)?.[1] ?? "";
    const channel = Number(fluorAttrs.channelPosition ?? fluors.length) || 0;
    fluors.push({
      fluor: fluorName,
      channel,
      fluorId: fluorAttrs.fluorId,
    });

    for (const w of allTagAttrs(body, "wellSample")) {
      const idx = Number(w.plateIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= wells.length) continue;
      const well = wells[idx]!;

      // Well-level fields (consistent across layers) — set from the layers as seen.
      const rawType = w.wellSampleType ?? "";
      if (rawType) {
        well.sampleTypeRaw = rawType;
        well.sampleType = toSampleType(rawType);
      }
      if (w.sampleId) well.sampleName = w.sampleId;
      if (w.conditionName) well.condition = w.conditionName;
      if (w.condition2Name) well.condition2 = w.condition2Name;
      const rep = Number(w.replicateNumber);
      if (Number.isInteger(rep) && rep >= 0) well.replicate = rep;
      const qty = Number(w.sampleQuantity);
      if (Number.isFinite(qty)) well.quantity = qty;

      // Per-fluor: record the loaded dye + its target for this well.
      if (w.wellLoadedFluor === "True") {
        well.fluors.push({
          fluor: fluorName,
          channel,
          target: w.geneName || undefined,
        });
        well.loaded = true;
      }
    }
  }

  // Keep each well's fluors in channel order for stable display.
  for (const well of wells) well.fluors.sort((a, b) => a.channel - b.channel);

  return {
    plateName: root.plateName ?? "",
    rows,
    columns,
    dyeCount: Number(root.dyes ?? fluors.length) || fluors.length,
    scanMode: root.scanMode ?? "",
    plateType: root.plateType ?? "",
    standardUnits: root.standardUnits ?? "",
    fluors,
    targets,
    conditions,
    wells,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const textDecoder = new TextDecoder("utf-8");

/**
 * Parse a `.pltd` (or `.prcl`) file: decode the ZIP container, decrypt and inflate the
 * entry, and — for `.pltd` plate files — parse the `<platesetup2>` XML into a typed
 * {@link PlateDefinition}.
 *
 * The container metadata is always returned. When the entry is encrypted and no password is
 * supplied, `needsPassword` is set (nothing is attempted). If decryption/inflate fails (e.g.
 * a wrong password), {@link Pltd.error} is set instead. In both cases `plate`/`xml` are
 * omitted rather than throwing, so callers can still show the container and a raw hex view.
 *
 * @param bytes raw `.pltd` file bytes.
 * @param options must include `password` for encrypted entries; this library does not embed
 *   one. See `pltd.md` for how a licensed CFX Manager user can obtain it.
 */
export function parsePltd(bytes: Uint8Array, options: PltdOptions = {}): Pltd {
  const entry = parseSingleEntryZip(bytes);
  const container: PltdContainer = {
    innerName: entry.name,
    compressionMethod: entry.method,
    encrypted: entry.encrypted,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
  };

  if (entry.encrypted && !options.password) {
    return { container, needsPassword: true };
  }

  try {
    const compressed = entry.encrypted
      ? zipCryptoDecrypt(entry.data, options.password as string)
      : entry.data;

    let inflated: Uint8Array;
    if (entry.method === 8 || entry.method === 9) {
      inflated = inflateRaw(compressed, entry.uncompressedSize, entry.method === 9);
    } else if (entry.method === 0) {
      inflated = compressed;
    } else {
      throw new Error(`Unsupported ZIP compression method ${entry.method}`);
    }

    const xml = textDecoder.decode(stripBomBytes(inflated));
    const plate = /<platesetup2\b/.test(xml) ? parsePlatesetup2(xml) : undefined;
    return { container, xml, plate };
  } catch (e) {
    return { container, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True for archive entry names this module can parse (`.pltd` plate-definition files). */
export function isPltdName(name: string): boolean {
  return /\.pltd$/i.test(name);
}
