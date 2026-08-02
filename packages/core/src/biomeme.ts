/**
 * Biomeme's exported run JSON (Franklin/Two3/Three9 handheld devices) — the third input format
 * alongside `.zpcr`/`.pcrd`, and a genuinely different instrument: a handheld real-time PCR
 * device with a handful of tube positions in a single strip (three, six or nine on the devices
 * this was reverse-engineered from) rather than a 96-well block, reporting fluorescence directly
 * per fluorophore rather than per optical channel (see {@link Zpcr.dyeSpace}).
 *
 * The one file is plain JSON, undocumented by Biomeme but self-describing enough not to need a
 * byte-format doc the way `plateread.md`/`pcrd.md` document binary/XML layouts — see `biomeme.md`
 * for the field mapping this module implements and the measured Cq comparison against this
 * library's own algorithm.
 *
 * Three things distinguish it from every other supported format:
 *
 * - **No channel/dye separation.** `targets[].fluorophore` names the dye directly; there is no
 *   raw optical channel underneath it to unmix (`calibration.md` doesn't apply). `curves()`
 *   reports one curve per (well, fluorophore) with {@link WellCurve.channel} the device's actual
 *   optical channel — recovered from `targets[].emissionColor` (green/amber/red → channel
 *   1/3/4, matching the hues a `.zpcr`/`.pcrd` run's own channels 1/3/4 already draw as), a
 *   physical fact about the instrument's optics, not a per-run guess — see
 *   {@link EMISSION_CHANNELS}. `Zpcr.dyeSpace` is `true` so a consumer knows not to run the
 *   solve.
 * - **One row of tube positions, not a grid.** A handheld device has no plate rows/columns at
 *   all, just a strip of holders — {@link parseBiomeme} reports every well as row 0 ("row A"),
 *   with the column count driven by how many distinct positions the file actually names (see
 *   {@link singleRowAwareLabel}), not a fixed shape.
 * - **The device ships its own baseline and Cq.** Each target carries `rawData` (raw
 *   fluorescence), `baselineData` (the device's own baseline-corrected curve — not a residual
 *   *of* the baseline, the corrected curve itself; confirmed by `rawData[i] − baselineData[i]`
 *   reconstructing a straight line over `details.backgroundLeft..backgroundRight`), `threshold`
 *   and `cq` (`0` meaning "no Cq", the device's own not-amplified sentinel — normalized to
 *   `null` here; a real `cq` is **0-indexed** in the file and shifted `+1` on the way in, see
 *   `biomeme.md` §2.1). That is a second, complete analysis of the same measurement, carried on
 *   {@link WellCurve.fileAnalysis} alongside whatever this library's own pipeline computes from
 *   `rawData` — see `FileAnalysis`'s doc comment for why the two are independent rather than one
 *   feeding the other.
 */

import type {
  ArchiveAccess,
  CurveOptions,
  DcalEntry,
  DarkCurve,
  FileAnalysis,
  LedCurve,
  PlateReadStep,
  PltdEntry,
  ProtocolDocument,
  PrclEntry,
  RunMetadata,
  TemperatureCurve,
  WellCurve,
  Zpcr,
} from "./types.js";
import type { PlateFluor, PltdContainer, PlateDefinition, WellDefinition, WellFluor } from "./pltd.js";
import { fitLinearBaseline, type BaselineRegion } from "./baseline.js";
import { wellLabel } from "./pivot.js";
import { parseRunDefinition } from "./runDefinition.js";

// ---------------------------------------------------------------------------
// Raw JSON shape (the subset this module reads)
// ---------------------------------------------------------------------------

interface BiomemeTargetDetails {
  strip?: string;
  wellNumber?: number;
  sampleId?: string;
  name?: string;
  backgroundLeft?: number;
  backgroundRight?: number;
}

interface BiomemeTarget {
  well: string;
  cq?: number;
  endRfu?: number;
  threshold?: number;
  fluorophore?: string;
  /** The dye's emission color, e.g. `"green"`/`"amber"`/`"red"` — what {@link EMISSION_CHANNELS}
   * keys the channel assignment on. Excitation color is the LED driving the well, not the signal
   * read back, so it's not what a "channel" means here. */
  emissionColor?: string;
  rawData?: number[];
  baselineData?: number[];
  details?: BiomemeTargetDetails;
}

interface BiomemeRun {
  id?: string;
  name?: string;
  protocol?: string;
  date?: string;
  device?: string;
  location?: string;
  targets?: BiomemeTarget[];
}

/**
 * Sniff a buffer for the Biomeme run JSON shape, cheaply: valid JSON, an object, and a non-empty
 * `targets` array whose first element carries `rawData`/`baselineData` — the two fields no other
 * supported format's JSON (there is none) or coincidental JSON blob would have together. Used by
 * the web app to route a dropped `.json` file here without a file-extension-only guess.
 */
