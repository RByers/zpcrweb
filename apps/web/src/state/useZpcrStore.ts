import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  // Aliased because this store exposes its own `attachPlate`/`attachProtocol` — the app-level
  // operation (a file id and an uploaded `File`, persisted and flagged modified) as against the
  // library's entry swap on an archive. Two different things at two levels; the local names say
  // which is which rather than making either give up the obvious name.
  attachPlate as attachPlateToArchive,
  attachProtocol as attachProtocolToArchive,
  buildExperimentArchive,
  formatRunDefinitionText,
  hasZpcrwebSettings,
  isBiomemeJson,
  markExperimentBegun,
  parseBiomeme,
  parsePcrd,
  parsePlateCsv,
  parsePltd,
  parseRunDefinitionText,
  parseZpcr,
  parseZpcrArchive,
  parseZpcrwebSettings,
  runCompleteness,
  runProgressFromNames,
  wellKey,
  unzipArchive,
  writeZpcrwebSettings,
  zipArchive,
  type AnalysisSource,
  type ZpcrArchive,
  type ExperimentArchiveParts,
  type FileKind,
  type NormalizationMode,
  type PlateDefinition,
  type PltdContainer,
  type Zpcr,
} from "@zpcrweb/core";

export { wellKey, type AnalysisSource };
import {
  deleteFile,
  fileId,
  getAllEntries,
  getFileContent,
  putFile,
  updateEntry,
  type FileIdentity,
  type FileSummary,
  type StoredEntry,
  type StoredView,
} from "./db";
import {
  ANALYSIS_KEYS,
  DEFAULT_THRESHOLD_MULTIPLIER,
  analysisFromZpcrweb,
  defaultAnalysisSettings,
  isAnalysisKey,
  zpcrwebFromAnalysis,
  type AnalysisSettings,
} from "./analysisSettings";
import { AnalysisPersister } from "./analysisPersist";
import {
  contentBytes,
  contentFiles,
  contentSize,
  fromStoredContent,
  loadedRunContent,
  parseContent,
  runContent,
  toStoredContent,
  zippedContent,
  type FileContent,
} from "./fileContent";
import { WriteThrottle } from "./writeThrottle";
import {
  experimentIdentity,
  isPendingExperiment,
  restampExperimentDate,
  type ExperimentIdentity,
} from "../lib/experiment";
import { summarizeFile } from "../lib/fileSummary";
import { usePltdPassword } from "./pltdPassword";
import { onHashChange, readHash, writeHash } from "./urlHash";

export { DEFAULT_THRESHOLD_MULTIPLIER } from "./analysisSettings";

/** The accepted encodings, and their grouping into runs/plates/protocols, are the library's
 * (`core/fileKind.ts`) — re-exported here because the store's `LoadedFile` is where the app meets
 * them. */
export type { FileKind };
/**
 * How often an edited protocol file may be rewritten to IndexedDB — see
 * {@link ZpcrStore.setProtocolText}. Short, because a `.prcl.txt` is a few hundred bytes; the
 * archive rewrite an analysis edit costs is spaced a minute apart instead (`analysisPersist.ts`).
 */
const PROTOCOL_WRITE_INTERVAL_MS = 2_000;

/** The two kinds a plate — standalone or attached to a run — can be uploaded as. */
type PlateFileKind = "pltd" | "csv";

/** `"about"` is not a tab in `ViewBar` — it's reached by clicking the logo — but it
 * is a view like any other, so it's linkable (`#view=about`) and works with back/forward.
 * `"files"` (the full files table, `FilesTableView.tsx`) is a real tab, but — like `"instrument"`
 * — isn't a lens on the active file, so it sits in its own group there rather than the main one.
 * Both are linkable too: every id here is in `urlHash.ts`'s VIEW_IDS, so nothing the tab strip
 * (or the logo) can reach is a state the URL can't name. */
export type ViewId =
  | "overview"
  | "protocol"
  | "curves"
  | "plates"
  | "reference"
  | "calibration"
  | "raw"
  | "instrument"
  | "files"
  | "about";
/** Reference view only — drift relative to the factory calibration value; see `ReferenceView`. */
export type Baseline = "raw" | "delta" | "percent";
/**
 * Curves view only — what the chart plots each curve as. Baselining itself is never
 * configurable: it's always an auto-detected linear baseline (`threshold.md` §4's
 * `LinearBaseLineNormalized`, region from `baselineRegion`) — `"relative"` plots the
 * baseline-corrected curve, `"absolute"` plots the raw curve unmodified. Cq/analysis always use
 * the baseline-corrected values regardless of which is shown.
 */
export type CurveView = "relative" | "absolute";
/**
 * Calibration view only — which of the two levels a `.Dcal` carries the chart plots.
 * `"relative"` is the response the algorithm actually consumes, `max(0, dye − empty)`
 * (`calibration.md` §2); `"absolute"` plots the two raw readings that difference is taken
 * between, the pure-dye plate and the empty-plate baseline. The algorithm is unaffected either
 * way — this only changes what is drawn.
 */
export type CalView = "relative" | "absolute";
export type Scale = "linear" | "log";
/**
 * Reference view only — what the chart's x axis runs over. `"cycle"` is the normal time series,
 * one line per (channel, reference column). `"column"` collapses each of those lines to its
 * mean over all cycles and plots it against the plate column instead, giving one line per
 * channel across R1-R12: the shape of the reference row itself, rather than its stability over
 * a run. The dark overlay, having no column dependence, becomes a flat line there — like the
 * factory line already is in cycle mode.
 */
export type RefXAxis = "cycle" | "column";
/**
 * What the Curves view's main pane shows once color separation is on: dye-space curves grouped
 * by fluorophore or by target/gene, or — `"table"` — the run's Cq/ΔRFU table in place of the
 * chart (the former standalone Analysis view). Table mode groups by target, like `"target"`.
 */
export type FluorViewMode = "fluorophore" | "target" | "table";
// `AnalysisSource` is `@zpcrweb/core`'s own type (see `runAnalysis.ts`'s `blendWithFileAnalysis`
// for exactly what the two toggles below swap) — re-exported above, not redeclared here.

/**
 * Per-file settings, in-memory form (Sets for cheap toggling) — everything a view reads off
 * `store.settings`, from both of the two places they're kept:
 *
 * - the fields declared below are **display** state, persisted per file in IndexedDB (`db.ts`);
 * - the fields inherited from {@link AnalysisSettings} are **analysis** state, persisted in the
 *   run's own archive as `zpcrweb.json` (`analysisSettings.ts`).
 *
 * The split is invisible to call sites on purpose: they patch one flat object through
 * `updateSettings`, which routes each key to its own store. See `analysisSettings.ts` for why
 * anything that changes a reported number has to live in the file.
 */
export interface FileSettings extends AnalysisSettings {
  enabledChannels: Set<number>;
  enabledWells: Set<string>; // "row,col"
  /** Reference columns (0-based) shown in the Reference chart. */
  enabledRefCols: Set<number>;
  baseline: Baseline;
  /** Curves view's display mode; see {@link CurveView}. */
  curveView: CurveView;
  /** Curves view: overlay the auto-detected linear baseline itself on each curve, at 50%
   * opacity of the curve's own color. Off by default. */
  drawBaseline: boolean;
  scale: Scale;
  /** Overlay each channel's dark (LED-off) background as a dotted line. Channel-space only —
   * see the "What actually gets plotted" note in CurvesView. */
  showDark: boolean;
  /** Reference view: overlay each reference well's `FactoryRefRowCal` value as a flat dotted
   * line. On by default — comparing live against factory is what that view is for — and, like
   * {@link showDark}, only drawn under the Raw baseline, since ΔRFU/Drift % already plot the
   * live curve relative to it. */
  showFactory: boolean;
  /** Reference view: what the x axis runs over; see {@link RefXAxis}. */
  refXAxis: RefXAxis;
  /** Draw each channel's min/max envelope band. Channel-space only, like {@link showDark}, and
   * off by default — with more than a well or two selected the envelopes overlap into noise. */
  bands: boolean;
  /** Selected protocol step (`STEP` value), or null to use the first step. */
  step: number | null;
  /**
   * Temperature field keys (e.g. `BLOCKTEMP`) plotted on the chart's right axis. Empty
   * hides the temperature axis entirely.
   *
   * Mutually exclusive with {@link leds} — there is one right axis, and °C and DAC counts share
   * no scale, so `updateSettings` clears whichever set the caller didn't just fill (see
   * `rightAxis.ts`).
   */
  temps: Set<string>;
  /**
   * LED drive-current field keys (e.g. `LEDCURRENT01`) plotted on the chart's right axis, in
   * DAC counts. Empty hides the axis; non-empty clears {@link temps}.
   */
  leds: Set<string>;
  /**
   * Channel→dye color separation (see `calibration.md`). `null` auto-enables it once plate
   * data and matching `.Dcal` calibration data are both available; `true`/`false` is an
   * explicit user override.
   */
  calibration: boolean | null;
  /** When color separation is on, group/label curves by fluorophore or by target/gene (each
   * target listed separately, still colored by its channel/fluorophore — see `pltd.md`). */
  fluorViewMode: FluorViewMode;
  /** Fluorophore (or, in target view mode, target) names hidden from the dye-space curves (an
   * opt-out set, like `enabledChannels` inverted — new entries default to shown without needing
   * to know their names up front). */
  disabledFluors: Set<string>;
  /** Curves view: sample names (`PlateDefinition.samples`) hidden from the plotted curves — an
   * opt-out set, like {@link disabledFluors}. New samples default to shown. */
  disabledSamples: Set<string>;
  /** When true, draw a dye-space curve for every enabled well/fluor pair regardless of whether
   * the plate definition actually loads that fluor into that well. Off by default — the normal
   * behavior only draws curves pltd.md's per-well dye layers actually cover. */
  showUnloadedFluors: boolean;
  /**
   * Curves view, dye space only: hide every curve whose Cq falls outside `[cqMin, cqMax]`, in
   * cycles. `null` on either side means unbounded there, and both `null` (the default) is no
   * filtering at all.
   *
   * A curve the run gave **no** Cq — it never crossed its threshold — is shown iff
   * {@link cqMax} is `null`, which is what makes the slider's top stop ("none") mean "and the
   * ones that never amplified". Selecting only those is `cqMin` above the last cycle with
   * `cqMax` still `null`: no real Cq can satisfy it, so what's left is exactly the no-Cq
   * curves.
   *
   * A display filter like the well/chip/sample selections it sits with — it changes which
   * curves are drawn, which rows the table lists and which rows the CSV exports, but never a
   * number: thresholds and Cq are computed over the whole plate (`runAnalysis.ts`) and never
   * over the plotted subset.
   */
  cqMin: number | null;
  cqMax: number | null;
  /**
   * Calibration view: which `.Dcal` files are plotted, as `${dye}|${plateType}` keys (see
   * `calibrationCurves.ts`'s `calKey`). An opt-**in** set, unlike {@link disabledFluors}: a run
   * ships a calibration for every dye Bio-Rad sells on both tube types, and all 28 at once is
   * unreadable. Empty means "not chosen yet" — the view seeds it from the run (the files the
   * analysis actually uses) the first time it has the calibration data to do so.
   */
  calFiles: Set<string>;
  /** Calibration view: response curves, or the raw dye/empty readings behind them; see
   * {@link CalView}. */
  calView: CalView;
  /** See {@link AnalysisSource}. */
  baselineSource: AnalysisSource;
  /** See {@link AnalysisSource}. */
  cqSource: AnalysisSource;
  /**
   * Whether this file's content has been edited since it was loaded — a threshold moved, the run
   * renamed, a plate attached — and not yet downloaded. The odd one out in this interface: not a
   * view setting at all, and no view reads it. It is kept here because call sites want one flat
   * per-file object; on the record it is a field of its own (`StoredEntry.modified`), kept for
   * every file rather than only loaded ones, since the stale copy is the one on the user's disk
   * whether or not this browser still holds the bytes. Surfaced to the UI as
   * {@link ZpcrStore.modifiedIds}, which is what makes the file chip's delete ask twice.
   */
  modified: boolean;
  /**
   * Whether this file is **loaded**: its bytes in memory, decoded, a chip on the file bar and a
   * candidate for the tab strip. Unchecking it in the full files table (see `FilesTableView.tsx`)
   * releases the bytes without touching the file itself — it stays in IndexedDB and in that
   * table, described by its cached summary (`lib/fileSummary.ts`). Selecting a file anywhere (the
   * table, a `#file=` link) loads it, since the one selected file is by definition one the app is
   * showing.
   *
   * Persisted so a session reopens holding what it was working on rather than every archive the
   * browser has ever seen — the whole point of separating the two sets. It is also what decides
   * whether the rest of this object is persisted at all: a released file keeps no display state
   * (see `db.ts`'s `StoredEntry.view`), so loading it again starts from {@link defaultSettings}.
   */
  loaded: boolean;
}

