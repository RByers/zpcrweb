import type {
  AlfEntry,
  CurveOptions,
  DcalEntry,
  PlateRead,
  PltdEntry,
  PrclEntry,
  ProtocolDocument,
  Zpcr,
} from "./types.js";
import { createArchiveAccess, unzipArchive } from "./archive.js";
import { isAlfName, parseAlf } from "./alf.js";
import { isPltdName, parsePltd, type Pltd, type PltdContainer } from "./pltd.js";
import { isPlateCsvName, parsePlateCsv } from "./plateCsv.js";
import { isPrclName, parsePrcl, protocolDocumentFromRunDefinition } from "./prcl.js";
import { dyeChannelLookup, isDcalName, parseDcal, type Dcal } from "./dcal.js";
import {
  decodePlateRead,
  isPlateReadName,
  plateReadNumber,
} from "./plateread.js";
import { parseRunInfo } from "./runinfo.js";
import { ZPCRWEB_SETTINGS_NAME } from "./zpcrwebSettings.js";
import {
  toChannels,
  toCurves,
  toDarkCurves,
  toLedCurves,
  toSteps,
  toTemperatureCurves,
} from "./pivot.js";
import { compareRefToCal, parseFactoryRefRowCal } from "./refcal.js";

const RUNINFO_NAME = "RunInfo.xml";
const PROTOCOL_NAME = "ProtocolRunDefinition.txt";
const PROTOCOL_NAME_TXT = "ProtocolName.txt";
const textDecoder = new TextDecoder("utf-8");