export function isBiomemeJson(data: Uint8Array | ArrayBuffer): boolean {
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const run = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown;
    if (typeof run !== "object" || run === null || !("targets" in run)) return false;
    const targets = (run as BiomemeRun).targets;
    if (!Array.isArray(targets) || targets.length === 0) return false;
    const first = targets[0] as BiomemeTarget;
    return Array.isArray(first.rawData) && Array.isArray(first.baselineData);
  } catch {
    return false;
  }
}

/**
 * Fixed emission-color → channel assignment, matching the device's own optics: green (FAM on
 * the sample this was measured from) reads channel 1, amber (`TexRedX`, an orange dye) reads
 * channel 3, red (`ATTO-647N`, a far-red dye) reads channel 4 — a physical fact about which
 * LED/filter pair a color is read through, not a per-run naming choice, so it's keyed on
 * `emissionColor` rather than on the fluorophore name (an assay can rename its dyes; the
 * device's channels don't move). The indices are chosen to land on the same hues a `.zpcr`/
 * `.pcrd` run's channel 1/3/4 already render as (`channelColors.ts`'s green/orange/red) —
 * these three colors are what the device's own app calls them, and the app's channel palette
 * happens to have the right hues at those slots already, so this reuses them rather than
 * asserting a fourth, Biomeme-only meaning for "channel 2"/"channel 3". Leaves a gap at channel
 * 2 (yellow) deliberately: it isn't one of this device's three colors, and compacting the
 * indices down to 0/1/2 would divorce a fluor's channel number from the hue actually drawn for
 * it (see `fluorChannels`'s doc comment). 0-based to match {@link WellCurve.channel} elsewhere
 * in this library — so this is `{ green: 0, amber: 2, red: 3 }`, i.e. `Ch1`/`Ch3`/`Ch4` once
 * `channelLabel()` adds 1 back. A color this library has never seen (a fourth channel some
 * other Biomeme device carries) still gets a channel — see {@link fluorChannels}.
 */
const EMISSION_CHANNELS: Record<string, number> = { green: 0, amber: 2, red: 3 };

/**
 * Assign each distinct fluorophore in the run a channel: the fixed {@link EMISSION_CHANNELS}
 * slot for its (first-seen) emission color when known, else the next channel index not already
 * claimed — assigned in alphabetical fluor order for a deterministic result run to run. A run
 * that only loads a subset of the three known colors still gets the *other* channels' worth of
 * gap (e.g. green + red alone leaves channels 1 and 2 unused) rather than compacting, so a
 * color's channel — and therefore its chart position/coloring — never depends on which other
 * dyes happened to be loaded on a given run.
 */
function fluorChannels(targets: BiomemeTarget[]): Map<string, number> {
  const colorOfFluor = new Map<string, string>();
  for (const t of targets) {
    const fluor = t.fluorophore ?? "";
    if (!colorOfFluor.has(fluor)) colorOfFluor.set(fluor, t.emissionColor ?? "");
  }
  const fluors = [...colorOfFluor.keys()].sort();
  const channelOfFluor = new Map<string, number>();
  const claimed = new Set<number>();
  for (const f of fluors) {
    const ch = EMISSION_CHANNELS[colorOfFluor.get(f) ?? ""];
    if (ch !== undefined) {
      channelOfFluor.set(f, ch);
      claimed.add(ch);
    }
  }
  let next = 0;
  for (const f of fluors) {
    if (channelOfFluor.has(f)) continue;
    while (claimed.has(next)) next++;
    channelOfFluor.set(f, next);
    claimed.add(next);
  }
  return channelOfFluor;
}

/**
 * A well label for a plate of `rows` total rows: the normal `"A1"`-style row-letter-plus-column
 * ({@link wellLabel}) when there's more than one row, or just the column number when there is
 * only one — the well is still internally row 0 ("row A"; see `Zpcr.dyeSpace`'s neighbour
 * `parseBiomeme` doc comment), but naming a row that can't vary tells the user nothing a bare
 * position number doesn't already say more plainly. A Biomeme device's tube positions sit in one
 * row today (see {@link parseBiomeme}'s well-mapping note); this stays format-generic rather than
 * hardcoding that assumption in case a future device reports more than one.
 */
function singleRowAwareLabel(row: number, col: number, rows: number): string {
  return rows === 1 ? String(col + 1) : wellLabel(row, col);
}

const EMPTY_ARCHIVE_MESSAGE = "a Biomeme run export has no inner archive entries";

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

