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
  isAlfName,
  isPrclName,
  markExperimentBegun,
  matchesSupportedExtension,
  SUPPORTED_EXTENSIONS,
  parseAlf,
  parseBiomeme,
  parsePcrd,
  parsePlateCsv,
  parsePltd,
  parsePrcl,
  parseRunDefinitionText,
  protocolDocumentFromRunDefinition,
  parseZpcr,
  parseZpcrArchive,
  parseZpcrwebSettings,
  plateToCsv,
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
  type PrclContainer,
  type ProtocolDocument,
  type Zpcr,
} from "@zpcrweb/core";

export { wellKey, type AnalysisSource };
import {
  deleteContent,
  deleteFile,
  diskFileName,
  getAllFiles,
  getContent,
  putFile,
  putIdentity,
  updateFile,
  type DiskSource,
  type FileIdentity,
  type StoredFile,
  type StoredView,
} from "./db";
import {
  isPermissionError,
  readDiskFile,
  unwatchDiskFile,
  watchDiskFile,
  writeDiskFile,
  type DiskFileEvent,
} from "./diskFolders";
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
  contentEntryNames,
  contentFiles,
  contentSize,
  fromStoredContent,
  parseContent,
  archiveContent,
  toStoredContent,
  changedEntries,
  plainContent,
  type FileContent,
} from "./fileContent";
import { WriteThrottle } from "./writeThrottle";
import {
  experimentIdentity,
  isPendingExperiment,
  restampExperimentDate,
  type ExperimentIdentity,
} from "../lib/experiment";
import { sampleNameFromUrl } from "../lib/samples";
import { currentPltdPassword, usePltdPassword } from "./pltdPassword";
import { onHashChange, readHash, writeHash } from "./urlHash";

export { DEFAULT_THRESHOLD_MULTIPLIER } from "./analysisSettings";

/** The accepted encodings, and their grouping into runs/plates/protocols, are the library's
 * (`core/fileKind.ts`) — re-exported here because the store's `LoadedFile` is where the app meets
 * them. */
export type { FileKind };
/**
 * How often an edited protocol or plate file may be rewritten to IndexedDB — see
 * {@link ZpcrStore.setProtocolText} and {@link ZpcrStore.setPlateText}. Short, because a
 * `.prcl.txt`/`.plt.csv` is a few hundred bytes to a few kilobytes; the archive rewrite an
 * analysis edit costs is spaced a minute apart instead (`analysisPersist.ts`).
 */
const EDIT_WRITE_INTERVAL_MS = 2_000;

/**
 * How often a disk-backed file may be rewritten to the user's disk.
 *
 * A disk write is always the *whole* file — there is no per-entry delta to exploit the way there is
 * in IndexedDB (`db.ts`'s `changed`) — so this spaces out re-zipping and rewriting an archive while
 * a threshold is being dragged. Shorter than the archive's 60 s IndexedDB rewrite
 * (`analysisPersist.ts`) because this file is the one the user might reach for in another program a
 * moment later, and a few seconds of staleness is the most that should cost them.
 */
const DISK_WRITE_INTERVAL_MS = 3_000;

/**
 * What the app says about a file whose folder it may no longer read — see
 * {@link ZpcrStore.unreadableIds}. The browser's own wording for this is about the call that
 * failed rather than about anything the reader can do, so this replaces it: the file is still
 * open, it is only the access to it that expired, and clicking the file asks for it back.
 */
const PERMISSION_LAPSED =
  "Access to the folder this file is in has expired — click the file to allow access again.";

/** The two kinds a plate — standalone or attached to a run — can be uploaded as. */
type PlateFileKind = "pltd" | "platecsv";

/** The two encodings a standalone thermal protocol arrives in: Bio-Rad's own encrypted `.prcl`,
 * and this project's plain-text `.prcl.txt`. */
type ProtocolFileKind = "prcl" | "prcltxt";

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
   * Whether this file's content has been edited since it was opened — a threshold moved, the run
   * renamed, a plate attached — and not yet downloaded. The odd one out in this interface: not a
   * view setting at all, and no view reads it. It is kept here because call sites want one flat
   * per-file object; on the record it is a field of its own (`StoredFile.modified`), since the
   * stale copy is the one on the user's disk. Surfaced to the UI as
   * {@link ZpcrStore.modifiedIds}, which is what makes closing the file ask twice.
   */
  modified: boolean;
}

/**
 * One open file, as its catalog record describes it — metadata only, no bytes.
 *
 * Every open file has one of these, and (once its bytes are in) a {@link LoadedFile} beside it. The
 * two lists come apart only while a file's bytes are on their way in, or when they can't be got at
 * all: a disk-backed file whose folder is waiting on its permission back is an entry with no loaded
 * file, listed and selectable, and it reads itself in as soon as the app can reach it. See
 * `apps/web/ARCHITECTURE.md`, "Open files and the one selection".
 */
export interface FileEntry {
  /** The file's name — its identity here and its key in IndexedDB (`db.ts`'s `FileIdentity`). */
  name: string;
  size: number;
  addedAt: number;
  lastModified: number;
  kind: FileKind;
  /** Where this file's bytes live, when they live on the user's disk rather than in IndexedDB —
   * see `db.ts`'s {@link DiskSource}. */
  source?: DiskSource;
}

/** A file loaded into memory — content only. Parsing is derived (see {@link ZpcrStore.runs}),
 * since a `.pcrd`'s decode depends on the (mutable, shared) decryption password. */
export interface LoadedFile {
  /** See {@link FileEntry.name}. */
  name: string;
  /** What the app reports as this file's size; see `fileContent.ts`'s `contentSize`. */
  size: number;
  addedAt: number;
  kind: FileKind;
  /**
   * The file itself — a `.zpcr`'s archive entries, or any other kind's bytes. `fileContent.ts`
   * owns the distinction and every operation on it: `fileBytes(file)` for the bytes,
   * `contentFiles`/`archiveContent` for the edit path. Nothing outside that module should branch
   * on `content.archive`.
   */
  content: FileContent;
  /** The source `File`'s own `lastModified` (its OS mtime, epoch ms) — see
   * `db.ts`'s `StoredFile.lastModified`. */
  lastModified: number;
  /** See {@link FileEntry.source}. An edit to a file with this set is written back to the file on
   * disk rather than to IndexedDB. */
  source?: DiskSource;
}

/** A loaded file's bytes, zipping an open archive if that's how it's held — see
 * `fileContent.ts`'s `contentBytes` for when that is and isn't appropriate. */
export function fileBytes(file: LoadedFile): Uint8Array {
  return contentBytes(file.content);
}

/** A loaded file's identity, as its catalog record carries it. */
function identityOf(file: LoadedFile): FileIdentity {
  return {
    name: file.name,
    size: file.size,
    addedAt: file.addedAt,
    kind: file.kind,
    lastModified: file.lastModified,
    ...(file.source ? { source: file.source } : {}),
  };
}

/**
 * Persist a loaded file — the one place a `db.ts` write is assembled from a {@link LoadedFile}, so
 * the choice of storage representation is made once (`toStoredContent`) rather than at each of the
 * dozen call sites that persist a file. `analysis` is the file's file-backed settings, layered in
 * on the way out; see {@link contentToStore} for why every write has to carry them.
 *
 * `previous` is the version this one replaces, when there is one — the entries it shares with this
 * write are already stored and are left alone (`changedEntries`). Omitting it writes the whole
 * file, which is what a file arriving for the first time needs.
 *
 * **A disk-backed file goes to disk instead** — the catalog row here, the bytes there, throttled
 * (`markDiskDirty`). The exception is a run the instrument is still writing: those buffer into
 * IndexedDB exactly like any other file until they finish, and are written to disk once, at the
 * end. See `apps/web/ARCHITECTURE.md`, "Disk-backed files and folders".
 *
 * A `null` `markDiskDirty` means the file on disk is *already* what this write would produce, so
 * only the catalog row is owed — which is the case for a file that has just been read off disk and
 * not yet touched. Without it, opening a `.zpcr` from a folder would immediately re-zip it and
 * write it back: a byte-for-byte different file, a moved mtime, and an edit the user never made.
 */
function persistFile(
  file: LoadedFile,
  analysis: AnalysisSettings | undefined,
  previous: FileContent | undefined,
  markDiskDirty: ((name: string) => void) | null,
): Promise<void> {
  if (file.source && !isRunInProgress(file)) {
    markDiskDirty?.(file.name);
    return putIdentity(identityOf(file));
  }
  const content = toStoredContent(contentToStore(file, analysis));
  return putFile(identityOf(file), content, changedEntries(previous, content));
}

/**
 * Whether this file is a run the instrument is still writing — the one case a disk-backed file is
 * buffered in IndexedDB rather than written straight through.
 *
 * Read from the archive's own marker entries, the same way `inProgressIds` answers it for the UI,
 * because the answer is already in the file and a second flag would only be something to keep in
 * step. Entry *names* are enough, so this costs nothing per plate read.
 */