/** Normalize the accepted isomorphic input types into a `Uint8Array`. */
function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Wrap a `.plt.csv` archive entry (zpcrweb's own plain-text plate format, see `plateCsv.ts`) in
 * a {@link Pltd}-shaped result, so {@link Zpcr.plates} can return it alongside real `.pltd`
 * entries with no type or call-site changes — a `.plt.csv` never needs a password, so
 * `needsPassword` is simply never set.
 */
function pltdFromPlateCsv(
  name: string,
  bytes: Uint8Array,
  channelForFluor: (fluor: string) => number | undefined,
): Pltd {
  const container: PltdContainer = {
    innerName: name,
    compressionMethod: 0,
    encrypted: false,
    crc32: 0,
    compressedSize: bytes.length,
    uncompressedSize: bytes.length,
  };
  try {
    return {
      container,
      plate: parsePlateCsv(textDecoder.decode(bytes), { sourceName: name, channelForFluor }),
    };
  } catch (e) {
    return { container, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Parse a `.zpcr` file (raw bytes) into a fully typed {@link Zpcr}. Accepts either a
 * `Uint8Array` or an `ArrayBuffer`, so the same call works with bytes read from disk in
 * Node or from an uploaded file in the browser. The archive is small enough to fully
 * decompress in memory, so this is synchronous.
 */
export function parseZpcr(data: Uint8Array | ArrayBuffer): Zpcr {
  const files = unzipArchive(toBytes(data));
  const archive = createArchiveAccess(files);

  // `RunInfo.xml` is what a *finished* run is described by, and every archive off an instrument or
  // out of CFX Manager has one — but a pending experiment (`experimentArchive.ts`) or a run just
  // begun in place (`runFolder.ts`'s `markExperimentBegun`) does not: the instrument writes it as
  // the run gets going. Missing metadata is therefore "not yet" rather than "not a `.zpcr`", and it
  // parses to the same empty `RunMetadata` an empty document gives, so nothing downstream needs to
  // ask which case it has.
  //
  // Some entry still has to say this is a run, or any ZIP renamed `.zpcr` would open as an empty
  // one. Four things can say it: `RunInfo.xml`, a plate read, a `ProtocolRunDefinition.txt`, or a
  // `zpcrweb.json`.
  //
  // That last one is what makes a **pending experiment with nothing in it yet** openable
  // (`experimentArchive.ts`). Such a file genuinely holds no protocol and no plate — that is the
  // state it is for — so the only honest thing in it is zpcrweb's own settings entry, which says
  // "this app made this archive". It earns its place the way `begun`/`ended` do, by presence rather
  // than content: the document may be an empty `{}` until the experiment is named. An earlier
  // version wrote a zero-length `ProtocolRunDefinition.txt` for this instead, which was worse in
  // exactly the way it sounds — the archive claimed a protocol entry it did not have, and the file's
  // own Raw tab listed it.
  const runInfoBytes = files[RUNINFO_NAME];
  if (
    runInfoBytes === undefined &&
    !archive.entries.some(
      (n) => isPlateReadName(n) || n === PROTOCOL_NAME || n === ZPCRWEB_SETTINGS_NAME,
    )
  ) {
    throw new Error(
      `Not a valid .zpcr archive: no ${RUNINFO_NAME}, plate read, ${PROTOCOL_NAME} or ${ZPCRWEB_SETTINGS_NAME}`,
    );
  }
  const metadata = parseRunInfo(runInfoBytes === undefined ? "" : textDecoder.decode(runInfoBytes));

  // Dye → optical channel, from the archive's own `.Dcal` set — see `dyeChannelLookup`. Built on
  // first use and cached: a plate CSV is the only thing that asks, and decoding every `.Dcal`
  // (typically 28 of them) isn't free.
  let lookup: ((dye: string) => number | undefined) | undefined;
  const channelForDye = (dye: string): number | undefined => {
    if (!lookup) {
      const dcals: Dcal[] = [];
      for (const name of archive.entries.filter(isDcalName)) {
        try {
          dcals.push(parseDcal(files[name] as Uint8Array));
        } catch {
          // A single unreadable calibration file shouldn't cost the plate its channels.
        }
      }
      lookup = dyeChannelLookup(dcals);
    }
    return lookup(dye);
  };

  const reads: PlateRead[] = Object.keys(files)
    .filter(isPlateReadName)
    .sort((a, b) => (plateReadNumber(a) ?? 0) - (plateReadNumber(b) ?? 0))
    .map((name, i) => decodePlateRead(files[name] as Uint8Array, i + 1, name));

  const factoryRefCal = () =>
    parseFactoryRefRowCal(
      metadata.raw["FactoryRefRowCal"] ?? "",
      metadata.channelCount,
      metadata.numberPlateColumns,
    );

  return {
    metadata,
    reads,
    archive,
    protocolText: archive.entries.includes(PROTOCOL_NAME) ? archive.text(PROTOCOL_NAME) : "",
    protocol: (): ProtocolDocument | undefined => {
      const protocolText = archive.entries.includes(PROTOCOL_NAME)
        ? archive.text(PROTOCOL_NAME)
        : "";
      if (!protocolText) return undefined;
      const name = archive.entries.includes(PROTOCOL_NAME_TXT)
        ? archive.text(PROTOCOL_NAME_TXT).trim()
        : "";
      return protocolDocumentFromRunDefinition(name, protocolText);
    },
    curves: (options?: CurveOptions) => toCurves(reads, options),
    darkCurves: (step?: number) => toDarkCurves(reads, step),
    temperatureCurves: (step?: number) => toTemperatureCurves(reads, step),
    ledCurves: (step?: number) => toLedCurves(reads, step),
    steps: () => toSteps(reads),
    channels: () => toChannels(reads),
    plates: (password?: string): PltdEntry[] =>
      archive.entries
        .filter((name) => isPltdName(name) || isPlateCsvName(name))
        .map((name) => ({
          name,
          pltd: isPlateCsvName(name)
            ? pltdFromPlateCsv(name, files[name] as Uint8Array, channelForDye)
            : parsePltd(files[name] as Uint8Array, password ? { password } : undefined),
        })),
    protocols: (password?: string): PrclEntry[] =>
      archive.entries
        .filter(isPrclName)
        .map((name) => ({
          name,
          prcl: parsePrcl(files[name] as Uint8Array, password ? { password } : undefined),
        })),
    runReports: (): AlfEntry[] =>
      archive.entries
        .filter(isAlfName)
        .map((name) => ({ name, alf: parseAlf(files[name] as Uint8Array) })),
    calibrations: (): DcalEntry[] =>
      archive.entries
        .filter(isDcalName)
        .map((name) => ({ name, dcal: parseDcal(files[name] as Uint8Array) })),
    // The same cached closure `plates()` hands to a `.plt.csv` entry, published so a caller can
    // give channels to a plate CSV that isn't in this archive — see `Zpcr.channelForDye`.
    channelForDye,
    factoryRefCal,
    refCalComparison: () => compareRefToCal(reads, factoryRefCal()),
  };
}

/**
 * Convenience for browser uploads: read a `Blob`/`File` and parse it. `Blob` is available
 * in both modern browsers and Node, so this works in either environment.
 */
export async function zpcrFromBlob(blob: Blob): Promise<Zpcr> {
  return parseZpcr(await blob.arrayBuffer());
}