/**
 * One file in the app's catalog — **every** file, loaded or not. Metadata only: the identity
 * IndexedDB records under its id, plus the cached {@link FileSummary} of what its content said
 * the last time it was loaded (null for one that never has been).
 *
 * This is what the Files table lists, and it is deliberately not a {@link LoadedFile}: a browser
 * holding a thousand archives must be able to describe all of them without any of their bytes
 * being read. See `apps/web/ARCHITECTURE.md`, "Files, loaded files, and the one selection".
 */
export interface FileEntry {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  lastModified: number;
  kind: FileKind;
  summary: FileSummary | null;
}

/** A file loaded into memory — content only. Parsing is derived (see {@link ZpcrStore.runs}),
 * since a `.pcrd`'s decode depends on the (mutable, shared) decryption password. */
export interface LoadedFile {
  id: string;
  name: string;
  /** What the app reports as this file's size; see `fileContent.ts`'s `contentSize`. */
  size: number;
  addedAt: number;
  kind: FileKind;
  /**
   * The file itself — its bytes, or (for a run still being written to) its archive entries held
   * open. `fileContent.ts` owns the distinction and every operation on it: `fileBytes(file)` for
   * the bytes, `contentFiles`/`runContent` for the edit path. Nothing outside that module should
   * branch on `content.exploded`.
   */
  content: FileContent;
  /** The source `File`'s own `lastModified` (its OS mtime, epoch ms) — see
   * `db.ts`'s `StoredFile.lastModified`. */
  lastModified: number;
}

/** A loaded file's bytes, zipping an open archive if that's how it's held — see
 * `fileContent.ts`'s `contentBytes` for when that is and isn't appropriate. */
export function fileBytes(file: LoadedFile): Uint8Array {
  return contentBytes(file.content);
}

/** A loaded file's identity, as its catalog record carries it. */
function identityOf(file: LoadedFile): FileIdentity {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    addedAt: file.addedAt,
    kind: file.kind,
    lastModified: file.lastModified,
  };
}

/** Persist a loaded file — the one place a `db.ts` write is assembled from a {@link LoadedFile}, so
 * the choice of storage representation is made once (`toStoredContent`) rather than at each of
 * the dozen call sites that persist a file. `analysis` is the file's file-backed settings, layered
 * in on the way out; see {@link contentToStore} for why every write has to carry them. */
function persistFile(file: LoadedFile, analysis?: AnalysisSettings): Promise<void> {
  return putFile(identityOf(file), toStoredContent(contentToStore(file, analysis)));
}

/**
 * What actually gets stored for a file: its archive with the app's own `zpcrweb.json` layered in.
 *
 * A loaded `.zpcr`'s in-memory archive deliberately carries **no** settings entry — the run's name
 * and its thresholds live in `analysisMap`, and are written into the archive only on the way out
 * (`analysisPersist.ts` for the throttled save, `exportBytes` for a download). That split means any
 * write of the file's *content* for some other reason — a rename, a protocol edit, a plate read
 * arriving — would store an archive with the entry missing, and silently drop them. Naming a
 * pending experiment did exactly that: the name renames the file in the same breath (`App.tsx`'s
 * `nameExperiment`), and the renamed record was written from the settings-free copy, so the name
 * was gone on the next reload.
 *
 * Free for a run held open (one more entry in an object). An unzip and a re-zip for a finished one,
 * which is what editing a finished archive costs anyway — and skipped entirely when there is
 * nothing to write, which is the case for every file that is merely being loaded or released.
 */
function contentToStore(file: LoadedFile, analysis: AnalysisSettings | undefined): FileContent {
  if (file.kind !== "zpcr" || !analysis) return file.content;
  const doc = zpcrwebFromAnalysis(analysis);
  if (!hasZpcrwebSettings(doc)) return file.content;
  try {
    return runContent(writeZpcrwebSettings(contentFiles(file.content), doc));
  } catch {
    // Not an archive this build can rewrite: store what we have rather than losing the write.
    return file.content;
  }
}

/**
 * A loaded file with new content — its size follows, since that is what the app reports and what
 * its id would hash from (`fileContent.ts`'s `contentSize`).
 *
 * `lastModified` deliberately does not: every caller of this is the app editing a file in place,
 * not a new one arriving from the OS, so the file keeps the source mtime it was loaded with (see
 * `db.ts`'s `StoredFile.lastModified`).
 */
function withContent(file: LoadedFile, content: FileContent): LoadedFile {
  return { ...file, content, size: contentSize(content) };
}

/** Replace one file in a list, by id — the shape every in-place edit below updates state with. */
function replaceFile(files: LoadedFile[], next: LoadedFile): LoadedFile[] {
  return files.map((f) => (f.id === next.id ? next : f));
}

/**
 * The outcome of parsing one {@link LoadedFile} against the current password.
 *
 * Everything here except {@link RunResult.documentXml} is format-neutral, and that is the point:
 * once a run has parsed, the app works off `zpcr` alone and cannot tell which format it came from
 * (see `apps/web/ARCHITECTURE.md`, "Format independence"). This type is the boundary where that
 * becomes true, so it is where the last format branches live.
 */
export interface RunResult {
  /** The decoded run, once available (immediately for `.zpcr`; after a correct password for
   * `.pcrd`). */
  zpcr: Zpcr | null;
  /** True when this is an encrypted `.pcrd` and no (or the wrong) password has been tried yet
   * — distinct from `error`, which means a password was tried and failed. */
  needsPassword: boolean;
  error: string | null;
  /**
   * Whether the run file is *itself* one encrypted container — true only for an encrypted
   * `.pcrd`. A `.zpcr`'s outer archive is never encrypted (whatever its embedded `.pltd`/`.prcl`
   * entries are), so this is false for one, and {@link runEncryptionStatus} then answers from
   * those entries instead.
   *
   * Deliberately a boolean rather than the `PcrdContainer` this used to be. The container object
   * is `.pcrd`-only detail, and the only thing any view outside the raw view ever asked it was
   * "encrypted?" — so the store answers that question here, once, and no view has to know a
   * container exists.
   */
  selfEncrypted: boolean;
  /**
   * A `.pcrd`'s full raw decrypted document — there's no inner-file archive to browse (see
   * `Zpcr.archive`'s doc comment), so the app's `.pcrd` raw view renders this directly as a
   * real XML tree. Undefined for `.zpcr` (and for a `.pcrd` before/without a working password).
   *
   * **Raw view only.** This is the one genuinely format-specific payload the app carries, and
   * `App.tsx` hands it to `PcrdRawView` and nowhere else.
   */
  documentXml?: string;
}

/**
 * The app's format boundary: every source format goes in, one {@link RunResult} comes out. Every
 * `kind === "pcrd"` test in the app that isn't about the raw view should be here instead.
 */
function parseRun(
  content: FileContent,
  kind: "zpcr" | "pcrd" | "biomeme",
  password: string,
): RunResult {
  if (kind === "zpcr" || kind === "biomeme") {
    try {
      // A `.zpcr` parses from whichever form it's held in without being zipped or unzipped when
      // it's already open (`fileContent.ts`); the other two formats are only ever bytes.
      const zpcr = kind === "zpcr" ? parseContent(content) : parseBiomeme(contentBytes(content));
      return { zpcr, needsPassword: false, error: null, selfEncrypted: false };
    } catch (e) {
      return {
        zpcr: null,
        needsPassword: false,
        error: e instanceof Error ? e.message : String(e),
        selfEncrypted: false,
      };
    }
  }
  const pcrd = parsePcrd(contentBytes(content), password ? { password } : undefined);
  return {
    zpcr: pcrd.zpcr ?? null,
    needsPassword: !!pcrd.needsPassword,
    error: pcrd.error ?? null,
    // Collapse the `.pcrd` container to the one fact anything outside the raw view needs. The
    // container itself is available even before a working password, and so is this.
    selfEncrypted: !!pcrd.container?.encrypted,
    documentXml: pcrd.xml,
  };
}

/** The outcome of parsing a standalone `.pltd`/`.csv` plate file (a top-level entry, or a
 * run's plate-override attachment) against the current password. */
export interface PlateFileResult {
  plate: PlateDefinition | null;
  needsPassword: boolean;
  error: string | null;
  /** `.pltd` container metadata (including `encrypted`), available even before/without a
   * working password. Undefined for a `.csv`, which has no such container. */
  container?: PltdContainer;
}