/**
 * Parse a Biomeme run export (raw JSON bytes) into a {@link Zpcr}, the same public shape
 * `parseZpcr`/`parsePcrd` produce — so the web app's views work unchanged (module doc comment
 * above, and `apps/web/ARCHITECTURE.md`'s "Format independence").
 *
 * What doesn't apply to a handheld device is left honestly empty rather than faked: no archive
 * entries, no plate reads (there's no per-cycle instrument header to decode — the run is
 * pre-pivoted into curves already), no `.Dcal`/`.pltd`/`.prcl` entries, no per-well gain factors.
 * `plates()` still returns one synthesized {@link PltdEntry} — Biomeme's `targets` array *is* a
 * plate definition (per-well fluorophore, sample and — this library's grouping code already
 * handles a plate with none — target), so building one is what lets the Curves view's Wells,
 * Samples and Targets rails work with no format-specific code.
 */
export function parseBiomeme(data: Uint8Array | ArrayBuffer): Zpcr {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const run = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as BiomemeRun;
  const targets = run.targets ?? [];
  if (targets.length === 0) throw new Error("Not a valid Biomeme run export: no targets");

  const channelOfFluor = fluorChannels(targets);
  const fluors = [...new Set(targets.map((t) => t.fluorophore ?? ""))].sort();

  // A handheld device's tube positions sit in a single strip of holders, not a plate grid, so
  // every well is row 0 ("row A" -- see singleRowAwareLabel), and the column is just the
  // position among the run's distinct details.wellNumbers, in ascending order. That numbering is
  // already global across strips on the sample this was measured from (strip A: 0-2, B: 3-5, C:
  // 6-8), so this naturally reports 3, 6 or 9 columns for a run using one, two or three strips --
  // an arbitrary count driven by the data, not a fixed shape.
  const wellNumbers = [...new Set(targets.map((t) => t.details?.wellNumber ?? 0))].sort((a, b) => a - b);
  const colOfWellNumber = new Map(wellNumbers.map((n, i) => [n, i]));
  const rows = 1;
  const columns = Math.max(1, wellNumbers.length);

  const positionOf = (t: BiomemeTarget): { row: number; col: number } => ({
    row: 0,
    col: colOfWellNumber.get(t.details?.wellNumber ?? 0) ?? 0,
  });

  const curves: WellCurve[] = targets.map((t) => {
    const { row, col } = positionOf(t);
    const raw = t.rawData ?? [];
    const corrected = t.baselineData ?? raw.map(() => 0);
    const cycles = raw.map((_, i) => i + 1);
    const lastCycle = cycles.length > 0 ? (cycles.at(-1) as number) : 1;
    const region: BaselineRegion = {
      beginCycle: Math.max(1, Math.min(t.details?.backgroundLeft ?? 1, lastCycle)),
      endCycle: Math.max(1, Math.min(t.details?.backgroundRight ?? lastCycle, lastCycle)),
    };
    const fileAnalysis: FileAnalysis = {
      region,
      // The file states only the corrected curve; the line itself is recovered from
      // `raw - corrected` for display (see the module doc comment's reconstruction note).
      fit: fitLinearBaseline(cycles, raw.map((v, i) => v - (corrected[i] ?? 0)), region),
      correctedValues: corrected,
      threshold: t.threshold ?? 0,
      // `+ 1`: the file counts cycles from zero, everything else here (and Biomeme's own app)
      // counts from one — the sentinel test is on the raw value, before the shift. See
      // `biomeme.md` §2.1.
      cq: t.cq && t.cq > 0 ? t.cq + 1 : null,
      endRfu: t.endRfu ?? 0,
    };
    return {
      channel: channelOfFluor.get(t.fluorophore ?? "") ?? 0,
      row,
      col,
      wellLabel: singleRowAwareLabel(row, col, rows),
      isReference: false,
      cycles,
      mean: raw,
      std: raw.map(() => 0),
      min: raw,
      max: raw,
      fileAnalysis,
    };
  });

  // ---- Synthesized plate: Biomeme's `targets` array already carries per-well fluorophore and
  // sample assignment, the same information a `.pltd`/`.pcrd` plate setup carries — see the
  // function doc comment for why this is built rather than left absent. ----
  const wellsMap = new Map<string, WellDefinition>(); // "row,col" -> well
  for (const t of targets) {
    const { row, col } = positionOf(t);
    const key = `${row},${col}`;
    const fluor = t.fluorophore ?? "";
    const target = t.details?.name?.trim() || undefined;
    let well = wellsMap.get(key);
    if (!well) {
      well = {
        index: row * columns + col,
        row,
        col,
        label: singleRowAwareLabel(row, col, rows),
        loaded: false,
        fluors: [],
        sampleType: "unknown",
        sampleTypeRaw: "",
        sample: t.details?.sampleId || undefined,
      };
      wellsMap.set(key, well);
    }
    well.loaded = true;
    const wf: WellFluor = { fluor, channel: channelOfFluor.get(fluor), target };
    if (!well.fluors.some((f) => f.fluor === fluor)) well.fluors.push(wf);
  }
  const wells: WellDefinition[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      wells.push(
        wellsMap.get(`${row},${col}`) ?? {
          index: row * columns + col,
          row,
          col,
          label: singleRowAwareLabel(row, col, rows),
          loaded: false,
          fluors: [],
          sampleType: "empty",
          sampleTypeRaw: "",
        },
      );
    }
  }
  const plateFluors: PlateFluor[] = fluors.map((f) => ({ fluor: f, channel: channelOfFluor.get(f) }));
  const samples = [...new Set(wells.map((w) => w.sample).filter((s): s is string => !!s))];
  const targetNames = [
    ...new Set(wells.flatMap((w) => w.fluors.map((f) => f.target)).filter((t): t is string => !!t)),
  ];
  const plate: PlateDefinition = {
    plateName: "",
    identityKey: run.name || run.id,
    rows,
    columns,
    dyeCount: plateFluors.length,
    scanMode: "",
    plateType: run.protocol ?? "",
    standardUnits: "",
    fluors: plateFluors,
    targets: targetNames,
    samples,
    wells,
    meta: {},
  };
  const plateContainer: PltdContainer = {
    innerName: run.name ?? "biomeme.json",
    compressionMethod: 0,
    encrypted: false,
    crc32: 0,
    compressedSize: bytes.length,
    uncompressedSize: bytes.length,
  };
  const plateEntries: PltdEntry[] = [
    { name: run.name ?? "biomeme.json", pltd: { container: plateContainer, plate } },
  ];

  const cycleCount = curves.reduce((m, c) => Math.max(m, c.cycles.length), 0);
  const runDate = run.date ? new Date(run.date) : null;
  const metadata: RunMetadata = {
    identifier: run.id ?? "",
    // The one input format that names its own run: the device generates `<date>-<serial>`, and
    // the app shows it instead of deriving a name from the filename (see `experiment.ts`).
    experimentName: run.name ?? "",
    dataFile: run.name ?? "",
    baseSerialNumber: run.device ?? "",
    blockDescription: run.protocol ?? "",
    runStartTime: run.date ?? "",
    runStartDate: runDate && !Number.isNaN(runDate.getTime()) ? runDate : null,
    scanMask: 0,
    channelCount: fluors.length,
    numberPlateColumns: columns,
    numberPlateRows: rows,
    numberReferenceRows: 0,
    rowsIncludingReference: rows,
    raw: {},
  };

  return {
    metadata,
    reads: [],
    archive: EMPTY_ARCHIVE,
    // Not the `;`-delimited program `.zpcr`/`.pcrd` carry (there is none) — left empty so the
    // Overview view's decoded-protocol panel simply doesn't render rather than misparsing a
    // plain name as that syntax. The name is still available via `protocol()`.
    protocolText: "",
    protocol: (): ProtocolDocument | undefined =>
      run.protocol
        ? {
            name: run.protocol,
            lidTemperatureC: 0,
            useDefaultLidTemperature: true,
            shutoffLidEnabled: false,
            shutoffTemperatureC: 0,
            volumeUl: 0,
            isRealTime: true,
            isEmailWhenComplete: false,
            // No `;`-delimited program to decode (see `protocolText` above), so the decoded
            // form is empty too rather than absent — one shape for every protocol source.
            program: parseRunDefinition(""),
            runDefinition: "",
            meta: {},
          }
        : undefined,
    curves: (options?: CurveOptions) =>
      options?.channel === undefined ? curves : curves.filter((c) => c.channel === options.channel),
    darkCurves: (): DarkCurve[] => [],
    temperatureCurves: (): TemperatureCurve[] => [],
    ledCurves: (): LedCurve[] => [],
    steps: (): PlateReadStep[] => [{ step: 0, readCount: cycleCount }],
    // Not just `fluors.map((_, i) => i)`: `fluorChannels` can leave a gap (e.g. green + red
    // loaded, no amber) rather than compacting indices, so the real assigned values are read
    // back here instead of assumed contiguous from zero.
    channels: () => [...new Set(channelOfFluor.values())].sort((a, b) => a - b),
    plates: (): PltdEntry[] => plateEntries,
    protocols: (): PrclEntry[] => [],
    calibrations: (): DcalEntry[] => [],
    // A Biomeme run reads per-dye already — there are no optical channels to map a dye onto, and
    // no calibration set that could say so (see `biomeme.md`).
    channelForDye: () => undefined,
    dyeSpace: true,
    factoryRefCal: () => [],
    refCalComparison: () => [],
  };
}
