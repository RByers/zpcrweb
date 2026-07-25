/**
 * `.pcrd` files — CFX Manager's saved-experiment document. See `pcrd.md` for the full
 * reverse-engineered format.
 *
 * A `.pcrd` shares its container (single-entry encrypted ZIP) and password with `.pltd`/
 * `.prcl` (`pltd.ts`, `zipsingle.ts`). Decrypted and inflated, the entry is one large XML
 * document (`<experimentalData2>`) that gathers everything a `.zpcr` spreads across many
 * files: the plate setup, the protocol, every plate read (as text, not the binary
 * `.Plateread` layout), `RunInfo.xml`, `runlog.xml`, plus analysis/UI state with no `.zpcr`
 * equivalent.
 *
 * {@link parsePcrd} decodes it into a {@link Zpcr} — the same public shape `parseZpcr`
 * produces — so callers and UI code work with either format interchangeably. A `.pcrd` has no
 * inner files, so the returned `Zpcr.archive` is empty; subtrees this module does not
 * specifically decode (`dataAnalysisParameters`, `calibrationCollection`, `PersistedData`, …)
 * are still visible, verbatim, in the full raw document returned as {@link Pcrd.xml} — the web
 * app's `.pcrd` raw view renders that as a real, navigable XML tree rather than pretending
 * these subtrees are files.
 */

import type {
  ArchiveAccess,
  CurveOptions,
  DcalEntry,
  PlateRead,
  PlateReadTemp,
  PltdEntry,
  PrclEntry,
  RunMetadata,
  WellReading,
  Zpcr,
} from "./types.js";
import type { PlateDefinition } from "./pltd.js";
import { parsePlatesetup2 } from "./pltd.js";
import { zipCryptoDecrypt } from "./zipcrypto.js";
import { inflateRaw } from "./inflate.js";
import { parseSingleEntryZip } from "./zipsingle.js";
import {
  findElement,
  firstTagText,
  splitElements,
  stripBomBytes,
  unescapeXml,
  type XmlElement,
} from "./xmlLite.js";
import { parseRunInfo } from "./runinfo.js";
import { extractTemps } from "./temps.js";
import { CHANNELS, WELLS_PER_CHANNEL, wellIndex } from "./plateread.js";
import {
  toChannels,
  toCurves,
  toDarkCurves,
  toSteps,
  toTemperatureCurves,
} from "./pivot.js";
import { compareRefToCal, parseFactoryRefRowCal } from "./refcal.js";

const textDecoder = new TextDecoder("utf-8");