function parsePlateBytes(
  kind: PlateFileKind,
  bytes: Uint8Array,
  password: string,
  name: string,
): PlateFileResult {
  if (kind === "pltd") {
    const pltd = parsePltd(bytes, password ? { password } : undefined);
    return {
      plate: pltd.plate ?? null,
      needsPassword: !!pltd.needsPassword,
      error: pltd.error ?? null,
      container: pltd.container,
    };
  }
  try {
    // The file name is the plate's identity — a `.plt.csv` carries no identityKey of its own.
    //
    // No `channelForFluor`: standing on its own, a plate CSV has no `.Dcal` set to resolve its
    // dye-named fluor columns against, so every fluor's channel is simply unknown and the
    // plate views show it as such. Borrowing the mapping from some other run that happens to be
    // loaded would be a guess about a different instrument's optics.
    return {
      plate: parsePlateCsv(new TextDecoder().decode(bytes), { sourceName: name }),
      needsPassword: false,
      error: null,
    };
  } catch (e) {
    return { plate: null, needsPassword: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The display half of the defaults; the analysis half comes from
 * {@link defaultAnalysisSettings}, and from the file when it has a `zpcrweb.json`. */
function defaultSettings(): FileSettings {
  const wells = new Set<string>();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 12; col++) wells.add(wellKey(row, col));
  }
  return {
    // Channels 1–5 (the standard dye set) on by default; channel 6 (FRET) is off — it is a
    // real optical channel but standard runs don't use it. The user can toggle it on.
    enabledChannels: new Set([0, 1, 2, 3, 4]),
    enabledWells: wells,
    // All 12 reference columns on by default in the Reference view.
    enabledRefCols: new Set(Array.from({ length: 12 }, (_, c) => c)),
    baseline: "raw",
    // Relative (baseline-corrected) shows the curve every Cq is actually taken against —
    // threshold.md §4's `LinearBaseLineNormalized`.
    curveView: "relative",
    drawBaseline: false,
    scale: "linear",
    showDark: false,
    // On by default: the live-vs-factory comparison is the Reference view's whole purpose.
    showFactory: true,
    refXAxis: "cycle",
    bands: false,
    step: null,
    // Temperatures and LED currents are off by default — instrument context, not the
    // measurement.
    temps: new Set<string>(),
    leds: new Set<string>(),
    // Auto: on once plate + calibration data are available (see CurvesView).
    calibration: null,
    fluorViewMode: "target",
    disabledFluors: new Set<string>(),
    disabledSamples: new Set<string>(),
    showUnloadedFluors: false,
    // Unfiltered: every Cq, plus the curves that never crossed their threshold.
    cqMin: null,
    cqMax: null,
    // Empty = unseeded; the Calibration view fills it from the run's own calibration set.
    calFiles: new Set<string>(),
    // The response curve is what the algorithm consumes, so it's what the view leads with.
    calView: "relative",
    // "file": a Biomeme user opened the file to see the instrument's own call, not this app's.
    baselineSource: "file",
    cqSource: "file",
    // A freshly loaded file is by definition the copy on disk.
    modified: false,
    // A file arrives by being loaded — dropping one, or opening it from the table — so this is
    // true from the outset; it only ever goes false by someone releasing the file.
    loaded: true,
    ...defaultAnalysisSettings(),
  };
}

/**
 * The display half of a file's settings, as its record's {@link StoredView} — sets flattened to
 * arrays, and the analysis fields pointedly not written (they live in the file; see
 * {@link FileSettings}). {@link FileSettings.modified} and {@link FileSettings.loaded} aren't here
 * either: they are fields of the record itself, kept for every file rather than only loaded ones.
 */
function viewOf(s: FileSettings): StoredView {
  return {
    enabledChannels: [...s.enabledChannels],
    enabledWells: [...s.enabledWells],
    enabledRefCols: [...s.enabledRefCols],
    baseline: s.baseline,
    curveView: s.curveView,
    drawBaseline: s.drawBaseline,
    scale: s.scale,
    showDark: s.showDark,
    showFactory: s.showFactory,
    refXAxis: s.refXAxis,
    bands: s.bands,
    step: s.step ?? null,
    temps: [...s.temps],
    leds: [...s.leds],
    calibration: s.calibration,
    fluorViewMode: s.fluorViewMode,
    disabledFluors: [...s.disabledFluors],
    disabledSamples: [...s.disabledSamples],
    showUnloadedFluors: s.showUnloadedFluors,
    cqMin: s.cqMin,
    cqMax: s.cqMax,
    calFiles: [...s.calFiles],
    calView: s.calView,
    baselineSource: s.baselineSource,
    cqSource: s.cqSource,
  };
}

/**
 * A file's settings as its record holds them: the two flags, plus the display state if the file
 * was loaded when the session ended. A released file has no {@link StoredEntry.view} by
 * construction (see the field), so it comes back on defaults — the deliberate other half of not
 * keeping view state for every file the browser has ever seen.
 *
 * Analysis fields are *not* read from the record: they come from the file's own `zpcrweb.json`,
 * and are merged in by the store's seeding effect.
 */
function fromStored(e: StoredEntry): FileSettings {
  const v = e.view;
  if (!v) return { ...defaultSettings(), modified: e.modified, loaded: e.loaded };
  return {
    enabledChannels: new Set(v.enabledChannels),
    enabledWells: new Set(v.enabledWells),
    enabledRefCols: new Set(v.enabledRefCols),
    baseline: v.baseline,
    curveView: v.curveView,
    drawBaseline: v.drawBaseline,
    scale: v.scale,
    showDark: v.showDark,
    showFactory: v.showFactory,
    refXAxis: v.refXAxis,
    bands: v.bands,
    step: v.step,
    calibration: v.calibration,
    fluorViewMode: v.fluorViewMode,
    disabledFluors: new Set(v.disabledFluors),
    disabledSamples: new Set(v.disabledSamples),
    showUnloadedFluors: v.showUnloadedFluors,
    cqMin: v.cqMin,
    cqMax: v.cqMax,
    calFiles: new Set(v.calFiles),
    calView: v.calView,
    baselineSource: v.baselineSource,
    cqSource: v.cqSource,
    temps: new Set(v.temps),
    // Both being non-empty is impossible by construction (see `updateSettings`), so nothing
    // needs reconciling here.
    leds: new Set(v.leds),
    modified: e.modified,
    loaded: e.loaded,
    ...defaultAnalysisSettings(),
  };
}

/** True for file names this app knows how to load. A `.json` is only accepted once its content
 * actually looks like a Biomeme run export (see {@link isBiomemeJson}) — the extension alone is
 * too generic a signal to route into the app's parse/validate path on. */
function fileKind(name: string, bytes?: Uint8Array): FileKind | null {
  if (/\.zpcr$/i.test(name)) return "zpcr";
  if (/\.pcrd$/i.test(name)) return "pcrd";
  if (/\.pltd$/i.test(name)) return "pltd";
  if (/\.csv$/i.test(name)) return "csv";
  if (/\.json$/i.test(name) && bytes && isBiomemeJson(bytes)) return "biomeme";
  // `.txt` is far too generic an extension to route on, so it is admitted only when the content
  // really is a run definition (`prcl.md` §3.1) — the same content-sniffing rule `.json` gets
  // above. That also lets an instrument's own `ProtocolRunDefinition.txt` in unrenamed.
  if (/\.txt$/i.test(name) && bytes && looksLikeProtocolText(bytes)) return "prcl";
  return null;
}

/** True when these bytes parse as a thermal-protocol run definition. */
function looksLikeProtocolText(bytes: Uint8Array): boolean {
  try {
    parseRunDefinitionText(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

/**
 * The file name a `#load=` URL delivers: its last path segment, percent-decoded (query and
 * fragment dropped). The name is the app's user-facing identity for a file — it's what `#file=`
 * links to and what the file bar shows — so a URL-loaded file is named after its path, exactly
 * as the same file downloaded and dropped would be.
 */
function fileNameFromUrl(url: string): string {
  const path = new URL(url, window.location.href).pathname;
  const last = path.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last; // malformed %-escapes: the raw segment is still a usable name
  }
}

/** `.pltd` or `.csv`/`.plt.csv` (case-insensitive), or `null` — the two formats accepted for
 * attaching a plate to a run (see the Plates view's upload control). */
function plateFileKind(name: string): PlateFileKind | null {
  if (/\.pltd$/i.test(name)) return "pltd";
  if (/\.csv$/i.test(name)) return "csv";
  return null;
}

/** Options for {@link ZpcrStore.addFiles}. */
export interface AddFilesOptions {
  /**
   * Whether the last file added becomes the active one. Default true — dropping a file means
   * wanting to look at it.
   *
   * The run watcher passes false ordinarily. It re-adds the in-progress run every time a cycle
   * completes, and each snapshot is a *new* file id (ids hash name+size, and the archive grows),
   * so activating unconditionally would drag the user back to the running experiment every
   * minute or two no matter what they had opened. It passes true instead for the snapshot that
   * comes from a run *starting* in this session (`App.tsx`'s `freshStart`) — that one file the
   * user watching it begin wants selected, superseding whatever was active before.
   */
  activate?: boolean;
  /**
   * Mark the added file(s) as {@link FileSettings.modified} from the moment they land, rather
   * than the ordinary "a freshly loaded file matches disk" default. The instrument's own file
   * chips are the only caller: a run pulled off the CFX — in progress or just finished — exists
   * nowhere but the browser until it's actually saved, exactly like an edited file whose disk
   * copy has gone stale, so its delete chip should ask twice too. {@link markDownloaded} clears
   * it the same way a download does for any other file.
   */
  modified?: boolean;
}

export interface ZpcrStore {
  /**
   * The catalog: **every** file the browser holds, metadata only (see {@link FileEntry}). The
   * Files table's rows, and the set a file is deleted from.
   */
  files: FileEntry[];
  /**
   * The **loaded** set: the files whose bytes are in memory and decoded — the file bar's chips,
   * and the only files the rest of the app can show. A subset of {@link files}, oldest first by
   * `addedAt`, so the chips keep their places across a reload however the loads were ordered.
   */
  loaded: LoadedFile[];
  /** Ids of {@link loaded}, for a membership test that doesn't scan the array. */
  loadedIds: Set<string>;
  /**
   * Ids currently being read out of IndexedDB by {@link setLoaded} — a file that has been asked
   * for but whose bytes haven't arrived. {@link activeId} may name one, which is what lets a click
   * in the Files table select a file immediately instead of waiting on a disk read.
   */
  loadingIds: Set<string>;
  /**
   * Load or release a file. Loading reads its bytes from IndexedDB, decodes it, gives it a chip
   * and (once decoded) refreshes its cached summary; releasing drops the bytes from memory,
   * leaving the file in storage and in the Files table exactly as it was.
   *
   * Releasing the selected file moves the selection to another loaded file, or clears it — the
   * one selection always names a loaded file or nothing at all.
   */
  setLoaded: (fileId: string, loaded: boolean) => Promise<void>;
  /**
   * The single selection: the one file every tab in the strip is a lens on, or `null` when
   * nothing is selected (everything released, or a `#file=` naming a file this browser doesn't
   * have). Never names an unloaded file.
   */
  activeId: string | null;
  active: LoadedFile | null;
  /** Parse result for every loaded `.zpcr`/`.pcrd` file, keyed by id — recomputed when the
   * shared decryption password changes, so a `.pcrd` unlocks reactively without reloading. */
  runs: Map<string, RunResult>;
  activeRun: RunResult | null;
  /** Parse result for every loaded standalone `.pltd`/`.csv` file, keyed by id. */
  plateFiles: Map<string, PlateFileResult>;
  /** `.prcl.txt` entries, id → canonical one-line run definition (`prcl.md` §3.1). */
  protocolFiles: Map<string, string>;
  /**
   * What each loaded file is called and when it was run, keyed by id — the file bar's chip text
   * and the Overview view's headline (see `lib/experiment.ts`).
   *
   * Store-level rather than per-view because the bar needs it for *every* file while
   * {@link ZpcrStore.settings} is assembled only for the active one. The stored name comes from
   * the same live analysis state, so a rename shows on the chip immediately rather than after
   * the archive's next rewrite.
   */
  experiments: Map<string, ExperimentIdentity>;
  activePlateFile: PlateFileResult | null;
  /** The selected file's run definition, when the selection is a `.prcl.txt` — what the
   * protocol Overview renders, the counterpart of {@link activePlateFile}. */
  activeProtocolFile: string | null;
  /**
   * Ids of the files whose content has been edited since they were loaded and not since
   * downloaded — thresholds, the experiment name, an attached plate (see
   * {@link FileSettings.modified}). The file bar reads it to decide whether deleting a chip
   * throws work away, and so has to be confirmed.
   */
  modifiedIds: Set<string>;
  /**
   * The user has just saved this file to disk: its edits are no longer at risk, so it stops
   * counting as modified. Called by the Overview toolbar's download button, whichever kind's
   * Overview it is — the one that writes the *whole* file ({@link ZpcrStore.exportBytes}: a
   * `.zpcr` including its `zpcrweb.json`, an edited `.prcl.txt` including its edits), and so the
   * only download that actually gets the edits out of the browser.
   */
  markDownloaded: (fileId: string) => void;
  /**
   * Attach (or replace) a `.zpcr` run's plate: rewrites the run's own archive bytes in place
   * (adding/replacing a `.pltd`/`.plt.csv` entry — see core's `attachPlate`) and persists the
   * result, so the plate travels with the file from then on and `zpcr.plates()` picks it up
   * with no separate override state. Only valid for a `kind === "zpcr"` run; sets `error`
   * otherwise (a `.pcrd` has no real archive to attach an entry to).
   */
  attachPlate: (fileId: string, file: File) => Promise<void>;
  /**
   * Attach (or replace) a `.zpcr` run's thermal protocol — the protocol-side mirror of
   * {@link attachPlate}, and what `AttachProtocolMenu` calls. Same restriction: only
   * `kind === "zpcr"`.
   */
  attachProtocol: (fileId: string, file: File) => Promise<void>;
  /**
   * Build a bare pending `.zpcr` (`core/buildExperimentArchive`) and load it as a new file, named
   * with today's date and no experiment name yet (`runFileBaseName` refuses an empty name, so the
   * bare date stamp is built directly rather than through it). Used by both "New experiment"
   * (About, with `parts: {}`) and "Clone experiment" (Overview/Instrument, with the source run's
   * protocol/plate) — they differ only in what `parts` they pass. Returns the new file's id, for
   * the caller to switch to Overview and focus the name field.
   */
  createExperiment: (parts: ExperimentArchiveParts) => Promise<string | null>;
  /**
   * The in-place-editing counterpart to {@link attachProtocol}: same `attachProtocol` call
   * (no name change, just new text), throttled the way {@link setProtocolText} throttles a
   * standalone `.prcl.txt`'s writes — the same {@link WriteThrottle}, keyed by this file's id
   * rather than a second one. Only valid while the target file is pending (`isPendingExperiment`)
   * — the caller's responsibility; `ProtocolView` only renders the editor in that state.
   */
  setRunProtocolText: (fileId: string, runDefinition: string) => void;
  /**
   * Name (or rename) a run's own protocol — the `ProtocolName.txt` entry, which is what the Protocol
   * tab's headline shows and edits. A standalone `.prcl.txt` has no such entry: its name *is* its
   * file name, so that case goes through {@link renameFile} instead.
   */
  setRunProtocolName: (fileId: string, name: string) => Promise<void>;
  /**
   * Turn a pending experiment into a started run, in place — what the Instrument tab's Start
   * button calls instead of seeding a new file. Restamps the file's date if it still carries the
   * one it was created/cloned under (`restampExperimentDate`, via the ordinary `renameFile` so
   * ids and IndexedDB stay consistent), then writes the `begun` marker
   * (`core/markExperimentBegun`). Returns the final file's id and name — which may differ from
   * `fileId`'s if it was restamped — or `null` for a file that isn't a `kind === "zpcr"` pending
   * experiment.
   */
  beginExperiment: (fileId: string) => Promise<{ id: string; name: string } | null>;
  /**
   * Rename a loaded file — what the Overview view's rename control calls. `newName` becomes
   * {@link LoadedFile.name}; bytes and content are untouched. A no-op for an empty name or one
   * that's already current.
   *
   * Ids hash name+size ({@link fileId}), so this necessarily gives the file a new id: every
   * id-keyed map (`settingsMap`, `analysisMap`, `activeId`) is migrated, and a name+size that
   * collides with an already-loaded file supersedes it, the same way re-uploading a same-named
   * file does in {@link ZpcrStore.addFiles}. Marks the file {@link FileSettings.modified}, since
   * a download now writes different bytes-under-a-name than what's on disk under the old one.
   */
  renameFile: (fileId: string, newName: string) => Promise<void>;
  /**
   * Replace a standalone protocol file's contents with an edited run definition — what the
   * Protocol view's editor calls after every change (`ProtocolEditor.tsx`).
   *
   * The one-line `runDefinition` is rendered to the `.prcl.txt` line-per-directive form
   * (`formatRunDefinitionText`, `prcl.md` §3.1); nothing else here knows how a protocol is
   * spelled. The bytes in React state update at once, so the view re-renders from the file it
   * just wrote; the IndexedDB write is rate-limited by the shared {@link WriteThrottle} the way
   * an analysis edit is (`writeThrottle.ts`), so holding an arrow key on a temperature field
   * doesn't rewrite the record per keystroke. It is *not* deferred until the editor is closed —
   * "Done" is a UI mode, not a save button.
   *
   * A no-op for a file that isn't `kind === "prcl"`.
   */
  setProtocolText: (fileId: string, runDefinition: string) => void;
  settings: FileSettings | null;
  /** Selected top-level view (Overview/Curves/…) — global across all loaded files, not
   * per-file, so switching files doesn't reset it. */
  view: ViewId;
  setView: (v: ViewId) => void;
  loading: boolean;
  error: string | null;
  /** Resolves to the id of the file left active — the last one that loaded — or `null` when
   * every candidate was rejected (the reason is in {@link error}). A caller that only drops
   * files can ignore it; one that wants to *go* to what it just added can't, since the store's
   * own state hasn't re-rendered yet at that point. */
  addFiles: (files: FileList | File[], options?: AddFilesOptions) => Promise<string | null>;
  /**
   * Load a `.zpcr` handed over as its archive entries rather than as a file — {@link addFiles}
   * without the ZIP in the middle, and otherwise identical: the archive is validated, superseded
   * against the same name, persisted, loaded and activated exactly as a dropped file is.
   *
   * This is how a run being followed reaches the store (`useRunWatch`). Each cycle re-assembles the
   * run's whole folder, and zipping that only for the store to unzip it again to read it was the
   * bulk of what a plate read cost. A run in progress is then also *kept* open (`fileContent.ts`),
   * so the next cycle appends to it, and the end-of-run snapshot — the first carrying `ended` — is
   * the one that becomes an ordinary zipped `.zpcr`.
   *
   * Returns the new file's id, or `null` if the archive wouldn't parse (the reason lands in
   * {@link error}, as with `addFiles`).
   */
  addRunArchive: (
    name: string,
    archive: ZpcrArchive,
    options?: AddFilesOptions,
  ) => Promise<string | null>;
  /**
   * Ids of the loaded runs that are still running on an instrument — `begun` present, `ended`
   * absent among the archive's own entries (see core's `runProgressFromNames`).
   *
   * Derived on every render from the parsed runs, and deliberately not state: the fact lives in
   * the file, arrives with it, and survives a reload. Nothing here has to be told when a run
   * finishes — the next snapshot the run watcher pulls simply contains `ended`.
   */
  inProgressIds: Set<string>;
  /**
   * Ids of the loaded runs that stopped short — over, but holding fewer plate reads than their
   * protocol asked for (see core's `runCompleteness`).
   *
   * This is how a cancelled run is recognised, and it is a comparison rather than a flag because
   * a flag doesn't exist: an aborted run's `ended` marker and `.alf` report are byte-identical in
   * shape to a completed one's (`usb.md` §7.8, `alf.md` §6). Derived per render for the same
   * reason {@link inProgressIds} is — the answer is already in the file.
   */
  incompleteIds: Set<string>;
  /**
   * Ids of the loaded experiments that have not been run yet (`lib/experiment.ts`'s
   * `isPendingExperiment`): no plate reads and no `begun` marker.
   *
   * Distinct from {@link incompleteIds} in the way that matters most to someone reading the bar: an
   * incomplete run *was* started and stopped short, a pending one has not been started at all. The
   * two are otherwise easy to confuse, since both hold fewer reads than their protocol asks for —
   * which is why `runCompleteness` excludes a never-started archive from `incomplete` outright, and
   * these two sets can never overlap.
   */
  pendingIds: Set<string>;
  /**
   * Fetch a file over HTTP and load it as if it had been dropped — the `#load=<url>` hash key's
   * implementation, and how the welcome screen's example button works. The name comes from the
   * URL's last path segment (see {@link fileNameFromUrl}).
   */
  addUrl: (url: string) => Promise<void>;
  setActive: (id: string) => void;
  remove: (id: string) => Promise<void>;
  /**
   * Patch the active file's settings. Display keys land in IndexedDB, analysis keys
   * ({@link ANALYSIS_KEYS}) in the file's own `zpcrweb.json` — one flat call either way; see
   * {@link FileSettings}.
   */
  updateSettings: (patch: Partial<FileSettings>) => void;
  /**
   * The file's bytes as they'd be saved to disk: the loaded archive plus the current analysis
   * settings as a `zpcrweb.json` entry, so a downloaded copy carries the thresholds it's being
   * read with. Built on demand rather than kept in `files` — rewriting the bytes in React state
   * would re-parse the whole run and rebuild every derived value on each save.
   */
  exportBytes: (fileId: string) => Uint8Array | null;
}

export function useZpcrStore(): ZpcrStore {
  /** The catalog — every file, metadata only. Ordered by `addedAt`, oldest first. */
  const [entries, setEntries] = useState<FileEntry[]>([]);
  /** The loaded set — bytes in memory. A subset of {@link entries}, in load order (the file
   * bar's order). */
  const [loadedFiles, setLoadedFiles] = useState<LoadedFile[]>([]);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const [settingsMap, setSettingsMap] = useState<Record<string, FileSettings>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  // Seed the view from the URL hash so a shared link opens on the right tab with no flash of
  // the default one (see `urlHash.ts`); the file half can only be resolved after hydration.
  const [view, setView] = useState<ViewId>(() => readHash().view ?? "curves");
  // A `#load=<url>` to fetch, from the URL the app was opened with or from a later hash change
  // (the welcome screen's example button is one). Captured during the first render — i.e. before
  // any effect, and so before the state→URL sync below rewrites the hash without it.
  const [pendingLoad, setPendingLoad] = useState<string | null>(() => readHash().load ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const saveTimers = useRef<Record<string, number>>({});
  const [password] = usePltdPassword();

  // ── File-backed analysis settings ────────────────────────────────────────────────────────
  // Kept in their own map rather than folded into `settingsMap`, because they have a different
  // lifecycle: seeded from the file once it parses (which for a `.pcrd` means after the
  // password), and written back into the file rather than into IndexedDB.
  const [analysisMap, setAnalysisMap] = useState<Record<string, AnalysisSettings>>({});
  /** Ids already seeded from their file, so a re-parse (password change, plate attach) never
   * overwrites edits made since. */
  const seeded = useRef(new Set<string>());
  // Refs, not state, so the persister's `resolve` always sees current values without the
  // persister having to be rebuilt (and its pending timers reset) on every keystroke.
  const loadedRef = useRef<LoadedFile[]>(loadedFiles);
  loadedRef.current = loadedFiles;
  const entriesRef = useRef<FileEntry[]>(entries);
  entriesRef.current = entries;
  /** `setActive`, reachable from effects defined above it (the hash listener) without making
   * every one of them depend on a callback that changes with the selection. */
  const selectRef = useRef<(id: string) => void>(() => {});
  const analysisRef = useRef(analysisMap);
  analysisRef.current = analysisMap;
  /**
   * Everything {@link summarizeFile} needs besides the file itself, kept current for the one
   * caller that can't wait for the debounced effect below: releasing a file has to cache what it
   * said *before* its bytes go, since after that there is nothing left to derive it from.
   */
  const summaryInputs = useRef<{
    runs: Map<string, RunResult>;
    plateFiles: Map<string, PlateFileResult>;
    password: string;
    names: Record<string, string | undefined>;
  }>({ runs: new Map(), plateFiles: new Map(), password: "", names: {} });

  const persister = useRef<AnalysisPersister>();
  if (!persister.current) {
    persister.current = new AnalysisPersister({
      resolve: (id) => {
        const file = loadedRef.current.find((f) => f.id === id);
        // Only a `.zpcr` has an archive to put an entry in. A `.pcrd` is a single encrypted XML
        // document whose own `dataAnalysisParameters` we don't yet write (see `pcrd.md` §2.5),
        // and a standalone plate file has no analysis at all — for those, edits are live for
        // the session and then gone, which is the honest behavior while the file can't hold them.
        if (!file || file.kind !== "zpcr") return null;
        const settings = analysisRef.current[id];
        if (!settings) return null;
        return { identity: identityOf(file), files: contentFiles(file.content), settings };
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }
  useEffect(() => persister.current!.attach(), []);

  // ── Protocol edits ───────────────────────────────────────────────────────────────────────
  // The same write-behind policy as an analysis edit, on a much shorter window: a `.prcl.txt` is
  // a few hundred bytes, so the write costs nothing next to the archive rewrite the minute-long
  // window above exists to space out — and a protocol being typed at is state a person would be
  // upset to lose. See `writeThrottle.ts`. Shared by two editors, both of which have already
  // updated `loadedRef.current`/`files` themselves before marking dirty: a standalone `.prcl.txt`
  // (`setProtocolText`) and a pending experiment's in-place protocol (`setRunProtocolText`) — this
  // throttle only has to persist whatever bytes it finds under the id at flush time, whichever
  // editor wrote them.
  const protocolThrottle = useRef<WriteThrottle>();
  if (!protocolThrottle.current) {
    protocolThrottle.current = new WriteThrottle({
      minIntervalMs: PROTOCOL_WRITE_INTERVAL_MS,
      // Read the file at flush time, never at edit time, so the write always lands the latest
      // text even when several edits coalesced into one trailing write.
      write: async (id) => {
        const file = loadedRef.current.find((f) => f.id === id);
        if (!file || (file.kind !== "prcl" && file.kind !== "zpcr")) return;
        await persistFile(file, analysisRef.current[id]);
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }
  useEffect(() => protocolThrottle.current!.attach(), []);

  /**
   * Read one file's bytes out of IndexedDB and put it in the loaded set — the *only* place bytes
   * enter memory, and so the only place a file is ever decoded (the `runs`/`plateFiles`/
   * `protocolFiles` maps below parse the loaded set and nothing else).
   *
   * A no-op for a file already loaded or already on its way. Returns the `LoadedFile`, or null if
   * the file has since been deleted.
   */
  const loadOne = useCallback(async (entry: FileEntry): Promise<LoadedFile | null> => {
    if (loadedRef.current.some((f) => f.id === entry.id)) return null;
    setLoadingIds((prev) => new Set(prev).add(entry.id));
    try {
      const stored = await getFileContent(entry.id);
      if (!stored) return null;
      const file: LoadedFile = {
        id: entry.id,
        name: entry.name,
        size: entry.size,
        addedAt: entry.addedAt,
        kind: entry.kind,
        // Either representation comes back as itself: a run stored open stays open (and so stays
        // cheap to append to across a reload), a zipped one stays zipped. See `fileContent.ts`.
        content: fromStoredContent(stored),
        lastModified: entry.lastModified,
      };
      loadedRef.current = [...loadedRef.current.filter((f) => f.id !== file.id), file];
      setLoadedFiles(loadedRef.current);
      return file;
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  }, []);

  // Hydrate from IndexedDB on mount: the whole catalog (metadata only — no archive is read, let
  // alone unzipped), then the bytes of just those files that were loaded when the session ended.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // One read, one record per file: the catalog row and its settings are the same object now.
        const stored = await getAllEntries();
        if (cancelled) return;
        const catalog: FileEntry[] = stored.map((e) => ({
          id: e.id,
          name: e.name,
          size: e.size,
          addedAt: e.addedAt,
          kind: e.kind,
          lastModified: e.lastModified,
          summary: e.summary ?? null,
        }));
        catalog.sort((a, b) => a.addedAt - b.addedAt);
        const map: Record<string, FileSettings> = {};
        for (const e of stored) map[e.id] = fromStored(e);
        setEntries(catalog);
        const wantsLoading = catalog.filter((e) => map[e.id]!.loaded);
        // A `#file=` from the URL picks the selection; without one, the most recently added
        // loaded file. A link naming a file this browser doesn't have selects **nothing** rather
        // than silently substituting another — the app then shows the file bar with no tab
        // available, which is the truthful answer to "that file isn't here".
        const wanted = readHash().file;
        const target = wanted
          ? catalog.find((f) => f.name === wanted) ?? null
          : wantsLoading.at(-1) ?? null;
        // A link may name a file that was released; selecting it loads it, so the flag has to
        // agree before the record is written back.
        if (target && !map[target.id]!.loaded) {
          map[target.id] = { ...map[target.id]!, loaded: true };
          void updateEntry(target.id, { loaded: true, view: viewOf(map[target.id]!) });
        }
        setSettingsMap(map);
        // The selected file loads first, so the app has something to draw before the rest arrive.
        for (const e of target ? [target, ...wantsLoading.filter((f) => f.id !== target.id)] : wantsLoading) {
          if (cancelled) return;
          await loadOne(e);
        }
        if (!cancelled) setActiveId(target?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadOne]);

  // ── URL hash sync ────────────────────────────────────────────────────────────────────
  // Both directions are guarded by "is it already that value?" checks (here and in
  // `writeHash`), so the echo each direction provokes in the other terminates immediately
  // instead of looping.
  const active = useMemo(() => loadedFiles.find((f) => f.id === activeId) ?? null, [loadedFiles, activeId]);
  const syncedOnce = useRef(false);

  // State → URL. Held until hydration finishes: before that `active` is still null, and
  // writing would strip the `#file=` we were opened with before we could honor it.
  useEffect(() => {
    if (loading) return;
    writeHash({ file: active?.name, view }, { replace: !syncedOnce.current });
    syncedOnce.current = true;
  }, [loading, active, view]);

  // URL → state, for back/forward and hand-edited links.
  useEffect(() => {
    return onHashChange(() => {
      const h = readHash();
      if (h.view) setView(h.view);
      if (h.load) setPendingLoad(h.load);
      if (h.file) {
        // Against the whole catalog, not just the loaded set: a link may name a file that has
        // been released, and following it should bring that file back rather than do nothing.
        const match = entries.find((f) => f.name === h.file);
        if (match) void selectRef.current(match.id);
      }
    });
  }, [entries]);

  /** Drop everything keyed by a file id except the catalog itself — the cleanup {@link remove}
   * and the same-name replacement in {@link addFiles} both need. */
  const forget = useCallback(async (id: string) => {
    await deleteFile(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setLoadedFiles((prev) => {
      loadedRef.current = prev.filter((f) => f.id !== id);
      return loadedRef.current;
    });
    setSettingsMap((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    // Drop any pending settings write for a file that no longer exists, and let it re-seed
    // from its own bytes if it's ever loaded again.
    persister.current!.forget(id);
    protocolThrottle.current!.forget(id);
    seeded.current.delete(id);
    setAnalysisMap((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  /**
   * Keep the catalog in step with a change to a loaded file — its bytes (so its `size`) or its
   * identity (a rename). The two lists describe the same files and must agree about them; the
   * cached summary is refreshed separately, by the effect that watches the decoded run.
   */
  const patchEntry = useCallback((id: string, patch: Partial<FileEntry>) => {
    setEntries((prev) => {
      entriesRef.current = prev.map((e) => (e.id === id ? { ...e, ...patch } : e));
      return entriesRef.current;
    });
  }, []);

  /**
   * Flip a file's "edited since loaded" flag (see {@link FileSettings.modified}). Written
   * straight through rather than on `updateSettings`'s 300 ms debounce — it records that work
   * exists which the disk copy doesn't have, so a tab closed in the next moment must not lose it.
   * Cancelling any pending display write is part of that: it holds an older snapshot, taken
   * before the flag changed, and would otherwise land after this one.
   */
  const setModifiedFlag = useCallback((id: string, value: boolean) => {
    setSettingsMap((prev) => {
      const current = prev[id] ?? defaultSettings();
      if (current.modified === value) return prev;
      const next = { ...current, modified: value };
      window.clearTimeout(saveTimers.current[id]);
      void updateEntry(id, { modified: value, ...(next.loaded ? { view: viewOf(next) } : {}) });
      return { ...prev, [id]: next };
    });
  }, []);

  const markDownloaded = useCallback(
    (id: string) => setModifiedFlag(id, false),
    [setModifiedFlag],
  );

  /**
   * Record whether a file is loaded (see {@link FileSettings.loaded}). Written straight through
   * like {@link setModifiedFlag}, for the same reason: it's a discrete, deliberate act (a chip's
   * ✕, the table's checkbox, opening a file), not a value worth debouncing.
   */
  const setLoadedFlag = useCallback((id: string, value: boolean) => {
    setSettingsMap((prev) => {
      const current = prev[id] ?? defaultSettings();
      if (current.loaded === value) return prev;
      const next = { ...current, loaded: value };
      window.clearTimeout(saveTimers.current[id]);
      // Releasing a file drops its display state (see `StoredEntry.view`); loading one writes the
      // state it is being loaded with, so the record always says what the file bar is showing.
      void updateEntry(id, { loaded: value, view: value ? viewOf(next) : undefined });
      return { ...prev, [id]: next };
    });
  }, []);

  /** See {@link ZpcrStore.setLoaded}. */
  const setLoaded = useCallback(
    async (id: string, value: boolean) => {
      setLoadedFlag(id, value);
      if (value) {
        const entry = entriesRef.current.find((e) => e.id === id);
        if (entry) await loadOne(entry);
        return;
      }
      // Releasing: get anything still owed to disk written first, since dropping the bytes is
      // exactly what makes them unrecoverable from memory. That includes the cached summary —
      // written here rather than left to the debounced effect below, because a file released
      // moments after it loaded would otherwise leave a row with nothing to say, and no way to
      // find out short of reading the archive again.
      await persister.current!.flush(id);
      await protocolThrottle.current!.flush(id);
      const going = loadedRef.current.find((f) => f.id === id);
      if (going) {
        const { runs: r, plateFiles: pf, password: pw, names } = summaryInputs.current;
        const summary = summarizeFile(going, r.get(id), pf.get(id), pw, names[id]);
        patchEntry(id, { summary });
        void updateEntry(id, { summary });
      }
      loadedRef.current = loadedRef.current.filter((f) => f.id !== id);
      setLoadedFiles(loadedRef.current);
      // The selection must always name a loaded file, or nothing. Falling back to the most
      // recently loaded one keeps releasing a file you weren't looking at from moving the view,
      // and releasing the one you were from leaving the app pointed at bytes that are gone.
      setActiveId((cur) => (cur === id ? loadedRef.current.at(-1)?.id ?? null : cur));
      // The analysis/seeding state stays: it was read from the file, and re-reading it on the
      // next load would be the same answer. Only the bytes go.
    },
    [loadOne, setLoadedFlag, patchEntry],
  );

  /**
   * Put a validated file into the catalog *and* the loaded set: supersede any same-named copy,
   * write the record, land it in both sets. The tail every way of adding a file shares — a drop, a
   * `#load=`, and a snapshot of a run in progress ({@link addRunArchive}) — so they differ in how
   * the content is *obtained* and in nothing else.
   *
   * An added file is a loaded file: this is the one path by which a file's content is in hand
   * without a read from IndexedDB.
   */
  const install = useCallback(
    async (file: LoadedFile, modified: boolean): Promise<string> => {
      // Re-loading a name that's already here replaces it. Ids hash name+size, so an edited file
      // (attached plate, saved thresholds, another cycle of a running run) gets a *different* id
      // under the same name — without this it would sit alongside the stale copy as an
      // indistinguishable second chip, and `#file=` would have two candidates to mean. Asked of
      // the whole catalog, not just the loaded set: a released file under the same name is just as
      // much a stale duplicate, and leaving it would put two rows with the same name in the Files
      // table.
      const superseded = entriesRef.current.filter((f) => f.name === file.name && f.id !== file.id);
      for (const old of superseded) await forget(old.id);
      const supersededIds = new Set(superseded.map((f) => f.id));
      // Normally nothing to layer in — a file arriving from disk hasn't been seeded yet, and its
      // own `zpcrweb.json` (if it has one) is already in the bytes. A file re-added under an id
      // that is already here keeps whatever was typed against it.
      await persistFile(file, analysisRef.current[file.id]);
      const entry: FileEntry = {
        id: file.id,
        name: file.name,
        size: file.size,
        addedAt: file.addedAt,
        kind: file.kind,
        lastModified: file.lastModified,
        summary: null,
      };
      setEntries((prev) => {
        entriesRef.current = [
          ...prev.filter((f) => f.id !== file.id && !supersededIds.has(f.id)),
          entry,
        ];
        return entriesRef.current;
      });
      setLoadedFiles((prev) => {
        loadedRef.current = [
          ...prev.filter((f) => f.id !== file.id && !supersededIds.has(f.id)),
          file,
        ];
        return loadedRef.current;
      });
      setLoadedFlag(file.id, true);
      if (modified) setModifiedFlag(file.id, true);
      return file.id;
    },
    [forget, setModifiedFlag, setLoadedFlag],
  );

  /**
   * Persist an in-place edit to a loaded file — the record, the loaded set, and the catalog row's
   * size, which is the one identity field an edit can change. Every archive edit below ends here,
   * so none of them has to know how a file is stored (`fileContent.ts`) or that the catalog exists.
   */
  const commitContent = useCallback(
    async (next: LoadedFile) => {
      await persistFile(next, analysisRef.current[next.id]);
      setLoadedFiles((prev) => {
        loadedRef.current = replaceFile(prev, next);
        return loadedRef.current;
      });
      patchEntry(next.id, { size: next.size });
    },
    [patchEntry],
  );

  const addFiles = useCallback(
    async (input: FileList | File[], options?: AddFilesOptions) => {
      // `.json`'s kind can only be known after reading its bytes (see `fileKind`), so every file
      // is read up front rather than filtered by extension first the way the other formats are.
      const candidates = Array.from(input).filter((file) => /\.(zpcr|pcrd|pltd|csv|json|txt)$/i.test(file.name));
      let lastId: string | null = null;
      let lastKind: FileKind | null = null;
      for (const file of candidates) {
        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const kind = fileKind(file.name, bytes);
          if (!kind) {
            throw new Error(
              /\.txt$/i.test(file.name)
                ? // The name got this far, so say what was wrong with the *content* rather than
                  // repeating the extension list — a `.txt` is only ever rejected for that.
                  "not a thermal protocol (.prcl.txt)"
                : "not a .zpcr, .pcrd, .pltd, .csv, .prcl.txt or Biomeme .json file",
            );
          }
          // Validate the container eagerly so obviously-bad files are rejected up front; a
          // .pcrd/.pltd's payload may still need a password, resolved reactively via `runs`/
          // `plateFiles`.
          //
          // A `.zpcr` is unzipped exactly once here, and that same open archive is both what
          // validates it and what it's stored as if the run is still being written to — a dropped
          // run in progress never gets re-zipped just to be put away. See `fileContent.ts`.
          let content: FileContent;
          if (kind === "zpcr") {
            content = loadedRunContent(bytes, unzipArchive(bytes));
            parseContent(content);
          } else {
            if (kind === "pcrd") parsePcrd(bytes);
            else if (kind === "biomeme") parseBiomeme(bytes);
            else if (kind === "pltd") parsePltd(bytes);
            // Already validated by `fileKind`'s content sniff — parsing again would only repeat it.
            else if (kind === "prcl") void 0;
            else parsePlateCsv(new TextDecoder().decode(bytes));
            content = zippedContent(bytes);
          }
          // Hashed from the size on disk, not the stored size: this is the file's identity as the
          // user's own copy of it, so re-dropping it resolves to this record either way.
          const id = fileId(file.name, file.size);
          // Re-loading a name that's already here replaces it. Ids hash name+size, so an edited
          // file (attached plate, saved thresholds, a re-export) gets a *different* id under the
          // same name — without this it would sit alongside the stale copy as an
          // indistinguishable second chip, and `#file=` would have two candidates to mean.
          // Asked of the whole catalog, not just the loaded set: a released file under the same
          // name is just as much a stale duplicate, and leaving it would put two rows with the
          // same name in the Files table.
          await install(
            {
              id,
              name: file.name,
              size: contentSize(content),
              addedAt: Date.now(),
              kind,
              content,
              lastModified: file.lastModified,
            },
            options?.modified === true,
          );
          lastId = id;
          lastKind = kind;
        } catch (e) {
          setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (lastId && options?.activate !== false) setActiveId(lastId);
      // A `.prcl.txt` is a document first: opening one shows what the protocol *is* — the
      // annotated directive listing on Overview — rather than dropping you into the Instrument
      // view's staging panel, which is a thing you go to when you mean to start a run. Done here
      // rather than at the call site so every entry point (the header button, a drop, `#load=`)
      // behaves alike.
      if (lastKind === "prcl") setView("overview");
      return lastId;
    },
    [install],
  );

  /** See {@link ZpcrStore.addRunArchive}. */
  const addRunArchive = useCallback(
    async (name: string, archive: ZpcrArchive, options?: AddFilesOptions): Promise<string | null> => {
      try {
        // `runContent` is what makes the end of a run the moment the file becomes an ordinary
        // zipped `.zpcr`: every snapshot before it carries no `ended` marker and stays open, and
        // the last one — the end-of-run pass, which is the first to carry it — zips, once.
        const content = runContent(archive);
        parseContent(content);
        const size = contentSize(content);
        const id = fileId(name, size);
        // By name, not by id: a new snapshot is a longer archive, so it necessarily hashes to a
        // different id — the previous one is the copy `install` is about to supersede.
        const previous = entriesRef.current.find((f) => f.name === name);
        const installed = await install(
          {
            id,
            name,
            size,
            // A run's successive snapshots are the same file getting longer, so it keeps the
            // moment it first appeared rather than jumping to the end of the bar every cycle.
            addedAt: previous?.addedAt ?? Date.now(),
            kind: "zpcr",
            content,
            lastModified: Date.now(),
          },
          options?.modified === true,
        );
        if (options?.activate !== false) setActiveId(installed);
        return installed;
      } catch (e) {
        setError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [install],
  );

  /**
   * Fetch → `addFiles`, so a URL-loaded file goes through exactly the same validate/persist path
   * as a dropped one. `credentials: "omit"` because the URL comes from a link: a shared
   * `#load=` must not be able to use the recipient's cookies to fetch something private and pull
   * it into the page. Cross-origin URLs are allowed but need CORS, like any other fetch.
   */
  const addUrl = useCallback(
    async (url: string) => {
      const name = fileNameFromUrl(url);
      try {
        // `.json`'s kind needs its bytes (see `fileKind`); only the extension is checked here,
        // and `addFiles` below does the real (content-based) validation once it has them.
        if (!/\.(zpcr|pcrd|pltd|csv|json)$/i.test(name)) {
          throw new Error("not a .zpcr, .pcrd, .pltd, .csv or Biomeme .json file");
        }
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) throw new Error(`fetch failed (HTTP ${res.status})`);
        await addFiles([new File([await res.arrayBuffer()], name)]);
      } catch (e) {
        setError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [addFiles],
  );

  // Perform a pending `#load=`, once hydration has finished — a URL-loaded file replaces any
  // same-named copy already in IndexedDB (see `addFiles`), which only works once we know what's
  // there. Cleared before the fetch starts so a failure isn't retried on every re-render.
  useEffect(() => {
    if (loading || !pendingLoad) return;
    setPendingLoad(null);
    void addUrl(pendingLoad);
  }, [loading, pendingLoad, addUrl]);

  const remove = useCallback(
    async (id: string) => {
      // `forget` takes the file out of both sets and out of storage; all that's left is the
      // selection, which may have been pointing at it.
      await forget(id);
      setActiveId((cur) => (cur === id ? loadedRef.current.at(-1)?.id ?? null : cur));
    },
    [forget],
  );

  // Switching files flushes anything pending: the window of unsaved analysis edits then only
  // ever covers the file you're actually looking at.
  //
  // Also **loads** the file (see `FileSettings.loaded`): the one selection is the file every tab
  // in the strip is a lens on, so it is by definition one whose bytes the app is holding. This is
  // the single place every path to "make this the active file" goes through — a chip click, the
  // Files table's row click, a `#file=` link — so selecting a released file simply brings it
  // back. The id is set at once and the bytes arrive after (`loadingIds`), so a click in a table
  // of a thousand files responds immediately rather than after a disk read.
  const setActive = useCallback(
    (id: string) => {
      void persister.current!.flushAll();
      void protocolThrottle.current!.flushAll();
      setActiveId(id);
      void setLoaded(id, true);
    },
    [setLoaded],
  );
  selectRef.current = setActive;

  const attachPlate = useCallback(
    async (targetFileId: string, file: File) => {
      const kind = plateFileKind(file.name);
      if (!kind) {
        setError(`${file.name}: not a .pltd or .csv file`);
        return;
      }
      const target = loadedFiles.find((f) => f.id === targetFileId);
      if (!target) return;
      if (target.kind !== "zpcr") {
        setError(`${target.name}: attaching a plate is only supported for .zpcr files`);
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        const plateBytes = new Uint8Array(buf);
        // .csv has no password step, so validate eagerly; a .pltd's container is validated when
        // the archive is written back out, and its plate resolved reactively via `runs`.
        if (kind === "csv") parsePlateCsv(new TextDecoder().decode(plateBytes));
        // Working on the archive itself: free for a run still in progress or not yet started (the
        // common case for attaching a plate), and an unzip + re-zip for a finished one, which is
        // what it always cost. See `fileContent.ts`.
        await commitContent(
          withContent(
            target,
            runContent(
              attachPlateToArchive(contentFiles(target.content), {
                name: file.name,
                bytes: plateBytes,
              }),
            ),
          ),
        );
        // The archive itself now differs from the one on disk, which is exactly what the flag is
        // for — a plate attached and then deleted is as much lost work as a threshold is.
        setModifiedFlag(target.id, true);
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [loadedFiles, setModifiedFlag, commitContent],
  );

  /** See {@link ZpcrStore.attachProtocol}. */
  const attachProtocol = useCallback(
    async (targetFileId: string, file: File) => {
      const target = loadedFiles.find((f) => f.id === targetFileId);
      if (!target) return;
      if (target.kind !== "zpcr") {
        setError(`${target.name}: attaching a protocol is only supported for .zpcr files`);
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        const runDefinition = parseRunDefinitionText(new TextDecoder().decode(buf));
        const name = file.name.replace(/\.prcl\.txt$/i, "");
        await commitContent(
          withContent(
            target,
            runContent(attachProtocolToArchive(contentFiles(target.content), { runDefinition, name })),
          ),
        );
        setModifiedFlag(target.id, true);
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [loadedFiles, setModifiedFlag, commitContent],
  );

  /** See {@link ZpcrStore.createExperiment}. */
  const createExperiment = useCallback(
    async (parts: ExperimentArchiveParts): Promise<string | null> => {
      const today = new Date();
      // `runFileBaseName` refuses an empty name — there is none yet, so the bare date stamp is
      // built directly the same way it would be, rather than through it.
      const stamp =
        `${today.getFullYear()}` +
        `${String(today.getMonth() + 1).padStart(2, "0")}` +
        `${String(today.getDate()).padStart(2, "0")}`;
      // A new experiment is by definition a run that hasn't started, so it goes straight in as an
      // open archive: there is nothing to zip and nothing to unzip again to read it back.
      return addRunArchive(`${stamp}.zpcr`, buildExperimentArchive(parts), {
        activate: true,
        modified: true,
      });
    },
    [addRunArchive],
  );

  /** See {@link ZpcrStore.setRunProtocolText}. */
  const setRunProtocolText = useCallback(
    (id: string, runDefinition: string) => {
      const file = loadedRef.current.find((f) => f.id === id);
      if (!file || file.kind !== "zpcr") return;
      // A keystroke in the protocol editor: on the pending experiment this is only ever called
      // for, replacing the run-definition entry is one `TextEncoder` call and no ZIP work at all.
      const next = withContent(
        file,
        runContent(attachProtocolToArchive(contentFiles(file.content), { runDefinition })),
      );
      loadedRef.current = replaceFile(loadedRef.current, next);
      setLoadedFiles((prev) => replaceFile(prev, next));
      patchEntry(id, { size: next.size });
      setModifiedFlag(id, true);
      protocolThrottle.current!.markDirty(id);
    },
    [setModifiedFlag, patchEntry],
  );

  /** See {@link ZpcrStore.setRunProtocolName}. */
  const setRunProtocolName = useCallback(
    async (id: string, name: string) => {
      const file = loadedRef.current.find((f) => f.id === id);
      if (!file || file.kind !== "zpcr") return;
      // Flush a pending protocol-text write first: both rewrite the same two entries, and writing
      // from a stale archive would drop whichever edit hadn't landed.
      await protocolThrottle.current!.flush(id);
      const current = loadedRef.current.find((f) => f.id === id) ?? file;
      const archive = contentFiles(current.content);
      let runDefinition: string;
      try {
        runDefinition = parseZpcrArchive(archive).protocolText;
      } catch {
        return;
      }
      if (!runDefinition) return;
      await commitContent(
        withContent(current, runContent(attachProtocolToArchive(archive, { runDefinition, name }))),
      );
      setModifiedFlag(id, true);
    },
    [setModifiedFlag, commitContent],
  );

  /** See {@link ZpcrStore.setProtocolText}. */
  const setProtocolText = useCallback(
    (id: string, runDefinition: string) => {
      const file = loadedRef.current.find((f) => f.id === id);
      if (!file || file.kind !== "prcl") return;
      const next = withContent(
        file,
        zippedContent(new TextEncoder().encode(formatRunDefinitionText(runDefinition))),
      );
      // Keep the ref current for a flush that fires before React re-renders (the throttle can
      // write synchronously, on the very first edit to an idle file).
      loadedRef.current = replaceFile(loadedRef.current, next);
      setLoadedFiles((prev) => replaceFile(prev, next));
      patchEntry(id, { size: next.size });
      // The bytes now differ from the copy on disk, which is exactly what the flag is for — an
      // edited protocol deleted before it was downloaded is lost work.
      setModifiedFlag(id, true);
      protocolThrottle.current!.markDirty(id);
    },
    [setModifiedFlag, patchEntry],
  );

  const renameFile = useCallback(
    async (id: string, rawName: string) => {
      const name = rawName.trim();
      const file = loadedRef.current.find((f) => f.id === id);
      if (!file || !name || name === file.name) return;
      const newId = fileId(name, file.size);
      // Flush any pending archive rewrite for the old id first — once the rename lands, the
      // persister's `resolve` can no longer find a file under `id` and would silently drop it.
      await persister.current!.flush(id);
      await protocolThrottle.current!.flush(id);
      // Renaming onto a name (+size) that collides with an already-loaded file supersedes it,
      // the same way `addFiles` handles a same-named re-upload.
      for (const old of loadedRef.current.filter((f) => f.id === newId)) await forget(old.id);
      // Under the *old* id: the settings move to `newId` below, but the record being written is
      // this file's, and dropping them here is what used to lose the name of an experiment that
      // had just been named (naming one renames its file — `App.tsx`'s `nameExperiment`).
      await persistFile({ ...file, id: newId, name }, analysisRef.current[id]);
      await deleteFile(id);
      setLoadedFiles((prev) => {
        loadedRef.current = prev.map((f) => (f.id === id ? { ...f, id: newId, name } : f));
        return loadedRef.current;
      });
      setEntries((prev) => {
        entriesRef.current = prev.map((e) => (e.id === id ? { ...e, id: newId, name } : e));
        return entriesRef.current;
      });
      setSettingsMap((prev) => {
        const { [id]: current, ...rest } = prev;
        const next = { ...(current ?? defaultSettings()), modified: true };
        // The record under `newId` was created by `persistFile` above, so this carries the renamed
        // file's settings onto it — the old id's record is gone (`deleteFile`).
        void updateEntry(newId, { modified: true, view: viewOf(next) });
        return { ...rest, [newId]: next };
      });
      setAnalysisMap((prev) => {
        const { [id]: moved, ...rest } = prev;
        if (moved === undefined) return prev;
        analysisRef.current = { ...rest, [newId]: moved };
        return analysisRef.current;
      });
      if (seeded.current.delete(id)) seeded.current.add(newId);
      persister.current!.forget(id);
      protocolThrottle.current!.forget(id);
      window.clearTimeout(saveTimers.current[id]);
      delete saveTimers.current[id];
      setActiveId((cur) => (cur === id ? newId : cur));
    },
    [forget],
  );

  /** See {@link ZpcrStore.beginExperiment}. */
  const beginExperiment = useCallback(
    async (id: string): Promise<{ id: string; name: string } | null> => {
      const file = loadedRef.current.find((f) => f.id === id);
      if (!file || file.kind !== "zpcr") return null;
      // Flush any in-flight protocol edit first — the begun marker must land on top of the
      // latest text, not race a still-pending throttled write.
      await protocolThrottle.current!.flush(id);
      const current = loadedRef.current.find((f) => f.id === id) ?? file;
      let targetId = id;
      let targetName = current.name;
      const restamped = restampExperimentDate(current.name, new Date());
      if (restamped) {
        await renameFile(id, restamped);
        targetId = fileId(restamped, current.size);
        targetName = restamped;
      }
      // Pending → in progress: both states are held open (`fileContent.ts`), so writing the
      // marker adds one zero-length entry and re-puts the record, with no ZIP work either side.
      await commitContent(
        withContent(
          { ...current, id: targetId, name: targetName },
          runContent(markExperimentBegun(contentFiles(current.content))),
        ),
      );
      setModifiedFlag(targetId, true);
      return { id: targetId, name: targetName };
    },
    [renameFile, setModifiedFlag, commitContent],
  );

  // One flat object per file, assembled from the two stores. The analysis half wins, so a
  // display record written before the split (whose analysis fields `fromStored` now ignores)
  // can't shadow what the file says.
  const settings = useMemo<FileSettings | null>(() => {
    if (!activeId) return null;
    const display = settingsMap[activeId] ?? defaultSettings();
    const analysis = analysisMap[activeId];
    return analysis ? { ...display, ...analysis } : display;
  }, [activeId, settingsMap, analysisMap]);

  const updateSettings = useCallback(
    (patch: Partial<FileSettings>) => {
      if (!activeId) return;
      // Split the patch by where each key is stored (see `FileSettings`). Callers stay unaware
      // of the split; a single `onChange` may legitimately touch both halves.
      const displayPatch: Partial<FileSettings> = {};
      const analysisPatch: Partial<AnalysisSettings> = {};
      let touchedAnalysis = false;
      let touchedDisplay = false;
      for (const [key, value] of Object.entries(patch)) {
        if (isAnalysisKey(key)) {
          (analysisPatch as Record<string, unknown>)[key] = value;
          touchedAnalysis = true;
        } else {
          (displayPatch as Record<string, unknown>)[key] = value;
          touchedDisplay = true;
        }
      }

      if (touchedDisplay) {
        setSettingsMap((prev) => {
          const current = prev[activeId] ?? defaultSettings();
          const next = { ...current, ...displayPatch };
          // One right axis, two candidates for it: filling either set empties the other, here
          // rather than at each call site so no control can leave both on (see `rightAxis.ts`).
          if (displayPatch.temps?.size) next.leds = new Set();
          if (displayPatch.leds?.size) next.temps = new Set();
          // debounced persist. Only the view half: the active file is loaded by definition, and
          // the flags are written straight through by their own setters.
          window.clearTimeout(saveTimers.current[activeId]);
          saveTimers.current[activeId] = window.setTimeout(() => {
            void updateEntry(activeId, { view: viewOf(next) });
          }, 300);
          return { ...prev, [activeId]: next };
        });
      }

      if (touchedAnalysis) {
        // An edit counts as seeding: if the user got to a control before the seeding effect ran,
        // their value is the current one and must not be overwritten by the file's.
        seeded.current.add(activeId);
        setAnalysisMap((prev) => {
          const next = { ...(prev[activeId] ?? defaultAnalysisSettings()), ...analysisPatch };
          // Keep the ref current for a flush that fires before React re-renders.
          analysisRef.current = { ...prev, [activeId]: next };
          return analysisRef.current;
        });
        // Rate-limited archive rewrite — see `analysisPersist.ts`.
        persister.current!.markDirty(activeId);
        // The analysis half is precisely what a download writes into the file (`exportBytes`), so
        // an edit to it is what makes the copy on disk stale. Display state — which channels are
        // shown, log vs. linear — never leaves this browser and so never counts.
        setModifiedFlag(activeId, true);
      }
    },
    [activeId, setModifiedFlag],
  );

  const runs = useMemo(() => {
    const map = new Map<string, RunResult>();
    for (const f of loadedFiles) {
      if (f.kind === "zpcr" || f.kind === "pcrd" || f.kind === "biomeme") {
        map.set(f.id, parseRun(f.content, f.kind, password));
      }
    }
    return map;
  }, [loadedFiles, password]);

  const activeRun = activeId ? runs.get(activeId) ?? null : null;

  const plateFiles = useMemo(() => {
    const map = new Map<string, PlateFileResult>();
    for (const f of loadedFiles) {
      if (f.kind === "pltd" || f.kind === "csv") {
        map.set(f.id, parsePlateBytes(f.kind, fileBytes(f), password, f.name));
      }
    }
    return map;
  }, [loadedFiles, password]);

  const activePlateFile = activeId ? plateFiles.get(activeId) ?? null : null;

  /**
   * Decoded `.prcl.txt` entries. Unlike a run or a plate file this needs no password and cannot
   * fail here — `fileKind` only admits bytes that already parsed — so the value is the canonical
   * one-line run definition itself rather than a result wrapper.
   */
  const protocolFiles = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of loadedFiles) {
      if (f.kind !== "prcl") continue;
      try {
        map.set(f.id, parseRunDefinitionText(new TextDecoder().decode(fileBytes(f))));
      } catch {
        /* admitted only if it parsed; a failure here means the bytes changed underneath us */
      }
    }
    return map;
  }, [loadedFiles]);

  const activeProtocolFile = activeId ? protocolFiles.get(activeId) ?? null : null;

  /**
   * Seed each file's analysis settings from its own `zpcrweb.json`, once — after hydration, after
   * an upload, and (for an encrypted `.pcrd`) once a working password finally decodes it. A file
   * that fails to parse stays unseeded rather than being seeded with defaults, so unlocking it
   * later still picks up whatever it carries.
   */
  useEffect(() => {
    const additions: Record<string, AnalysisSettings> = {};
    for (const f of loadedFiles) {
      if (seeded.current.has(f.id)) continue;
      let next: AnalysisSettings;
      if (f.kind === "zpcr" || f.kind === "pcrd" || f.kind === "biomeme") {
        const zpcr = runs.get(f.id)?.zpcr;
        if (!zpcr) continue; // not decoded yet (needs a password, or failed) — try again later
        const fromFile = parseZpcrwebSettings(zpcr);
        next = analysisFromZpcrweb(fromFile);
        // A `.pcrd` that CFX saved with `autoCalculateThreshold="False"` carries the threshold the
        // instrument's own analysis used, per fluorophore (`threshold.md` §5.3). Seed the app's
        // override with it — that is what makes this app reproduce CFX's Cq exactly on such a run.
        //
        // It seeds *state*, and is never read by the analysis pipeline directly: a `.pcrd` and the
        // `.zpcr` of the same run must still quantify identically from the same inputs (see
        // `runAnalysis.ts`), and the difference here is a saved user decision, visible and
        // editable in the Threshold rail like any other override. `zpcrweb.json` outranks it —
        // that is this app's own record of the same decision, written later.
        if (!fromFile?.analysis?.thresholdOverrides && zpcr.persistedThresholds) {
          next = { ...next, thresholdOverrides: new Map(zpcr.persistedThresholds) };
        }
      } else {
        // A standalone plate file has no curves and so no analysis — defaults keep `settings`
        // a complete object for the views that read it.
        next = defaultAnalysisSettings();
      }
      seeded.current.add(f.id);
      additions[f.id] = next;
    }
    if (Object.keys(additions).length > 0) {
      setAnalysisMap((prev) => {
        analysisRef.current = { ...prev, ...additions };
        return analysisRef.current;
      });
    }
  }, [loadedFiles, runs]);

  /** One identity per file — see the interface's own comment for why it lives here. */
  const experiments = useMemo(() => {
    const map = new Map<string, ExperimentIdentity>();
    for (const f of loadedFiles) {
      map.set(f.id, experimentIdentity(f, runs.get(f.id), analysisMap[f.id]?.experimentName));
    }
    return map;
  }, [loadedFiles, runs, analysisMap]);

  /** The flag from every file's record, as the set the file bar wants — see
   * {@link ZpcrStore.modifiedIds}. */
  const modifiedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, s] of Object.entries(settingsMap)) if (s.modified) ids.add(id);
    return ids;
  }, [settingsMap]);

  /** See {@link ZpcrStore.loadedIds} — the loaded set as a set. */
  const loadedIds = useMemo(() => new Set(loadedFiles.map((f) => f.id)), [loadedFiles]);

  /**
   * The loaded set as the file bar shows it: oldest first, by when the file was added. Ordering by
   * `addedAt` rather than by when it happened to be read in is what keeps the chips in the same
   * places across a reload — hydration loads the selected file first so the app has something to
   * draw, and that must not shuffle the bar.
   */
  const loadedInOrder = useMemo(
    () => [...loadedFiles].sort((a, b) => a.addedAt - b.addedAt),
    [loadedFiles],
  );

  /** See {@link ZpcrStore.inProgressIds} — read from each archive's own marker files. */
  const inProgressIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, run] of runs) {
      // Only a real archive has entries to read. A `.pcrd` or a Biomeme export is a finished
      // record by construction, and `archive.entries` is empty for the formats that have none.
      const entries = run.zpcr?.archive.entries;
      if (entries && runProgressFromNames(entries).inProgress) ids.add(id);
    }
    return ids;
  }, [runs]);

  /** See {@link ZpcrStore.incompleteIds} — the protocol's own read count, against the archive's. */
  const incompleteIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, run] of runs) {
      if (run.zpcr && runCompleteness(run.zpcr).incomplete) ids.add(id);
    }
    return ids;
  }, [runs]);

  /** See {@link ZpcrStore.pendingIds} — an experiment prepared but never started. */
  const pendingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of loadedFiles) {
      const zpcr = runs.get(f.id)?.zpcr;
      if (zpcr && isPendingExperiment(f.kind, zpcr)) ids.add(f.id);
    }
    return ids;
  }, [loadedFiles, runs]);

  /**
   * Cache what each loaded file's content says, for the Files table to describe it by once it is
   * released (see `lib/fileSummary.ts` and `db.ts`'s `FileSummary`).
   *
   * Runs off the *loaded* set only, which is what makes the invariant hold: a summary exists
   * precisely because the file was decoded, and a file is decoded precisely because it was
   * loaded. Rewritten whenever the decode changes — a password landing, a plate attached, a name
   * typed — so a row never describes a file as it was two edits ago, and debounced because the
   * name field changes on every keystroke while the record is worth writing once.
   */
  summaryInputs.current = {
    runs,
    plateFiles,
    password,
    names: Object.fromEntries(
      Object.entries(analysisMap).map(([id, a]) => [id, a.experimentName]),
    ),
  };
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const f of loadedFiles) {
        const summary = summarizeFile(
          f,
          runs.get(f.id),
          plateFiles.get(f.id),
          password,
          analysisMap[f.id]?.experimentName,
        );
        const current = entriesRef.current.find((e) => e.id === f.id);
        if (current && JSON.stringify(current.summary) === JSON.stringify(summary)) continue;
        patchEntry(f.id, { summary });
        void updateEntry(f.id, { summary });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [loadedFiles, runs, plateFiles, password, analysisMap, patchEntry]);

  const exportBytes = useCallback(
    (id: string): Uint8Array | null => {
      const file = loadedFiles.find((f) => f.id === id);
      if (!file) return null;
      const analysis = analysisMap[id];
      if (file.kind !== "zpcr" || !analysis) return fileBytes(file);
      try {
        // The one place a run held open is zipped (`fileContent.ts`): a `.zpcr` leaving the
        // browser is an ordinary `.zpcr` whatever form it was being kept in.
        return zipArchive(
          writeZpcrwebSettings(contentFiles(file.content), zpcrwebFromAnalysis(analysis)),
        );
      } catch {
        // A file we somehow can't write settings into still downloads as what was loaded.
        return fileBytes(file);
      }
    },
    [loadedFiles, analysisMap],
  );

  return {
    files: entries,
    loaded: loadedInOrder,
    loadedIds,
    loadingIds,
    setLoaded,
    activeId,
    active,
    runs,
    activeRun,
    plateFiles,
    protocolFiles,
    experiments,
    activePlateFile,
    activeProtocolFile,
    modifiedIds,
    inProgressIds,
    incompleteIds,
    pendingIds,
    markDownloaded,
    attachPlate,
    attachProtocol,
    createExperiment,
    setRunProtocolText,
    setRunProtocolName,
    beginExperiment,
    renameFile,
    setProtocolText,
    settings,
    view,
    setView,
    loading,
    error,
    addFiles,
    addRunArchive,
    addUrl,
    setActive,
    remove,
    updateSettings,
    exportBytes,
  };
}