function isRunInProgress(file: LoadedFile): boolean {
  if (file.kind !== "zpcr") return false;
  return runProgressFromNames(contentEntryNames(file.content)).inProgress;
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
 * nothing to write, which is the case for every file that is merely being read in.
 */
function contentToStore(file: LoadedFile, analysis: AnalysisSettings | undefined): FileContent {
  if (file.kind !== "zpcr" || !analysis) return file.content;
  const doc = zpcrwebFromAnalysis(analysis);
  if (!hasZpcrwebSettings(doc)) return file.content;
  try {
    return archiveContent(writeZpcrwebSettings(contentFiles(file.content), doc));
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
  return files.map((f) => (f.name === next.name ? next : f));
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
 * Every run parsed so far, by the identity of the content it was parsed from — see
 * {@link parseRunCached}. A `WeakMap`, so a file that is closed, replaced or edited takes its old
 * parse with it: nothing here outlives the bytes it describes.
 */
const parsedRuns = new WeakMap<FileContent, { password: string; result: RunResult }>();

/**
 * Parse one run — but only once per version of its bytes.
 *
 * The store's `runs` map is derived state, rebuilt whenever the loaded set changes identity, and
 * *any* edit to *any* file changes it (`replaceFile` returns a new array). Parsing every run in the
 * body of that memo meant an edit to one file re-decoded every other open run: ~5 ms of main-thread
 * work per loaded `.zpcr`, ~50 ms per `.pcrd`, on each commit of a protocol edit. Keying the parse
 * on the content object instead is both faster and the honest dependency — a run's decode depends
 * on its own bytes, not on how many other files happen to be open.
 *
 * **The key is the whole dependency.** Content objects are immutable and a new one is built for
 * every edit (`withContent`), so identity is exactly "these bytes"; the password is the only other
 * input, and only a `.pcrd`'s decode reads it, so a `.zpcr` is not re-parsed when one is entered.
 * That makes this pure as far as a render can tell — the same content and password always produce
 * the same result — which is what lets a memo read it.
 *
 * It is also seeded from the *validation* parse in {@link decodeFile}, so a dropped file is decoded
 * once rather than twice: once to prove the app can open it, and again on the first render.
 */
function parseRunCached(
  content: FileContent,
  kind: "zpcr" | "pcrd" | "biomeme",
  password: string,
): RunResult {
  // Only a `.pcrd` is encrypted, so nothing else's parse is keyed by the password.
  const key = kind === "pcrd" ? password : "";
  const hit = parsedRuns.get(content);
  if (hit && hit.password === key) return hit.result;
  const result = parseRun(content, kind, password);
  parsedRuns.set(content, { password: key, result });
  return result;
}

/**
 * The app's format boundary: every source format goes in, one {@link RunResult} comes out. Every
 * `kind === "pcrd"` test in the app that isn't about the raw view should be here instead.
 *
 * Called through {@link parseRunCached}, which is what decides whether a parse is owed at all.
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

/**
 * Every plate file parsed so far, by the identity of the content it was parsed from — the
 * plate-side twin of {@link parsedRuns}, and a `WeakMap` for the same reason: a closed, replaced or
 * edited file takes its old parse with it.
 */
const parsedPlateFiles = new WeakMap<FileContent, { key: string; result: PlateFileResult }>();

/**
 * Parse one plate file — but only once per version of its bytes.
 *
 * Same problem, same shape, and the same fix as {@link parseRunCached}: the store's `plateFiles`
 * map is derived from the loaded set, which changes identity on *any* edit to *any* file, so
 * committing a protocol edit re-ran every open plate file's parse. For a `.pltd` that parse is a
 * decryption — ~1.7 ms of main-thread work per loaded `.pltd`, on every edit, about a file the
 * user did not touch.
 *
 * **The key is the whole dependency**, and here that is two things beyond the bytes. The password,
 * as for a run, and only for the encrypted format — a `.plt.csv` is not re-parsed when one is
 * entered. And the *name*: a `.plt.csv` carries no plate identity of its own, so the file's name
 * becomes the plate's (`sourceName`), and `renameFile` renames a file without building new content
 * for it. Leaving the name out would leave a renamed CSV showing its old plate name.
 */
function parsePlateCached(
  content: FileContent,
  kind: PlateFileKind,
  password: string,
  name: string,
): PlateFileResult {
  // Only a `.pltd` is encrypted; only a `.plt.csv` reads the name.
  const key = kind === "pltd" ? `pltd ${password}` : `csv ${name}`;
  const hit = parsedPlateFiles.get(content);
  if (hit && hit.key === key) return hit.result;
  const result = parsePlateBytes(kind, contentBytes(content), password, name);
  parsedPlateFiles.set(content, { key, result });
  return result;
}

/** Called through {@link parsePlateCached}, which is what decides whether a parse is owed at all. */
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

/** The outcome of parsing a standalone protocol file — a `.prcl.txt` or a `.prcl` — against the
 * current password. The protocol-side counterpart of {@link PlateFileResult}, and a result wrapper
 * for the same reason: Bio-Rad's own `.prcl` is an encrypted container, so a protocol file can be
 * present and unreadable, which a bare string couldn't say. */
export interface ProtocolFileResult {
  /** The canonical one-line run definition (`prcl.md` §3), or null when nothing decoded. */
  runDefinition: string | null;
  /** The full decoded document, when the encoding carries more than the directive text: a `.prcl`
   * also has the XML step list the Protocol tab prefers over the listing. Null when locked. */
  protocol: ProtocolDocument | null;
  needsPassword: boolean;
  error: string | null;
  /** `.prcl` container metadata (including `encrypted`), available even before/without a working
   * password. Undefined for a `.prcl.txt`, which has no container. */
  container?: PrclContainer;
}

function parseProtocolBytes(
  kind: ProtocolFileKind,
  bytes: Uint8Array,
  password: string,
  name: string,
): ProtocolFileResult {
  if (kind === "prcl") {
    const prcl = parsePrcl(bytes, password ? { password } : undefined);
    return {
      runDefinition: prcl.protocol?.runDefinition ?? null,
      protocol: prcl.protocol ?? null,
      needsPassword: !!prcl.needsPassword,
      // A `.prcl` that decrypts but carries no `<protocol2>` is as unreadable as one that didn't
      // decrypt, and would otherwise show as an empty protocol with no explanation.
      error:
        prcl.error ??
        (!prcl.needsPassword && !prcl.protocol ? "No protocol in this file." : null),
      container: prcl.container,
    };
  }
  try {
    const runDefinition = parseRunDefinitionText(new TextDecoder().decode(bytes));
    return {
      runDefinition,
      // The file name is the protocol's identity — a `.prcl.txt` carries no `identityKey`, the
      // same way a `.plt.csv` carries no plate name of its own.
      protocol: protocolDocumentFromRunDefinition(name, runDefinition),
      needsPassword: false,
      error: null,
    };
  } catch (e) {
    // Admitted only if it parsed once (`fileKind`), so this means the bytes changed underneath us.
    return {
      runDefinition: null,
      protocol: null,
      needsPassword: false,
      error: e instanceof Error ? e.message : String(e),
    };
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
    // A freshly opened file is by definition the copy on disk.
    modified: false,
    ...defaultAnalysisSettings(),
  };
}

/**
 * The display half of a file's settings, as its record's {@link StoredView} — sets flattened to
 * arrays, and the analysis fields pointedly not written (they live in the file; see
 * {@link FileSettings}). {@link FileSettings.modified} isn't here either: it is a field of the
 * record itself.
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
 * A file's settings as its record holds them: the modified flag, plus whatever display state the
 * file had when the session ended. A file that was never looked at closely enough to change one has
 * no {@link StoredFile.view}, and comes back on defaults.
 *
 * Analysis fields are *not* read from the record: they come from the file's own `zpcrweb.json`,
 * and are merged in by the store's seeding effect.
 */
function fromStored(e: StoredFile): FileSettings {
  const v = e.view;
  if (!v) return { ...defaultSettings(), modified: e.modified };
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
    ...defaultAnalysisSettings(),
  };
}

/** True for file names this app knows how to load. */
function fileKind(name: string, bytes?: Uint8Array): FileKind | null {
  if (/\.zpcr$/i.test(name)) return "zpcr";
  if (/\.pcrd$/i.test(name)) return "pcrd";
  if (/\.pltd$/i.test(name)) return "pltd";
  if (/\.csv$/i.test(name)) return "platecsv";
  if (/\.bmrun$/i.test(name)) return "biomeme";
  if (isPrclName(name)) return "prcl";
  if (isAlfName(name)) return "alf";
  // `.txt` is far too generic an extension to route on, so it is admitted only when the content
  // really is a run definition (`prcl.md` §3.1), unlike every extension above, which names its
  // format. That also lets an instrument's own `ProtocolRunDefinition.txt` in unrenamed.
  if (/\.txt$/i.test(name) && bytes && looksLikeProtocolText(bytes)) return "prcltxt";
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
 * Turn a name and some bytes into a kind and a {@link FileContent} — the whole of "can the app open
 * this?", answered by actually opening it.
 *
 * Validation is eager on purpose: an obviously-bad file is rejected at the door rather than at the
 * first render that touches it. A `.pcrd`/`.pltd`'s *payload* may still need a password, which is
 * resolved reactively later (`runs`/`plateFiles`); what's checked here is the container.
 *
 * A `.zpcr` is unzipped exactly once, here, and the open archive it produces is both what validates
 * it and what the app goes on holding — a run still being written to is never re-zipped just to be
 * put away. See `fileContent.ts`.
 *
 * A run is likewise *parsed* exactly once: the validation parse is kept ({@link parseRunCached}),
 * so the decode that proves the file is openable is the same one the first render reads, rather
 * than one thrown away and immediately repeated.
 *
 * Shared by every way bytes arrive: an upload, a `#load=` URL, and a file read out of a granted
 * folder. Throws with a message meant for the user.
 */
function decodeFile(name: string, bytes: Uint8Array): { kind: FileKind; content: FileContent } {
  const kind = fileKind(name, bytes);
  if (!kind) {
    throw new Error(
      /\.txt$/i.test(name)
        ? // The name got this far, so say what was wrong with the *content* rather than repeating
          // the extension list — a `.txt` is only ever rejected for that.
          "not a thermal protocol (.prcl.txt)"
        : "not a .zpcr, .pcrd, .pltd, .csv, .prcl, .prcl.txt, .alf or .bmrun file",
    );
  }
  if (kind === "zpcr" || kind === "pcrd" || kind === "biomeme") {
    const content = kind === "zpcr" ? archiveContent(unzipArchive(bytes)) : plainContent(bytes);
    // Validate by parsing, and *keep* the parse: this is the same decode the first render wants,
    // so caching it here is what makes a dropped file cost one parse instead of two.
    const result = parseRunCached(content, kind, currentPltdPassword());
    // A `.zpcr`/`.bmrun` that doesn't decode is not a file this app can open — rejected at the
    // door, as it was when the parse threw and its result was discarded. A `.pcrd` is admitted
    // with whatever it said: a container it can't decrypt yet is a state the run views report
    // (`needsPassword`), not a bad file.
    if (kind !== "pcrd" && result.error) throw new Error(result.error);
    return { kind, content };
  }
  if (kind === "pltd") parsePltd(bytes);
  // The container only, exactly as for a `.pltd`: `parsePrcl` reports a payload that needs a
  // password (or failed to decrypt) rather than throwing, and that is resolved reactively later
  // (`protocolFiles`). What can be rejected here is a file that is neither an encrypted ZIP nor
  // the bare-text variant — `parseSingleEntryZip` throws on it.
  else if (kind === "prcl") parsePrcl(bytes);
  // Already validated by `fileKind`'s content sniff — parsing again would only repeat it.
  else if (kind === "prcltxt") void 0;
  // A report is validated by parsing it, the same as every binary format above: an `.alf` that
  // doesn't decode is not a report this app can show anything of.
  else if (kind === "alf") parseAlf(new TextDecoder().decode(bytes));
  else parsePlateCsv(new TextDecoder().decode(bytes));
  return { kind, content: plainContent(bytes) };
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
  if (/\.csv$/i.test(name)) return "platecsv";
  return null;
}

/** Options for {@link ZpcrStore.addFiles}. */
export interface AddFilesOptions {
  /**
   * Whether the last file added becomes the active one. Default true — dropping a file means
   * wanting to look at it.
   *
   * The run watcher passes false ordinarily. It writes to the in-progress run every time a cycle
   * completes, so activating unconditionally would drag the user back to the running experiment
   * every minute or two no matter what they had opened. It passes true instead for the pass that
   * comes from a run *starting* in this session, and for one the user asked to download
   * (`useRunWatch`'s `activate`) — files the person who acted wants selected, superseding whatever
   * was active before.
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
   * Every open file, metadata only (see {@link FileEntry}) — the Files table's rows, and the set a
   * file is closed out of.
   */
  files: FileEntry[];
  /**
   * The same files with their bytes in memory and decoded — the file bar's chips, and the only
   * files the rest of the app can show. Oldest first by `addedAt`, so the chips keep their places
   * across a reload however the reads were ordered. Shorter than {@link files} only while bytes are
   * on their way in, or for a file the app currently can't read (see {@link FileEntry}).
   */
  loaded: LoadedFile[];
  /**
   * Ids whose bytes are currently being read — a file the app is holding but can't draw yet.
   * {@link activeName} may name one, which is what lets a click select a file immediately instead
   * of waiting on a disk read.
   */
  loadingIds: Set<string>;
  /**
   * Open files whose bytes the app has failed to read, id → why, in words meant for the person
   * reading them. **They are still open**: the row stays in the catalog and in the Files table,
   * wearing a red badge instead of its type icon, because the file has not gone anywhere — only
   * the app's access to it has.
   *
   * The usual reason by far is a folder grant that didn't survive the reload, which is why nothing
   * here is reported as an error: selecting such a file asks for the permission back
   * (`setActive`), so the row *is* the affordance that fixes it.
   */
  unreadableIds: ReadonlyMap<string, string>;
  /**
   * The single selection: the one file every tab in the strip is a lens on, or `null` when
   * nothing is selected (everything closed, or a `#file=` naming a file this browser doesn't
   * have).
   */
  activeName: string | null;
  active: LoadedFile | null;
  /** Parse result for every loaded `.zpcr`/`.pcrd` file, keyed by id. A file is parsed once per
   * version of its bytes and re-parsed when they change — or, for a `.pcrd`, when the shared
   * decryption password does, so one unlocks reactively without reloading (`parseRunCached`). */
  runs: Map<string, RunResult>;
  activeRun: RunResult | null;
  /** Parse result for every loaded standalone `.pltd`/`.csv` file, keyed by id. */
  plateFiles: Map<string, PlateFileResult>;
  /** Parse result for every loaded standalone `.prcl`/`.prcl.txt` file, keyed by id. */
  protocolFiles: Map<string, ProtocolFileResult>;
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
  /** The selected file's protocol, when the selection is a `.prcl`/`.prcl.txt` — what the
   * Protocol tab renders, the counterpart of {@link activePlateFile}. */
  activeProtocolFile: ProtocolFileResult | null;
  /**
   * Ids of the files whose content has been edited since they were opened and not since
   * downloaded — thresholds, the experiment name, an attached plate (see
   * {@link FileSettings.modified}). The file bar and the Files table read it to decide whether
   * closing a file throws work away, and so has to be confirmed.
   */
  modifiedIds: Set<string>;
  /**
   * The user has just saved this file to disk: its edits are no longer at risk, so it stops
   * counting as modified. Called by the Overview toolbar's download button, whichever kind's
   * Overview it is — the one that writes the *whole* file ({@link ZpcrStore.exportBytes}: a
   * `.zpcr` including its `zpcrweb.json`, an edited `.prcl.txt` including its edits), and so the
   * only download that actually gets the edits out of the browser.
   */
  markDownloaded: (fileName: string) => void;
  /**
   * Attach (or replace) a `.zpcr` run's plate: rewrites the run's own archive bytes in place
   * (adding/replacing a `.pltd`/`.plt.csv` entry — see core's `attachPlate`) and persists the
   * result, so the plate travels with the file from then on and `zpcr.plates()` picks it up
   * with no separate override state. Only valid for a `kind === "zpcr"` run; sets `error`
   * otherwise (a `.pcrd` has no real archive to attach an entry to).
   */
  attachPlate: (fileName: string, file: File) => Promise<void>;
  /**
   * Attach (or replace) a `.zpcr` run's thermal protocol — the protocol-side mirror of
   * {@link attachPlate}, and what `AttachProtocolMenu` calls. Same restriction: only
   * `kind === "zpcr"`.
   */
  attachProtocol: (fileName: string, file: File) => Promise<void>;
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
  setRunProtocolText: (fileName: string, runDefinition: string) => void;
  /**
   * The plate-side mirror of {@link setRunProtocolText}: replace a `.zpcr` run's own plate entry
   * with an edited plate, in place, as the Plates tab's editor makes each change.
   *
   * `entryName` is the entry being rewritten — its existing name, so an edit keeps the plate under
   * the name the run already calls it by. It must be a `.plt.csv`: a `.pltd` has no writer in this
   * app (`pltcsv.md`), which is the same rule {@link setPlateText} follows for a standalone file.
   *
   * Goes through core's `attachPlate`, so "swap this run's plate for another" and "edit the one it
   * has" stay one operation at the archive layer — which also means the run keeps **exactly one**
   * plate entry afterwards. The caller only offers editing to a run that has exactly one, so no
   * sibling plate is ever the thing that gets dropped.
   */
  setRunPlateText: (fileName: string, entryName: string, plate: PlateDefinition) => void;
  /**
   * Name (or rename) a run's own protocol — the `ProtocolName.txt` entry, which is what the Protocol
   * tab's headline shows and edits. A standalone `.prcl.txt` has no such entry: its name *is* its
   * file name, so that case goes through {@link renameFile} instead.
   */
  setRunProtocolName: (fileName: string, name: string) => Promise<void>;
  /**
   * Turn a pending experiment into a started run, in place — what the Instrument tab's Start
   * button calls instead of seeding a new file. Restamps the file's date if it still carries the
   * one it was created/cloned under (`restampExperimentDate`, via the ordinary `renameFile` so
   * the catalog and IndexedDB stay consistent), then writes the `begun` marker
   * (`core/markExperimentBegun`). Returns the final file's name — which differs from `fileName`
   * if it was restamped — or `null` for a file that isn't a `kind === "zpcr"` pending experiment.
   */
  beginExperiment: (fileName: string) => Promise<{ name: string } | null>;
  /**
   * Rename a loaded file — what the Overview view's rename control calls. `newName` becomes
   * {@link LoadedFile.name}; bytes and content are untouched. A no-op for an empty name or one
   * that's already current.
   *
   * Ids hash name+size ({@link fileName}), so this necessarily gives the file a new id: every
   * id-keyed map (`settingsMap`, `analysisMap`, `activeName`) is migrated, and a name+size that
   * collides with an already-loaded file supersedes it, the same way re-uploading a same-named
   * file does in {@link ZpcrStore.addFiles}. Marks the file {@link FileSettings.modified}, since
   * a download now writes different bytes-under-a-name than what's on disk under the old one.
   */
  renameFile: (fileName: string, newName: string) => Promise<void>;
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
   * A no-op for a file that isn't `kind === "prcltxt"` — including a Bio-Rad `.prcl`, which this
   * project can read but not write: there is no encrypted-container writer, the same reason a
   * `.pltd` gets a plate grid with no pencil on it.
   */
  setProtocolText: (fileName: string, runDefinition: string) => void;
  /**
   * Replace a standalone `.plt.csv` plate file's contents with an edited plate — the plate-side
   * mirror of {@link setProtocolText}, and what the Plate view's editor calls after every change
   * (`components/plate/PlateEditor.tsx`).
   *
   * Takes the {@link PlateDefinition} rather than text: `plateToCsv` is the one place that knows
   * how a plate is spelled, exactly as `formatRunDefinitionText` is for a protocol. Same
   * write-behind throttle, same `modified` flag, and the same "Done is not Save" rule — the bytes
   * are updated on every edit, so leaving the view (or the app) can't lose one.
   *
   * A no-op for a file that isn't `kind === "platecsv"`. A `.pltd` is deliberately not editable: this
   * app has no `.pltd` writer (`pltcsv.md`), so there is nothing to save an edit into.
   */
  setPlateText: (fileName: string, plate: PlateDefinition) => void;
  settings: FileSettings | null;
  /** Selected top-level view (Overview/Curves/…) — global across all loaded files, not
   * per-file, so switching files doesn't reset it. */
  view: ViewId;
  setView: (v: ViewId) => void;
  loading: boolean;
  error: string | null;
  /** Dismiss {@link error}. The banner sits over the bottom-right corner of whatever is on screen,
   * so an error nobody can clear is an error that hides the controls underneath it for the rest of
   * the session. */
  clearError: () => void;
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
   * This is how a run being followed reaches the store (`useRunWatch`), and how a new experiment
   * and a run pulled off the instrument by hand do. A `.zpcr` is held as its entries
   * (`fileContent.ts`), so nothing is zipped on either side of this call.
   *
   * `merge` says the entries are an **update** to the file of this name rather than the whole of
   * it: they are laid over whatever that file already holds, and every other entry is left as it
   * stands. That is what a run being followed sends after its first pull — the plate read that
   * just arrived, and at the end of the run the `ended` marker, the `.alf` report and the handful
   * of files the instrument rewrites — and it is what keeps a plate the user swapped in mid-run
   * from being replaced by the instrument's copy on the next cycle. Without a file of that name to
   * merge into, the entries are the file, which is the same thing as `merge: false`.
   *
   * Returns the new file's id, or `null` if the result wouldn't parse (the reason lands in
   * {@link error}, as with `addFiles`).
   */
  addRunArchive: (
    name: string,
    archive: ZpcrArchive,
    options?: AddFilesOptions & { merge?: boolean },
  ) => Promise<string | null>;
  /**
   * Open files out of a granted folder — {@link addFiles} for files the app can read directly,
   * and the only way a **disk-backed** file gets opened.
   *
   * A file added this way keeps no copy in IndexedDB: it is read from disk when opened and written
   * back there when edited (see `state/diskFolders.ts`). Its name is its folder-rooted path,
   * `runs/2026-07/a.zpcr`, so two same-named files in different folders are different files, which
   * they weren't when everything was uploaded by base name.
   *
   * Returns the last file's id, or `null` if none could be read. Per-file failures land in
   * {@link error}, as with `addFiles`.
   */
  addDiskFiles: (sources: DiskSource[], options?: AddFilesOptions) => Promise<string | null>;
  /**
   * Re-read a loaded disk-backed file, because it changed on disk.
   *
   * Called by the file's own watch, not by the UI. The file keeps its display settings and analysis
   * state — it is the same file, edited elsewhere, not a new one — and any of the app's own edits
   * still waiting to be written are flushed out first, so the app's pending intent wins over what
   * is currently on disk rather than being silently discarded by it.
   */
  refreshDiskFile: (id: string) => Promise<void>;
  /**
   * Read in any open file whose bytes the app doesn't have — what a folder granted its permission
   * back means for the files inside it. Called by the Files view when a grant lands; ordinary
   * selection retries too, so nothing depends on this having been called.
   */
  retryUnread: () => void;
  /**
   * Whether this file can be renamed. False for a disk-backed file: its name is its path on the
   * user's disk, and the File System Access API cannot rename — see {@link renameFile}.
   */
  canRename: (id: string) => boolean;
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
   * implementation, how the welcome screen's example button works, and how a file is opened out of
   * the bundled `samples` folder (`lib/samples.ts`). The name comes from the URL's last path
   * segment (see {@link fileNameFromUrl}); the loaded file's name comes back, or `null` if the
   * fetch or the decode failed (the error is reported through {@link error} either way).
   */
  addUrl: (url: string) => Promise<string | null>;
  setActive: (id: string) => void;
  /**
   * Close a file: its bytes leave memory and its records leave IndexedDB, in one act. A
   * disk-backed file's bytes are the file on the user's disk and are left exactly where they are —
   * closing one is forgetting about it, never deleting it — but anything the app still owed that
   * file is written out first, so an edit made a second ago isn't lost to the throttle.
   *
   * The only way a file leaves the app, which is why the controls that call it (the chip's ✕, the
   * Files table's ✕ — one component, `CloseFileButton.tsx`) ask twice for a file carrying edits
   * that exist nowhere else ({@link modifiedIds}).
   *
   * Closing the selected file moves the selection to another open file, or clears it.
   */
  closeFile: (id: string) => Promise<void>;
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
  exportBytes: (fileName: string) => Uint8Array | null;
}

export function useZpcrStore(): ZpcrStore {
  /** Every open file, metadata only. Ordered by `addedAt`, oldest first. */
  const [entries, setEntries] = useState<FileEntry[]>([]);
  /** The loaded set — bytes in memory. A subset of {@link entries}, in load order (the file
   * bar's order). */
  const [loadedFiles, setLoadedFiles] = useState<LoadedFile[]>([]);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const [unreadableIds, setUnreadableIds] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [settingsMap, setSettingsMap] = useState<Record<string, FileSettings>>({});
  const [activeName, setActiveName] = useState<string | null>(null);
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
   * Keep the catalog row in step with a change to a loaded file — its bytes (so its `size`) or its
   * identity (a rename). The two lists describe the same files and must agree about them.
   */
  const patchEntry = useCallback((id: string, patch: Partial<FileEntry>) => {
    setEntries((prev) => {
      entriesRef.current = prev.map((e) => (e.name === id ? { ...e, ...patch } : e));
      return entriesRef.current;
    });
  }, []);

  // ── Disk-backed files ────────────────────────────────────────────────────────────────────
  // A file opened out of a granted folder is written back to that file rather than into
  // IndexedDB, so this is the equivalent of `persistFile`'s `putFile` for those — throttled,
  // because a disk write is always the whole file and there is no per-entry delta to exploit.
  //
  // Nothing here decides *whether* a file is disk-backed; `persistFile` does, and only calls
  // `markDirty` for the ones that are. A run the instrument is still writing is deliberately not
  // among them — it buffers into IndexedDB and lands on disk once, when it finishes (see the
  // completion effect further down).
  const diskThrottle = useRef<WriteThrottle>();
  if (!diskThrottle.current) {
    diskThrottle.current = new WriteThrottle({
      minIntervalMs: DISK_WRITE_INTERVAL_MS,
      // Read the file at flush time, as the protocol throttle does, so coalesced edits write once
      // with the latest bytes.
      write: async (id) => {
        const file = loadedRef.current.find((f) => f.name === id);
        if (!file?.source) return;
        // The run started while this write was pending: leave it to the completion effect rather
        // than dropping a half-written run on the user's disk.
        if (isRunInProgress(file)) return;
        const bytes = contentBytes(contentToStore(file, analysisRef.current[id]));
        const lastModified = await writeDiskFile(file.source, bytes);
        // The file on disk really did just change, so unlike an in-place IndexedDB edit (see
        // `withContent`) its mtime moves, and the catalog should say so.
        patchEntry(id, { lastModified });
        void updateFile(id, { lastModified });
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }
  useEffect(() => diskThrottle.current!.attach(), []);
  /** Stable across renders, so `persistFile` can be handed it from anywhere without rebuilding a
   * throttle or a callback chain. */
  const markDiskDirty = useCallback((id: string) => diskThrottle.current!.markDirty(id), []);

  /**
   * Where a watch's news about a file ends up. A ref because the handler needs `refreshDiskFile`,
   * which is defined much further down and rebuilt as the store's state changes — while a watch,
   * once started, has to go on delivering to whatever the current handler is.
   */
  const diskEventRef = useRef<(name: string, event: DiskFileEvent) => void>(() => {});
  /** Start watching a loaded disk-backed file, so an edit made in another program shows up here.
   * Stopping is `unwatchDiskFile`, called wherever a file stops being loaded. */
  const startDiskWatch = useCallback((name: string, source: DiskSource) => {
    watchDiskFile(name, source, (event) => diskEventRef.current(name, event));
  }, []);

  const persister = useRef<AnalysisPersister>();
  if (!persister.current) {
    persister.current = new AnalysisPersister({
      resolve: (id) => {
        const file = loadedRef.current.find((f) => f.name === id);
        // Only a `.zpcr` has an archive to put an entry in. A `.pcrd` is a single encrypted XML
        // document whose own `dataAnalysisParameters` we don't yet write (see `pcrd.md` §2.5),
        // and a standalone plate file has no analysis at all — for those, edits are live for
        // the session and then gone, which is the honest behavior while the file can't hold them.
        if (!file || file.kind !== "zpcr") return null;
        // A disk-backed file's settings travel to disk with the rest of it (`persistFile`), so
        // this must not also write them into IndexedDB — the one write path that reaches `putFile`
        // without going through `persistFile` is this one, and a copy left here would be read in
        // preference to the disk on the next load (`loadOne`).
        if (file.source) return null;
        const settings = analysisRef.current[id];
        if (!settings) return null;
        return { identity: identityOf(file), files: contentFiles(file.content), settings };
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }
  useEffect(() => persister.current!.attach(), []);

  // ── Document edits (protocol, plate) ─────────────────────────────────────────────────────
  // The same write-behind policy as an analysis edit, on a much shorter window: a `.prcl.txt` or
  // a `.plt.csv` is a few hundred bytes to a few kilobytes, so the write costs nothing next to the
  // archive rewrite the minute-long window above exists to space out — and a document being typed
  // at is state a person would be upset to lose. See `writeThrottle.ts`. Shared by the app's
  // three document editors, all of which have already updated `loadedRef.current`/`files`
  // themselves before marking dirty: a standalone `.prcl.txt` (`setProtocolText`), a pending
  // experiment's in-place protocol (`setRunProtocolText`) and a standalone `.plt.csv`
  // (`setPlateText`) — this throttle only has to persist whatever bytes it finds under the id at
  // flush time, whichever editor wrote them.
  const editThrottle = useRef<WriteThrottle>();
  if (!editThrottle.current) {
    editThrottle.current = new WriteThrottle({
      minIntervalMs: EDIT_WRITE_INTERVAL_MS,
      // Read the file at flush time, never at edit time, so the write always lands the latest
      // text even when several edits coalesced into one trailing write.
      write: async (id) => {
        const file = loadedRef.current.find((f) => f.name === id);
        if (!file || (file.kind !== "prcltxt" && file.kind !== "zpcr" && file.kind !== "platecsv")) return;
        await persistFile(file, analysisRef.current[id], undefined, markDiskDirty);
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }
  useEffect(() => editThrottle.current!.attach(), []);

  const clearError = useCallback(() => setError(null), []);

  /** Forget that a file couldn't be read — it just was, or it is about to be tried again. */
  const clearReadFailure = useCallback((id: string) => {
    setUnreadableIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /**
   * Record that a file's bytes couldn't be read, and decide whether it is worth interrupting over.
   *
   * A lapsed folder permission is **not**: it is a question the browser is waiting to be asked, and
   * the app asks it when the file is clicked ({@link setActive}). Reporting it as an error would put
   * a banner of the platform's own wording over the very buttons that fix it, so it only marks the
   * file — the Files table draws such a row with a red badge and the row goes on being a row.
   *
   * Anything else — a file deleted out from under us, bytes that no longer decode — is a real
   * failure the user can't be expected to guess at, and still says so.
   */
  const noteReadFailure = useCallback((id: string, e: unknown) => {
    const lapsed = isPermissionError(e);
    const message = lapsed ? PERMISSION_LAPSED : e instanceof Error ? e.message : String(e);
    setUnreadableIds((prev) => new Map(prev).set(id, message));
    if (!lapsed) setError(`${id}: ${message}`);
  }, []);

  /**
   * Read one open file's bytes — out of IndexedDB, or off the user's disk — and put it in the
   * loaded set. The *only* place bytes enter memory, and so the only place a file is ever decoded
   * (the `runs`/`plateFiles`/`protocolFiles` maps below parse the loaded set and nothing else).
   *
   * A no-op for a file already loaded. Returns the `LoadedFile`, or null for a file with neither a
   * stored copy nor a source to read from. **Throws** if the read or decode fails — a disk-backed
   * file whose folder is waiting on its permission back is the ordinary case — and the caller
   * decides what that means; the entry stays, so the next attempt can succeed.
   */
  const loadOne = useCallback(async (entry: FileEntry): Promise<LoadedFile | null> => {
    if (loadedRef.current.some((f) => f.name === entry.name)) return null;
    setLoadingIds((prev) => new Set(prev).add(entry.name));
    try {
      // IndexedDB first even for a disk-backed file: the one thing that puts a disk-backed file's
      // bytes here is a run the instrument is still writing, and *that* copy is the current one —
      // the file on disk is whatever the run looked like before it started.
      const stored = await getContent(entry.name);
      let file: LoadedFile;
      if (stored) {
        file = {
          name: entry.name,
          size: entry.size,
          addedAt: entry.addedAt,
          kind: entry.kind,
          // Either representation comes back as itself: a run stored open stays open (and so stays
          // cheap to append to across a reload), a zipped one stays zipped. See `fileContent.ts`.
          content: fromStoredContent(stored),
          lastModified: entry.lastModified,
          ...(entry.source ? { source: entry.source } : {}),
        };
      } else if (entry.source) {
        // Read from the user's disk and decode exactly as an upload would be — a file that has
        // been edited or replaced since the app last saw it is simply the file as it is now.
        const { bytes, lastModified } = await readDiskFile(entry.source);
        const { kind, content } = decodeFile(entry.name, bytes);
        file = {
          name: entry.name,
          size: contentSize(content),
          addedAt: entry.addedAt,
          kind,
          content,
          lastModified,
          source: entry.source,
        };
        patchEntry(entry.name, { size: file.size, kind, lastModified });
      } else {
        return null;
      }
      if (file.source) startDiskWatch(file.name, file.source);
      loadedRef.current = [...loadedRef.current.filter((f) => f.name !== file.name), file];
      setLoadedFiles(loadedRef.current);
      // Only now: the badge says *the last attempt failed*, so it belongs on the row until one
      // succeeds. Clearing it when the attempt started would take it off a row that is about to
      // get it straight back, which reads as a flicker rather than as an answer.
      clearReadFailure(entry.name);
      return file;
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.name);
        return next;
      });
    }
  }, [clearReadFailure, patchEntry, startDiskWatch]);

  /**
   * Read a file in *because the user asked for it* — a click on its row or its chip. A fresh
   * attempt, whatever went wrong last time; a fresh failure leaves the file marked unreadable and
   * its row clickable again.
   *
   * Asking the browser for a lapsed folder's permission back is deliberately **not** here. That is
   * one act on a *folder*, not on a file — it re-reads its listings, re-arms its watches and reads
   * back in every open file inside it — and it already has exactly one implementation, the Grant
   * access button's (`useDiskTree`'s `grant`). A click on an unreadable file routes there too
   * (`App.tsx`'s `selectFromTable`), which is what stops one file's click being answered with one
   * file's worth of recovery.
   */
  const openEntry = useCallback(
    async (entry: FileEntry) => {
      try {
        await loadOne(entry);
      } catch (e) {
        noteReadFailure(entry.name, e);
      }
    },
    [loadOne, noteReadFailure],
  );

  // Hydrate from IndexedDB on mount: the whole catalog first (metadata only — no archive is read,
  // let alone unzipped), so the app knows what it is holding, and then the bytes of each of those
  // files. Everything in the catalog is a file the session was left with open; a file the user
  // closed took its records with it (see `closeFile`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // One read, one record per file: the catalog row and its settings are the same object now.
        const stored = await getAllFiles();
        if (cancelled) return;
        const catalog: FileEntry[] = stored.map((e) => ({
          name: e.name,
          size: e.size,
          addedAt: e.addedAt,
          kind: e.kind,
          lastModified: e.lastModified,
          ...(e.source ? { source: e.source } : {}),
        }));
        catalog.sort((a, b) => a.addedAt - b.addedAt);
        const map: Record<string, FileSettings> = {};
        for (const e of stored) map[e.name] = fromStored(e);
        setEntries(catalog);
        // A `#file=` from the URL picks the selection; without one, the most recently added file.
        // A link naming a file this browser doesn't have selects **nothing** rather than silently
        // substituting another — the app then shows the file bar with no tab available, which is
        // the truthful answer to "that file isn't here".
        const wanted = readHash().file;
        const target = wanted
          ? catalog.find((f) => f.name === wanted) ?? null
          : catalog.at(-1) ?? null;
        setSettingsMap(map);
        if (!cancelled) setActiveName(target?.name ?? null);
        // The selected file is read first, so the app has something to draw before the rest arrive.
        // A file that can't be read is *kept* — a folder whose permission has lapsed is the usual
        // reason, and dropping the row would delete the user's own bookkeeping over a dialog they
        // haven't answered yet. It stays listed, and reads itself in when it next can (`setActive`,
        // `retryUnread`).
        for (const e of target ? [target, ...catalog.filter((f) => f.name !== target.name)] : catalog) {
          if (cancelled) return;
          try {
            await loadOne(e);
          } catch (err) {
            noteReadFailure(e.name, err);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadOne, noteReadFailure]);

  // ── URL hash sync ────────────────────────────────────────────────────────────────────
  // Both directions are guarded by "is it already that value?" checks (here and in
  // `writeHash`), so the echo each direction provokes in the other terminates immediately
  // instead of looping.
  const active = useMemo(() => loadedFiles.find((f) => f.name === activeName) ?? null, [loadedFiles, activeName]);
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
        // Against the catalog, not the loaded set: the file may be one the app hasn't managed to
        // read yet, and following the link is a fresh attempt at it rather than nothing at all.
        const match = entries.find((f) => f.name === h.file);
        if (match) void selectRef.current(match.name);
      }
    });
  }, [entries]);

  /** Drop everything the app holds under a file id, storage included — the whole of
   * {@link closeFile}, and what the same-name replacement in {@link addFiles} needs. */
  const forget = useCallback(async (id: string) => {
    await deleteFile(id);
    setEntries((prev) => prev.filter((e) => e.name !== id));
    setLoadedFiles((prev) => {
      loadedRef.current = prev.filter((f) => f.name !== id);
      return loadedRef.current;
    });
    setSettingsMap((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    // Drop any pending settings write for a file that no longer exists, and let it re-seed
    // from its own bytes if it's ever loaded again.
    persister.current!.forget(id);
    editThrottle.current!.forget(id);
    // `forget`, not `flush` — the flush, when one is owed, has already happened in `closeFile`.
    // Here the file is going either way, so a pending write must not fire against a file the app
    // has stopped holding.
    diskThrottle.current!.forget(id);
    clearReadFailure(id);
    unwatchDiskFile(id);
    seeded.current.delete(id);
    setAnalysisMap((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, [clearReadFailure]);

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
      void updateFile(id, { modified: value, view: viewOf(next) });
      return { ...prev, [id]: next };
    });
  }, []);

  const markDownloaded = useCallback(
    (id: string) => setModifiedFlag(id, false),
    [setModifiedFlag],
  );

  /**
   * Read in an open file whose bytes the app doesn't have yet, ignoring the ordinary reason it
   * might not have them: a folder still waiting on its permission back. Called when the app gets a
   * fresh chance at the disk — a folder granted, a file selected — rather than on a timer, since
   * nothing else changes the answer.
   */
  const retryUnread = useCallback(() => {
    for (const entry of entriesRef.current) {
      if (loadedRef.current.some((f) => f.name === entry.name)) continue;
      void loadOne(entry).catch((e) => {
        // Still unreadable. It keeps its row and its badge, and will be tried again.
        noteReadFailure(entry.name, e);
      });
    }
  }, [loadOne, noteReadFailure]);

  /**
   * Put a validated file into the catalog *and* the loaded set: write the record, land it in both
   * lists. The tail every way of adding a file shares — a drop, a `#load=`, and a snapshot of a run
   * in progress ({@link addRunArchive}) — so they differ in how the content is *obtained* and in
   * one deliberate flag, below.
   *
   * An added file is a loaded file: this is the one path by which a file's content is in hand
   * without a read from IndexedDB.
   *
   * **A name is a file.** The record's key is the file's name, so writing here replaces whatever
   * held that name — there is no separate supersede step, and no window in which two rows share a
   * name and `#file=` has two candidates to mean.
   *
   * What that replacement *means* is the caller's to say, and it is the one thing a drop and a
   * snapshot disagree about:
   *
   * - `replacing: false` — another snapshot of a file we are already following. Everything the
   *   record accumulated belongs to the file, not to this snapshot, so the display settings, the
   *   analysis state and the modified flag all stay. This is what stops a live run resetting its
   *   own settings once per plate read.
   * - `replacing: true` — the user dropped a different file over a name in use. It is a new file
   *   that happens to share a name, so everything the old one accumulated goes with it.
   */
  const install = useCallback(
    async (
      file: LoadedFile,
      options: { modified: boolean; replacing: boolean; diskInSync?: boolean },
    ): Promise<string> => {
      const prior = entriesRef.current.find((f) => f.name === file.name);
      const priorLoaded = loadedRef.current.find((f) => f.name === file.name);
      // The version this write replaces, read before the loaded set moves on — what tells the store
      // which entries are already on disk (`persistFile`). A replacement shares nothing meaningful
      // with what it replaces, so it is written whole.
      const previous = options.replacing ? undefined : priorLoaded?.content;
      if (options.replacing && prior) {
        // A pending write belongs to content that no longer exists: drop it rather than let it
        // flush onto the file that has just taken its place.
        persister.current!.forget(file.name);
        editThrottle.current!.forget(file.name);
        seeded.current.delete(file.name);
        window.clearTimeout(saveTimers.current[file.name]);
        setAnalysisMap((prev) => {
          const { [file.name]: _drop, ...rest } = prev;
          analysisRef.current = rest;
          return rest;
        });
        setSettingsMap((prev) => ({ ...prev, [file.name]: defaultSettings() }));
        await updateFile(file.name, { view: undefined, modified: false });
      }
      const entry: FileEntry = {
        name: file.name,
        size: file.size,
        addedAt: file.addedAt,
        kind: file.kind,
        lastModified: file.lastModified,
        ...(file.source ? { source: file.source } : {}),
      };
      // Normally nothing to layer in — a file arriving from disk hasn't been seeded yet, and its
      // own `zpcrweb.json` (if it has one) is already in the bytes. A snapshot of a run we are
      // following keeps whatever was typed against it, which is exactly what must not be lost.
      await persistFile(
        file,
        options.replacing ? undefined : analysisRef.current[file.name],
        previous,
        options.diskInSync ? null : markDiskDirty,
      );
      setEntries((prev) => {
        entriesRef.current = [...prev.filter((f) => f.name !== file.name), entry];
        return entriesRef.current;
      });
      setLoadedFiles((prev) => {
        loadedRef.current = [...prev.filter((f) => f.name !== file.name), file];
        return loadedRef.current;
      });
      if (options.modified) setModifiedFlag(file.name, true);
      // Every route to a loaded disk-backed file passes through here or through `loadOne`, and
      // both have to start the watch — a file opened from the tree arrives by this one. Not for a
      // file already loaded from the same place, though: a run being followed re-installs itself
      // once per plate read, and `watchDiskFile` re-arms by disconnecting and rebuilding the
      // observer, so re-watching there would tear down a live watch forty-five times over.
      const sameSource =
        priorLoaded?.source &&
        file.source &&
        !options.replacing &&
        diskFileName(priorLoaded.source) === diskFileName(file.source);
      if (file.source && !sameSource) startDiskWatch(file.name, file.source);
      return file.name;
    },
    [setModifiedFlag, startDiskWatch],
  );

  /**
   * Persist an in-place edit to a loaded file — the record, the loaded set, and the catalog row's
   * size, which is the one identity field an edit can change. Every archive edit below ends here,
   * so none of them has to know how a file is stored (`fileContent.ts`) or that the catalog exists.
   */
  const commitContent = useCallback(
    async (next: LoadedFile) => {
      const previous = loadedRef.current.find((f) => f.name === next.name)?.content;
      await persistFile(next, analysisRef.current[next.name], previous, markDiskDirty);
      setLoadedFiles((prev) => {
        loadedRef.current = replaceFile(prev, next);
        return loadedRef.current;
      });
      patchEntry(next.name, { size: next.size });
    },
    [patchEntry],
  );

  const addFiles = useCallback(
    async (input: FileList | File[], options?: AddFilesOptions) => {
      // `.txt`'s kind can only be known after reading its bytes (see `fileKind`), so every file
      // is read up front rather than filtered by extension first the way the other formats are.
      const candidates = Array.from(input).filter((file) => matchesSupportedExtension(file.name));
      let lastName: string | null = null;
      let lastKind: FileKind | null = null;
      for (const file of candidates) {
        try {
          const buf = await file.arrayBuffer();
          const { kind, content } = decodeFile(file.name, new Uint8Array(buf));
          // Dropping a file replaces whatever held its name, and counts as a *different* file:
          // the copy on disk is authoritative, and whatever the old one accumulated here — its
          // display settings, its modified flag — described something else.
          await install(
            {
              name: file.name,
              size: contentSize(content),
              addedAt: Date.now(),
              kind,
              content,
              lastModified: file.lastModified,
            },
            { modified: options?.modified === true, replacing: true },
          );
          lastName = file.name;
          lastKind = kind;
        } catch (e) {
          setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (lastName && options?.activate !== false) setActiveName(lastName);
      // A protocol file is a document first: opening one shows the file — its identity card, with
      // the protocol itself one tab over — rather than dropping you into the Instrument view's
      // staging panel, which is a thing you go to when you mean to start a run. Done here
      // rather than at the call site so every entry point (the header button, a drop, `#load=`)
      // behaves alike. Both protocol encodings, since which one a protocol arrived in is not a
      // reason to open it somewhere else — a locked `.prcl` then wears its padlock on its chip and
      // finds its prompt on the Protocol tab, exactly as a locked `.pltd` does on Plates.
      if (lastKind === "prcltxt" || lastKind === "prcl") setView("overview");
      return lastName;
    },
    [install],
  );

  /** See {@link ZpcrStore.addRunArchive}. */
  const addRunArchive = useCallback(
    async (
      name: string,
      archive: ZpcrArchive,
      options?: AddFilesOptions & { merge?: boolean },
    ): Promise<string | null> => {
      try {
        // An update is laid over the file it updates; the entries it doesn't mention keep whatever
        // is already there, including anything the app itself put in the archive — a swapped-in
        // plate, an edited protocol. Spread by reference, so an entry that didn't change is the
        // same array it was and `changedEntries` still writes one record per plate read.
        const held = options?.merge
          ? loadedRef.current.find((f) => f.name === name)?.content
          : undefined;
        const content = archiveContent(
          held?.archive ? { ...held.files, ...archive } : archive,
        );
        // Validated by parsing, and the parse is kept (`parseRunCached`) — a run being followed
        // arrives here once per cycle, so decoding the archive twice would be twice per cycle.
        const validated = parseRunCached(content, "zpcr", currentPltdPassword());
        if (validated.error) throw new Error(validated.error);
        const size = contentSize(content);
        // A run's snapshots are one file getting longer under one name, so they are one record,
        // rewritten in place. Nothing about the key moves as the run grows — which is what keeps a
        // plate read from costing a delete, a full rewrite, and the run's own display settings.
        //
        // Settle any pending analysis write first. Both it and this snapshot hand the store a
        // *complete* archive, so whichever lands second decides which entries exist — and a
        // threshold edit flushing after this one would be working from an archive without the plate
        // read that just arrived. Same precedent as `renameFile` and `setRunProtocolName`.
        await persister.current!.flush(name);
        await diskThrottle.current!.flush(name);
        const previous = entriesRef.current.find((f) => f.name === name);
        const installed = await install(
          {
            name,
            size,
            // A run's successive snapshots are the same file getting longer, so it keeps the
            // moment it first appeared rather than jumping to the end of the bar every cycle.
            addedAt: previous?.addedAt ?? Date.now(),
            kind: "zpcr",
            content,
            lastModified: Date.now(),
            // A snapshot of a run started from a file in a granted folder is still that file. The
            // source travels with it, so the reads buffer into IndexedDB while the run is going and
            // the finished run is written back to the very file it was started from (`persistFile`,
            // and the completion effect below); dropped, the run would quietly become a
            // browser-only copy and the file on disk would never be updated.
            ...(previous?.source ? { source: previous.source } : {}),
          },
          { modified: options?.modified === true, replacing: false },
        );
        if (options?.activate !== false) setActiveName(installed);
        return installed;
      } catch (e) {
        setError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    [install],
  );

  /** See {@link ZpcrStore.addDiskFiles}. */
  const addDiskFiles = useCallback(
    async (sources: DiskSource[], options?: AddFilesOptions) => {
      let lastName: string | null = null;
      for (const source of sources) {
        const name = diskFileName(source);
        try {
          const { bytes, lastModified } = await readDiskFile(source);
          const { kind, content } = decodeFile(name, bytes);
          // `replacing: true` for the same reason a drop is: whatever this name held before, the
          // file on disk is the authority on what it is now.
          await install(
            {
              name,
              size: contentSize(content),
              addedAt: Date.now(),
              kind,
              content,
              lastModified,
              source,
            },
            // These bytes came off the disk a moment ago; writing them straight back would only
            // change the file for no reason.
            { modified: options?.modified === true, replacing: true, diskInSync: true },
          );
          lastName = name;
        } catch (e) {
          setError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (lastName && options?.activate !== false) setActiveName(lastName);
      return lastName;
    },
    [install],
  );

  /** See {@link ZpcrStore.refreshDiskFile}. */
  const refreshDiskFile = useCallback(
    async (id: string) => {
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file?.source) return;
      // An edit of ours that hasn't reached disk yet would be silently overwritten by what's
      // there. Send it first: last writer wins, and between the app and an external editor the
      // app is the one whose intent is still pending.
      await diskThrottle.current!.flush(id);
      try {
        const { bytes, lastModified } = await readDiskFile(file.source);
        const { kind, content } = decodeFile(id, bytes);
        // Not `install` with `replacing`: this is the *same* file, changed underneath us, so its
        // *display* state — which wells are hidden, log vs. linear — stays exactly as it was.
        const next: LoadedFile = { ...file, kind, content, size: contentSize(content), lastModified };
        setLoadedFiles((prev) => {
          loadedRef.current = replaceFile(prev, next);
          return loadedRef.current;
        });
        // Its *analysis* state does not, and must not: thresholds and the run's name live in the
        // file's own `zpcrweb.json`, so the bytes that just arrived are the authority on them.
        // Dropping the seed mark lets the seeding effect read them back out of the new content —
        // without this, a run renamed in another copy of the app would go on showing the name this
        // one happened to be holding, and the next write would put it back.
        seeded.current.delete(id);
        setAnalysisMap((prev) => {
          const { [id]: _drop, ...rest } = prev;
          analysisRef.current = rest;
          return rest;
        });
        patchEntry(id, { size: next.size, kind, lastModified });
        void updateFile(id, { size: next.size, kind, lastModified });
      } catch (e) {
        setError(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [patchEntry],
  );

  /** See {@link ZpcrStore.canRename}. Asked of the catalog, not the loaded set, so it answers for a
   * file whose bytes haven't arrived too. */
  const canRename = useCallback(
    (id: string) => !entriesRef.current.find((e) => e.name === id)?.source,
    [],
  );

  // Route a watch's news to the current `refreshDiskFile` — see `diskEventRef`. A file reported
  // missing is left loaded and untouched: the bytes in memory are the last good copy of it, and
  // the watch goes on trying to re-attach in case the file comes back.
  useEffect(() => {
    diskEventRef.current = (name, event) => {
      if (event === "changed") void refreshDiskFile(name);
    };
  }, [refreshDiskFile]);

  /**
   * Fetch → `addFiles`, so a URL-loaded file goes through exactly the same validate/persist path
   * as a dropped one. `credentials: "omit"` because the URL comes from a link: a shared
   * `#load=` must not be able to use the recipient's cookies to fetch something private and pull
   * it into the page. Cross-origin URLs are allowed but need CORS, like any other fetch.
   */
  const addUrl = useCallback(
    async (url: string) => {
      // A bundled sample is filed under its folder like any other folder's file, however it was
      // asked for — including through `#load=`, which is how the welcome screen opens one.
      const name = sampleNameFromUrl(url) ?? fileNameFromUrl(url);
      try {
        // Only the name is checked here, against the one list of openable extensions the picker
        // and the disk lister use; `addFiles` below does the real (content-based) validation once
        // it has the bytes.
        if (!matchesSupportedExtension(name)) {
          throw new Error(`not one of ${SUPPORTED_EXTENSIONS.join(", ")}`);
        }
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) throw new Error(`fetch failed (HTTP ${res.status})`);
        return await addFiles([new File([await res.arrayBuffer()], name)]);
      } catch (e) {
        setError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
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

  /** See {@link ZpcrStore.closeFile}. */
  const closeFile = useCallback(
    async (id: string) => {
      // Anything the app still owes the file on the user's disk goes out first: the edit was made,
      // it is only the throttle that hasn't got to it, and closing the file must not be what
      // decides whether it was kept. The IndexedDB writes are pointedly *not* flushed — those
      // records are about to be deleted, so writing them would be work to undo a line later.
      await diskThrottle.current!.flush(id);
      // `forget` takes the file out of both lists and out of storage; all that's left is the
      // selection, which may have been pointing at it. Falling back to the most recently opened
      // file keeps closing a file you weren't looking at from moving the view.
      await forget(id);
      setActiveName((cur) => (cur === id ? loadedRef.current.at(-1)?.name ?? null : cur));
    },
    [forget],
  );

  // Switching files flushes anything pending: the window of unsaved analysis edits then only
  // ever covers the file you're actually looking at.
  //
  // The one selection is the file every tab in the strip is a lens on, so it has to be a file
  // whose bytes the app is holding — which every open file is, except one the app hasn't managed
  // to read yet. Selecting that one is also a fresh attempt at it ({@link openEntry}), since a
  // click on a file the user can see is the most likely moment for its folder to have been
  // granted. The id is set at once and the bytes arrive after (`loadingIds`), so the click
  // responds immediately rather than after a disk read.
  const setActive = useCallback(
    (id: string) => {
      void persister.current!.flushAll();
      void editThrottle.current!.flushAll();
      void diskThrottle.current!.flushAll();
      setActiveName(id);
      if (!loadedRef.current.some((f) => f.name === id)) {
        const entry = entriesRef.current.find((e) => e.name === id);
        if (entry) void openEntry(entry);
      }
    },
    [openEntry],
  );
  selectRef.current = setActive;

  const attachPlate = useCallback(
    async (targetFileName: string, file: File) => {
      const kind = plateFileKind(file.name);
      if (!kind) {
        setError(`${file.name}: not a .pltd or .csv file`);
        return;
      }
      const target = loadedFiles.find((f) => f.name === targetFileName);
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
        if (kind === "platecsv") parsePlateCsv(new TextDecoder().decode(plateBytes));
        // Working on the archive itself: free for a run still in progress or not yet started (the
        // common case for attaching a plate), and an unzip + re-zip for a finished one, which is
        // what it always cost. See `fileContent.ts`.
        await commitContent(
          withContent(
            target,
            archiveContent(
              attachPlateToArchive(contentFiles(target.content), {
                name: file.name,
                bytes: plateBytes,
              }),
            ),
          ),
        );
        // The archive itself now differs from the one on disk, which is exactly what the flag is
        // for — a plate attached and then deleted is as much lost work as a threshold is.
        setModifiedFlag(target.name, true);
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [loadedFiles, setModifiedFlag, commitContent],
  );

  /** See {@link ZpcrStore.attachProtocol}. */
  const attachProtocol = useCallback(
    async (targetFileName: string, file: File) => {
      const target = loadedFiles.find((f) => f.name === targetFileName);
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
            archiveContent(attachProtocolToArchive(contentFiles(target.content), { runDefinition, name })),
          ),
        );
        setModifiedFlag(target.name, true);
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
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file || file.kind !== "zpcr") return;
      // A keystroke in the protocol editor: on the pending experiment this is only ever called
      // for, replacing the run-definition entry is one `TextEncoder` call and no ZIP work at all.
      const next = withContent(
        file,
        archiveContent(attachProtocolToArchive(contentFiles(file.content), { runDefinition })),
      );
      loadedRef.current = replaceFile(loadedRef.current, next);
      setLoadedFiles((prev) => replaceFile(prev, next));
      patchEntry(id, { size: next.size });
      setModifiedFlag(id, true);
      editThrottle.current!.markDirty(id);
    },
    [setModifiedFlag, patchEntry],
  );

  /** See {@link ZpcrStore.setRunPlateText}. */
  const setRunPlateText = useCallback(
    (id: string, entryName: string, plate: PlateDefinition) => {
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file || file.kind !== "zpcr") return;
      // Same shape as `setRunProtocolText`, and the same reasoning line for line: an edit to an
      // open archive is one `TextEncoder` call and no ZIP work, so it is cheap enough to run on
      // every keystroke.
      const next = withContent(
        file,
        archiveContent(
          attachPlateToArchive(contentFiles(file.content), {
            name: entryName,
            bytes: new TextEncoder().encode(plateToCsv(plate)),
          }),
        ),
      );
      loadedRef.current = replaceFile(loadedRef.current, next);
      setLoadedFiles((prev) => replaceFile(prev, next));
      patchEntry(id, { size: next.size });
      setModifiedFlag(id, true);
      editThrottle.current!.markDirty(id);
    },
    [setModifiedFlag, patchEntry],
  );

  /** See {@link ZpcrStore.setRunProtocolName}. */
  const setRunProtocolName = useCallback(
    async (id: string, name: string) => {
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file || file.kind !== "zpcr") return;
      // Flush a pending protocol-text write first: both rewrite the same two entries, and writing
      // from a stale archive would drop whichever edit hadn't landed.
      await editThrottle.current!.flush(id);
      const current = loadedRef.current.find((f) => f.name === id) ?? file;
      const archive = contentFiles(current.content);
      let runDefinition: string;
      try {
        runDefinition = parseZpcrArchive(archive).protocolText;
      } catch {
        return;
      }
      if (!runDefinition) return;
      await commitContent(
        withContent(current, archiveContent(attachProtocolToArchive(archive, { runDefinition, name }))),
      );
      setModifiedFlag(id, true);
    },
    [setModifiedFlag, commitContent],
  );

  /** See {@link ZpcrStore.setProtocolText}. */
  const setProtocolText = useCallback(
    (id: string, runDefinition: string) => {
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file || file.kind !== "prcltxt") return;
      const next = withContent(
        file,
        plainContent(new TextEncoder().encode(formatRunDefinitionText(runDefinition))),
      );
      // Keep the ref current for a flush that fires before React re-renders (the throttle can
      // write synchronously, on the very first edit to an idle file).
      loadedRef.current = replaceFile(loadedRef.current, next);
      setLoadedFiles((prev) => replaceFile(prev, next));
      patchEntry(id, { size: next.size });
      // The bytes now differ from the copy on disk, which is exactly what the flag is for — an
      // edited protocol deleted before it was downloaded is lost work.
      setModifiedFlag(id, true);
      editThrottle.current!.markDirty(id);
    },
    [setModifiedFlag, patchEntry],
  );

  /** See {@link ZpcrStore.setPlateText}. */
  const setPlateText = useCallback(
    (id: string, plate: PlateDefinition) => {
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file || file.kind !== "platecsv") return;
      const next = withContent(file, plainContent(new TextEncoder().encode(plateToCsv(plate))));
      // Same reasoning as `setProtocolText`, line for line — see the comments there.
      loadedRef.current = replaceFile(loadedRef.current, next);
      setLoadedFiles((prev) => replaceFile(prev, next));
      patchEntry(id, { size: next.size });
      setModifiedFlag(id, true);
      editThrottle.current!.markDirty(id);
    },
    [setModifiedFlag, patchEntry],
  );

  /**
   * Rename a file — the one edit that *moves* a file's records instead of rewriting them, since
   * the name is the key. Everything keyed by the old name moves with it here in memory; the
   * catalog record travels intact inside `db.ts`'s own re-key, so the file keeps its display
   * settings and its modified flag across the rename.
   *
   * **Not available for a disk-backed file** ({@link ZpcrStore.canRename}). A disk-backed file's
   * name *is* its path on the user's disk, so renaming it would have to rename the real file — and
   * the File System Access API has no rename: it would be a copy, then a delete of the original,
   * with a window in between where a failure loses the file. Not worth risking someone's run data
   * for; the app declines instead, and the UI doesn't offer it.
   */
  const renameFile = useCallback(
    async (from: string, rawName: string) => {
      const to = rawName.trim();
      const file = loadedRef.current.find((f) => f.name === from);
      if (!file || !to || to === from) return;
      if (file.source) {
        setError(`${from}: a file in a folder on disk is renamed on disk, not here`);
        return;
      }
      // Flush any pending archive rewrite for the old name first — once the rename lands, the
      // persister's `resolve` can no longer find a file under it and would silently drop the edit.
      await persister.current!.flush(from);
      await editThrottle.current!.flush(from);
      // Renaming onto a name already in use replaces that file, the same way dropping one over it
      // would. Asked of the catalog, not the loaded set: a file the app hasn't managed to read is
      // just as much an occupant of its name.
      for (const old of entriesRef.current.filter((f) => f.name === to)) await forget(old.name);
      // The analysis state is read under the *old* name — it moves to `to` below, but the record
      // being written is this file's, and dropping it here is what used to lose the name of an
      // experiment that had just been named (naming one renames its file — `App.tsx`'s
      // `nameExperiment`).
      await persistFile({ ...file, name: to }, analysisRef.current[from], undefined, markDiskDirty);
      await deleteFile(from);
      setLoadedFiles((prev) => {
        loadedRef.current = prev.map((f) => (f.name === from ? { ...f, name: to } : f));
        return loadedRef.current;
      });
      setEntries((prev) => {
        entriesRef.current = prev.map((e) => (e.name === from ? { ...e, name: to } : e));
        return entriesRef.current;
      });
      setSettingsMap((prev) => {
        const { [from]: current, ...rest } = prev;
        const next = { ...(current ?? defaultSettings()), modified: true };
        // A rename makes the copy on disk stale — it is under the old name — which is what
        // `modified` records; the view half rides along so the record keeps what is on screen.
        void updateFile(to, { modified: true, view: viewOf(next) });
        return { ...rest, [to]: next };
      });
      setAnalysisMap((prev) => {
        const { [from]: moved, ...rest } = prev;
        if (moved === undefined) return prev;
        analysisRef.current = { ...rest, [to]: moved };
        return analysisRef.current;
      });
      if (seeded.current.delete(from)) seeded.current.add(to);
      persister.current!.forget(from);
      editThrottle.current!.forget(from);
      window.clearTimeout(saveTimers.current[from]);
      delete saveTimers.current[from];
      setActiveName((cur) => (cur === from ? to : cur));
    },
    [forget],
  );

  /** See {@link ZpcrStore.beginExperiment}. */
  const beginExperiment = useCallback(
    async (id: string): Promise<{ name: string } | null> => {
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file || file.kind !== "zpcr") return null;
      // Flush any in-flight protocol edit first — the begun marker must land on top of the
      // latest text, not race a still-pending throttled write.
      await editThrottle.current!.flush(id);
      const current = loadedRef.current.find((f) => f.name === id) ?? file;
      // Restamping the date renames the file, and the new name *is* the new key — no second
      // derivation to keep in step with whatever `renameFile` chose. Never for a disk-backed file:
      // its name is its path on the user's disk and it cannot be renamed from here at all
      // (`renameFile`), so it keeps the name the file has and the run updates that same file.
      const restamped = current.source ? null : restampExperimentDate(current.name, new Date());
      const targetName = restamped ?? current.name;
      if (restamped) await renameFile(id, restamped);
      // Pending → in progress: both states are held open (`fileContent.ts`), so writing the
      // marker adds one zero-length entry and re-puts the record, with no ZIP work either side.
      await commitContent(
        withContent(
          { ...current, name: targetName },
          archiveContent(markExperimentBegun(contentFiles(current.content))),
        ),
      );
      setModifiedFlag(targetName, true);
      return { name: targetName };
    },
    [renameFile, setModifiedFlag, commitContent],
  );

  // One flat object per file, assembled from the two stores. The analysis half wins, so a
  // display record written before the split (whose analysis fields `fromStored` now ignores)
  // can't shadow what the file says.
  const settings = useMemo<FileSettings | null>(() => {
    if (!activeName) return null;
    const display = settingsMap[activeName] ?? defaultSettings();
    const analysis = analysisMap[activeName];
    return analysis ? { ...display, ...analysis } : display;
  }, [activeName, settingsMap, analysisMap]);

  const updateSettings = useCallback(
    (patch: Partial<FileSettings>) => {
      if (!activeName) return;
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
          const current = prev[activeName] ?? defaultSettings();
          const next = { ...current, ...displayPatch };
          // One right axis, two candidates for it: filling either set empties the other, here
          // rather than at each call site so no control can leave both on (see `rightAxis.ts`).
          if (displayPatch.temps?.size) next.leds = new Set();
          if (displayPatch.leds?.size) next.temps = new Set();
          // debounced persist. Only the view half: the active file is loaded by definition, and
          // the flags are written straight through by their own setters.
          window.clearTimeout(saveTimers.current[activeName]);
          saveTimers.current[activeName] = window.setTimeout(() => {
            void updateFile(activeName, { view: viewOf(next) });
          }, 300);
          return { ...prev, [activeName]: next };
        });
      }

      if (touchedAnalysis) {
        // An edit counts as seeding: if the user got to a control before the seeding effect ran,
        // their value is the current one and must not be overwritten by the file's.
        seeded.current.add(activeName);
        setAnalysisMap((prev) => {
          const next = { ...(prev[activeName] ?? defaultAnalysisSettings()), ...analysisPatch };
          // Keep the ref current for a flush that fires before React re-renders.
          analysisRef.current = { ...prev, [activeName]: next };
          return analysisRef.current;
        });
        // Rate-limited archive rewrite — see `analysisPersist.ts` — except for a disk-backed file,
        // whose settings reach the same place by a different road: the whole file is written back
        // to disk (`contentToStore` layers `zpcrweb.json` in on the way out), on a much shorter
        // window because a disk write costs a re-zip either way and there is no per-entry delta to
        // protect. Routed here rather than inside the persister so there is one answer to "where do
        // this file's bytes go", and it is `persistFile`'s.
        if (loadedRef.current.find((f) => f.name === activeName)?.source) {
          markDiskDirty(activeName);
        } else {
          persister.current!.markDirty(activeName);
          // The analysis half is precisely what a download writes into the file (`exportBytes`), so
          // an edit to it is what makes the copy on disk stale. Display state — which channels are
          // shown, log vs. linear — never leaves this browser and so never counts.
          //
          // A disk-backed file is the exception, and the reason the flag exists says why: what it
          // warns about is the user's copy going stale, and for that file the app *is* writing the
          // user's copy. There is nothing to lose by closing the tab.
          setModifiedFlag(activeName, true);
        }
      }
    },
    [activeName, setModifiedFlag],
  );

  const runs = useMemo(() => {
    const map = new Map<string, RunResult>();
    for (const f of loadedFiles) {
      if (f.kind === "zpcr" || f.kind === "pcrd" || f.kind === "biomeme") {
        map.set(f.name, parseRunCached(f.content, f.kind, password));
      }
    }
    return map;
  }, [loadedFiles, password]);

  const activeRun = activeName ? runs.get(activeName) ?? null : null;

  const plateFiles = useMemo(() => {
    const map = new Map<string, PlateFileResult>();
    for (const f of loadedFiles) {
      if (f.kind === "pltd" || f.kind === "platecsv") {
        map.set(f.name, parsePlateCached(f.content, f.kind, password, f.name));
      }
    }
    return map;
  }, [loadedFiles, password]);

  const activePlateFile = activeName ? plateFiles.get(activeName) ?? null : null;

  /**
   * Decoded standalone protocol files — `.prcl.txt` and `.prcl` alike, keyed by id, recomputed
   * when the shared password changes so an encrypted `.prcl` unlocks reactively exactly as a
   * `.pltd` does.
   */
  const protocolFiles = useMemo(() => {
    const map = new Map<string, ProtocolFileResult>();
    for (const f of loadedFiles) {
      if (f.kind !== "prcltxt" && f.kind !== "prcl") continue;
      map.set(f.name, parseProtocolBytes(f.kind, fileBytes(f), password, f.name));
    }
    return map;
  }, [loadedFiles, password]);

  const activeProtocolFile = activeName ? protocolFiles.get(activeName) ?? null : null;

  /**
   * Seed each file's analysis settings from its own `zpcrweb.json`, once — after hydration, after
   * an upload, and (for an encrypted `.pcrd`) once a working password finally decodes it. A file
   * that fails to parse stays unseeded rather than being seeded with defaults, so unlocking it
   * later still picks up whatever it carries.
   */
  useEffect(() => {
    const additions: Record<string, AnalysisSettings> = {};
    for (const f of loadedFiles) {
      if (seeded.current.has(f.name)) continue;
      let next: AnalysisSettings;
      if (f.kind === "zpcr" || f.kind === "pcrd" || f.kind === "biomeme") {
        const zpcr = runs.get(f.name)?.zpcr;
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
      seeded.current.add(f.name);
      additions[f.name] = next;
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
      map.set(f.name, experimentIdentity(f, runs.get(f.name), analysisMap[f.name]?.experimentName));
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

  /**
   * The loaded set as the file bar shows it: oldest first, by when the file was added. Ordering by
   * `addedAt` rather than by when it happened to be read in is what keeps the chips in the same
   * places across a reload — hydration reads the selected file first so the app has something to
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

  /**
   * A disk-backed run that has just finished: write it to the user's disk, once, and let go of the
   * buffer it accumulated.
   *
   * While a run is in progress its plate reads go to IndexedDB, one small record each, and the file
   * on disk is left alone — writing a whole archive to disk forty-five times over a two-hour run
   * would be a great deal of churn for a file nobody can use until it is finished. The moment the
   * `ended` marker arrives it stops being in progress, and this writes the finished run out and
   * drops the records, after which the file is read from and written to disk like any other.
   */
  const wasInProgress = useRef(new Set<string>());
  useEffect(() => {
    const finished = [...wasInProgress.current].filter((id) => !inProgressIds.has(id));
    wasInProgress.current = new Set(inProgressIds);
    for (const id of finished) {
      const file = loadedRef.current.find((f) => f.name === id);
      if (!file?.source) continue;
      void (async () => {
        diskThrottle.current!.markDirty(id);
        await diskThrottle.current!.flush(id);
        // A failed write leaves the entry dirty (`writeThrottle.ts` re-arms on throw). Dropping the
        // buffer then would destroy the only copy of a run that never reached disk — a permission
        // lapse mid-run, a full volume — so the records stay until a write actually lands.
        if (diskThrottle.current!.isDirty(id)) return;
        await deleteContent(id);
        // The bytes on disk are now the run, so the copy the user has is not stale.
        setModifiedFlag(id, false);
      })();
    }
  }, [inProgressIds, setModifiedFlag]);

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
      const zpcr = runs.get(f.name)?.zpcr;
      if (zpcr && isPendingExperiment(f.kind, zpcr)) ids.add(f.name);
    }
    return ids;
  }, [loadedFiles, runs]);

  const exportBytes = useCallback(
    (id: string): Uint8Array | null => {
      const file = loadedFiles.find((f) => f.name === id);
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
    loadingIds,
    unreadableIds,
    activeName,
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
    setRunPlateText,
    setRunProtocolName,
    beginExperiment,
    renameFile,
    setProtocolText,
    setPlateText,
    settings,
    view,
    setView,
    loading,
    error,
    clearError,
    addFiles,
    addRunArchive,
    addDiskFiles,
    refreshDiskFile,
    canRename,
    addUrl,
    setActive,
    closeFile,
    retryUnread,
    updateSettings,
    exportBytes,
  };
}