/** Metadata about the `.pcrd` ZIP container (independent of decryption success). */
export interface PcrdContainer {
  /** Inner entry file name inside the `.pcrd` ZIP (a GUID + `.pcrd`). */
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

/** Options for {@link parsePcrd}. */
export interface PcrdOptions {
  /** The decryption password — the same fixed password used for `.pltd`/`.prcl`. */
  password?: string;
}

/** The result of {@link parsePcrd}: always the container, plus the run when decoded. */
export interface Pcrd {
  container: PcrdContainer;
  /**
   * The decoded document, in the same shape `parseZpcr` returns, when decryption + parse
   * succeeded.
   */
  zpcr?: Zpcr;
  /** The raw decoded XML, when decryption + inflate succeeded (before parsing). */
  xml?: string;
  /** True when the entry is encrypted but no password was supplied — nothing was attempted. */
  needsPassword?: boolean;
  /** Set when decoding failed (e.g. wrong password); `zpcr`/`xml` are then undefined. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Plate reads: <plateRead><PlateRead V="1">…</PlateRead></plateRead>
// ---------------------------------------------------------------------------

/** Maps a `PlateReadDataHeader` scalar field name to the canonical `*TEMP*` key `temps.ts`
 * expects (matching the names `.Plateread`'s own descriptor dictionary uses — see
 * `plateread.md` §3), so temperature extraction/labeling is shared verbatim with the binary
 * decoder. */
const TEMP_FIELD_MAP: Record<string, string> = {
  BlockTmp: "BLOCKTEMP",
  AmbTmp: "AMBIENTTEMP",
  ShtTmp: "SHUTTLETEMP",
  SamTmp: "SAMPLETEMP",
  LidTmp: "LIDTEMP",
  FanOffTmp: "FANOFFTEMP",
  FanOnTmp: "FANONTEMP",
};

/** Parse a `;`-separated `PAr` float list into `WellReading` records of four floats each. */
function parsePAr(text: string): WellReading[] {
  if (!text) return [];
  const values = text.split(";").map(Number);
  const records: WellReading[] = [];
  for (let i = 0; i + 3 < values.length; i += 4) {
    records.push({
      mean: values[i] as number,
      std: values[i + 1] as number,
      min: values[i + 2] as number,
      max: values[i + 3] as number,
    });
  }
  return records;
}

/**
 * Decode one `<plateRead>` element's XML into a {@link PlateRead}, matching the shape
 * `decodePlateRead` produces from the binary `.Plateread` file for the same cycle — so both
 * formats feed the same `toCurves()`/`toDarkCurves()`/`toTemperatureCurves()` pivots.
 */
function decodePcrdPlateRead(el: XmlElement, index: number): PlateRead {
  const body = el.inner;
  const hdrEl = findElement(body, "Hdr");
  const hdr = hdrEl ? (findElement(hdrEl.inner, "PlateReadDataHeader")?.inner ?? "") : "";
  const dataEl = findElement(body, "Data");
  const dataPAr = dataEl ? (findElement(dataEl.inner, "PAr")?.inner ?? "") : "";

  const drkEl = findElement(hdr, "DrkCrnt");
  const drkPAr = drkEl ? (findElement(drkEl.inner, "PAr")?.inner ?? "") : "";

  const wellsFlat = parsePAr(dataPAr);
  const wells: WellReading[] = new Array(CHANNELS * WELLS_PER_CHANNEL);
  for (let i = 0; i < wells.length; i++) {
    wells[i] = wellsFlat[i] ?? { mean: NaN, std: NaN, min: NaN, max: NaN };
  }
  const dark = parsePAr(drkPAr);

  const scalar = (name: string): string | undefined => firstTagText(hdr, name);
  const num = (name: string, fallback = 0): number => {
    const v = scalar(name);
    return v !== undefined && v !== "" ? Number(v) || fallback : fallback;
  };

  const temps: PlateReadTemp[] = extractTemps(
    Object.entries(TEMP_FIELD_MAP).flatMap(([xmlName, canonical]) => {
      const v = scalar(xmlName);
      if (v === undefined || v === "") return [];
      const value = Number(v);
      if (!Number.isFinite(value)) return [];
      return [{ name: canonical, offset: 0, length: 4, flag: 1, float: value, int: value, hex: "" }];
    }),
  );

  const cycle = num("Cycle");
  // Not a real file — there's no `.Plateread` inside a `.pcrd`. `PlateRead.fileName` still
  // needs some stable, human-readable value; this is honest about not being one, unlike a
  // fabricated `.Plateread` name would be.
  const fileName = `plateRead[cycle ${cycle}]`;
  const timestampRaw = scalar("Time");
  const timestamp =
    timestampRaw && !Number.isNaN(Date.parse(timestampRaw)) ? timestampRaw : undefined;

  return {
    index,
    cycle,
    step: num("Step"),
    channelMask: num("ChMask"),
    fileName,
    blockTempC: temps.find((t) => t.key === "BLOCKTEMP")?.celsius,
    temps,
    timestamp,
    wells,
    dark,
    get(channel, row, col) {
      if (channel < 0 || channel >= CHANNELS) {
        throw new RangeError(`channel out of range 0–${CHANNELS - 1}: ${channel}`);
      }
      return wells[wellIndex(channel, row, col)] as WellReading;
    },
  };
}

// ---------------------------------------------------------------------------
// Empty archive — a `.pcrd` has no inner files. Kept as a real `ArchiveAccess` (rather than
// making `Zpcr.archive` optional, which would widen the shared interface) so a `.pcrd`-derived
// `Zpcr` still satisfies the same public shape a `.zpcr` does; every accessor just reports
// there's nothing here. See the module doc comment for where the real document content is.
// ---------------------------------------------------------------------------

const EMPTY_ARCHIVE_MESSAGE =
  ".pcrd has no real archive entries — see Pcrd.xml / the app's .pcrd document view";

const EMPTY_ARCHIVE: ArchiveAccess = {
  entries: [],
  bytes: () => {
    throw new Error(EMPTY_ARCHIVE_MESSAGE);
  },
  text: () => {
    throw new Error(EMPTY_ARCHIVE_MESSAGE);
  },
  hexDump: () => {
    throw new Error(EMPTY_ARCHIVE_MESSAGE);
  },
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a `.pcrd` file: decode the ZIP container, decrypt and inflate the entry, and parse
 * the `<experimentalData2>` XML into a {@link Zpcr} — the same shape `parseZpcr` produces
 * from a `.zpcr` archive.
 *
 * The container metadata is always returned. When the entry is encrypted and no password is
 * supplied, `needsPassword` is set (nothing is attempted) — the same fixed password used for
 * `.pltd`/`.prcl` (see `pltd.md` §2). If decryption/inflate fails, {@link Pcrd.error} is set
 * instead.
 */
export function parsePcrd(bytes: Uint8Array, options: PcrdOptions = {}): Pcrd {
  const entry = parseSingleEntryZip(bytes);
  const container: PcrdContainer = {
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
    const docStart = xml.indexOf("<experimentalData2");
    if (docStart < 0) throw new Error("Not a .pcrd payload: missing <experimentalData2>");
    // No wrapper needed: <experimentalData2> is already the document's outermost element, so
    // splitElements sees it as a single depth-0 child of the (unwritten) document root.
    const rootEl = splitElements(xml.slice(docStart)).find(
      (e) => e.name.toLowerCase() === "experimentaldata2",
    );
    if (!rootEl) throw new Error("Not a .pcrd payload: malformed <experimentalData2>");
    const children = splitElements(rootEl.inner);

    const zpcr = buildZpcr(children);
    return { container, xml, zpcr };
  } catch (e) {
    return { container, error: e instanceof Error ? e.message : String(e) };
  }
}

function buildZpcr(root: XmlElement[]): Zpcr {
  const byLower = new Map<string, XmlElement>();
  for (const el of root) byLower.set(el.name.toLowerCase(), el);

  const plateSetup2 = byLower.get("platesetup2");
  const protocol2 = byLower.get("protocol2");
  const protocolRunInfo = byLower.get("protocolruninfo");
  const runInfoEl = protocolRunInfo ? findElement(protocolRunInfo.inner, "RunInfo") : undefined;
  const runInfoXml = runInfoEl ? `<RunInfo>${runInfoEl.inner}</RunInfo>` : undefined;
  const metadata: RunMetadata = runInfoXml
    ? parseRunInfo(runInfoXml)
    : parseRunInfo("<RunInfo></RunInfo>");

  const runData = byLower.get("rundata");
  const plateReadVector = runData ? findElement(runData.inner, "plateReadDataVector") : undefined;
  const plateReadWrappers = plateReadVector ? splitElements(plateReadVector.inner) : [];

  const reads: PlateRead[] = plateReadWrappers.map((wrapper, i) => {
    // wrapper is <plateRead>…</plateRead>; its one child is <PlateRead V="1">…</PlateRead>.
    const inner = splitElements(wrapper.inner)[0];
    const index = i + 1;
    return inner
      ? decodePcrdPlateRead(inner, index)
      : {
          index,
          cycle: 0,
          step: 0,
          channelMask: 0,
          fileName: `plateRead[${index}]`,
          temps: [],
          wells: new Array(CHANNELS * WELLS_PER_CHANNEL).fill({ mean: NaN, std: NaN, min: NaN, max: NaN }) as WellReading[],
          dark: new Array(CHANNELS).fill({ mean: NaN, std: NaN, min: NaN, max: NaN }) as WellReading[],
          get: () => ({ mean: NaN, std: NaN, min: NaN, max: NaN }),
        };
  });

  const plate: PlateDefinition | undefined = plateSetup2
    ? parsePlatesetup2(`<plateSetup2${attrsToString(plateSetup2.attrs)}>${plateSetup2.inner}</plateSetup2>`)
    : undefined;

  const plates = (): PltdEntry[] =>
    plateSetup2 && plate
      ? [
          {
            name: "plateSetup2",
            pltd: {
              container: {
                innerName: "plateSetup2 (embedded in .pcrd)",
                compressionMethod: 8,
                encrypted: false,
                crc32: 0,
                compressedSize: 0,
                uncompressedSize: plateSetup2.inner.length,
              },
              plate,
              xml: plateSetup2.inner,
            },
          },
        ]
      : [];

  const runDefinition = protocol2?.attrs.runDefinition;
  const protocolText = runDefinition ? unescapeXml(runDefinition) : "";

  return {
    metadata,
    reads,
    archive: EMPTY_ARCHIVE,
    protocolText,
    curves: (options?: CurveOptions) => toCurves(reads, options),
    darkCurves: (step?: number) => toDarkCurves(reads, step),
    temperatureCurves: (step?: number) => toTemperatureCurves(reads, step),
    steps: () => toSteps(reads),
    channels: () => toChannels(reads),
    plates,
    // A .pcrd's protocol2 subtree is exposed only via protocolText above (and, in the app,
    // the .pcrd document view's raw XML) -- not typed-decoded into a PrclEntry the way a
    // .zpcr's real .prcl archive entries are, since there's no separate password-gated file
    // here to model.
    protocols: (): PrclEntry[] => [],
    // A .pcrd's calibrationCollection subtree covers the same ground as .Dcal files (see
    // pcrd.md §3.6) but in an unrelated XML schema, not yet decoded into DcalEntry -- browsable
    // as raw XML in the app's .pcrd document view, not yet a typed decoder.
    calibrations: (): DcalEntry[] => [],
    factoryRefCal: () =>
      parseFactoryRefRowCal(
        metadata.raw["FactoryRefRowCal"] ?? "",
        metadata.channelCount,
        metadata.numberPlateColumns,
      ),
    refCalComparison: () =>
      compareRefToCal(
        reads,
        parseFactoryRefRowCal(
          metadata.raw["FactoryRefRowCal"] ?? "",
          metadata.channelCount,
          metadata.numberPlateColumns,
        ),
      ),
  };
}

function attrsToString(attrs: Record<string, string>): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
}

/** True for `.pcrd` (CFX Manager saved-experiment) file names. */
export function isPcrdName(name: string): boolean {
  return /\.pcrd$/i.test(name);
}

/**
 * Convenience for browser uploads: read a `Blob`/`File` and parse it. Mirrors
 * {@link zpcrFromBlob} — `Blob` is available in both modern browsers and Node.
 */
export async function pcrdFromBlob(blob: Blob, options?: PcrdOptions): Promise<Pcrd> {
  return parsePcrd(new Uint8Array(await blob.arrayBuffer()), options);
}
