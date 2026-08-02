import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachPlateToZpcr,
  isBiomemeJson,
  parseBiomeme,
  parsePcrd,
  parsePlateCsv,
  parsePltd,
  parseRunDefinitionText,
  parseZpcr,
  parseZpcrwebSettings,
  runProgressFromNames,
  wellKey,
  writeZpcrwebSettings,
  type AnalysisSource,
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
  getAllFiles,
  getAllSettings,
  hasLegacyAnalysisFields,
  putFile,
  putSettings,
  type StoredSettings,
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
import { experimentIdentity, type ExperimentIdentity } from "../lib/experiment";
import { usePltdPassword } from "./pltdPassword";
import { onHashChange, readHash, writeHash } from "./urlHash";

export { DEFAULT_THRESHOLD_MULTIPLIER } from "./analysisSettings";

/** The accepted encodings, and their grouping into runs/plates/protocols, are the library's
 * (`core/fileKind.ts`) — re-exported here because the store's `LoadedFile` is where the app meets
 * them. */
export type { FileKind };
/** The two kinds a plate — standalone or attached to a run — can be uploaded as. */
type PlateFileKind = "pltd" | "csv";

/** `"about"` is not a tab in {@link ViewSelector} — it's reached by clicking the logo — but it
 * is a view like any other, so it's linkable (`#view=about`) and works with back/forward. */
export type ViewId =
  | "overview"
  | "curves"
  | "plates"
  | "reference"
  | "calibration"
  | "raw"
  | "instrument"
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
   * view setting at all, and no view reads it. It lives here because this is the per-file record
   * that is persisted and keyed by id, and it must survive a reload for the same reason it exists
   * — the stale copy is the one on the user's disk. Surfaced to the UI as
   * {@link ZpcrStore.modifiedIds}, which is what makes the file chip's delete ask twice.
   */
  modified: boolean;
  /**
   * Whether this file shows on the file bar's summary row. Checking it off in the full files
   * table (see `FilesTableView.tsx`) hides the chip without touching the file itself — it stays
   * loaded, in IndexedDB, and in that table, exactly like `modified` only gates the delete
   * confirm rather than the file's existence. Selecting a file anywhere (the table, a `#file=`
   * link) turns this back on, since a file you're looking at can hardly not be in the bar.
   */
  visible: boolean;
}

/** A file loaded into memory — bytes only. Parsing is derived (see {@link ZpcrStore.runs}),
 * since a `.pcrd`'s decode depends on the (mutable, shared) decryption password. */
export interface LoadedFile {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  kind: FileKind;
  bytes: Uint8Array;
  /** The source `File`'s own `lastModified` (its OS mtime, epoch ms) — see
   * `db.ts`'s `StoredFile.lastModified`. */
  lastModified: number;
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
function parseRun(bytes: Uint8Array, kind: "zpcr" | "pcrd" | "biomeme", password: string): RunResult {
  if (kind === "zpcr" || kind === "biomeme") {
    try {
      const zpcr = kind === "zpcr" ? parseZpcr(bytes) : parseBiomeme(bytes);
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
  const pcrd = parsePcrd(bytes, password ? { password } : undefined);
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
    // Every file starts on the bar — hiding is something you do to a file, not a state it loads
    // into.
    visible: true,
    ...defaultAnalysisSettings(),
  };
}

/** Display state only — the analysis fields are pointedly not written, which is also what
 * strips them from a pre-split record the first time anything else is saved. */
function toStored(id: string, s: FileSettings): StoredSettings {
  return {
    fileId: id,
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
    modified: s.modified,
    visible: s.visible,
  };
}

/**
 * The analysis settings a pre-split record still carries, for the one-time migration into the
 * file. Returns `null` for a record with none — the ordinary case from here on.
 *
 * Only consulted when the file itself has no `zpcrweb.json`: the file is authoritative, and a
 * stale IndexedDB record must never be able to override the thresholds a run was actually saved
 * with. What it recovers is the pre-split user's work, which would otherwise silently revert to
 * automatic thresholds on first load after upgrading.
 */
function legacyAnalysisFromStored(s: StoredSettings): Partial<AnalysisSettings> | null {
  if (!hasLegacyAnalysisFields(s)) return null;
  const out: Partial<AnalysisSettings> = {};
  const overrides = s.thresholdOverrides ?? s.analysisThresholdOverrides;
  if (overrides) out.thresholdOverrides = new Map(overrides);
  if (s.curveThresholdOverrides) out.curveThresholdOverrides = new Map(s.curveThresholdOverrides);
  if (s.thresholdMultiplier !== undefined) out.thresholdMultiplier = s.thresholdMultiplier;
  // `subtractDark` (and the older three-way `calibrationBackground` it replaced) are deliberately
  // dropped rather than migrated: the dark-current stage is gone, measured to make results worse
  // (`calibration.md` §4.2a). Old records still parse; the field is simply ignored.
  if (s.calibrationNormalization !== undefined) {
    out.calibrationNormalization = s.calibrationNormalization;
  }
  return out;
}

function fromStored(s: StoredSettings): FileSettings {
  return {
    enabledChannels: new Set(s.enabledChannels),
    enabledWells: new Set(s.enabledWells),
    enabledRefCols: new Set(s.enabledRefCols ?? Array.from({ length: 12 }, (_, c) => c)),
    baseline: s.baseline ?? "raw",
    // Old records may carry the retired three-way curveBaseline setting ("raw"/"constant"/
    // "linear"): "raw" maps to the new absolute view, anything else to relative — constant
    // baselining itself is gone (see baseline.ts's `LinearBaseLineNormalized`-only pipeline).
    curveView: s.curveView ?? (s.curveBaseline === "raw" ? "absolute" : "relative"),
    drawBaseline: s.drawBaseline ?? false,
    scale: s.scale ?? "linear",
    showDark: s.showDark ?? false,
    // Absent from records written before the toggle existed, when the line was always drawn.
    showFactory: s.showFactory ?? true,
    refXAxis: s.refXAxis === "column" ? "column" : "cycle",
    // Records written while `bands` was a three-way mode ("off"/"auto"/"on") migrate to the
    // boolean switch: only an explicit "on" survives as on. "auto" (draw the bands only when a
    // single well is selected) is gone — a switch can't express it, and it made the control's
    // effect depend on the well selection.
    bands: typeof s.bands === "boolean" ? s.bands : s.bands === "on",
    step: s.step ?? null,
    calibration: s.calibration ?? null,
    fluorViewMode: s.fluorViewMode ?? "fluorophore",
    disabledFluors: new Set(s.disabledFluors ?? []),
    disabledSamples: new Set(s.disabledSamples ?? []),
    showUnloadedFluors: s.showUnloadedFluors ?? false,
    cqMin: s.cqMin ?? null,
    cqMax: s.cqMax ?? null,
    // Absent on a record written before the Calibration view existed; empty simply means the
    // view will seed it from the run the first time it's opened.
    calFiles: new Set(s.calFiles ?? []),
    calView: s.calView ?? "relative",
    // Absent from records written before this format existed; "file" is the default either way.
    baselineSource: s.baselineSource ?? "file",
    cqSource: s.cqSource ?? "file",
    // Absent on a record written before the flag existed: such a file may well carry edits, but
    // "not modified" is the honest default — a wrong `true` would make every old file ask twice
    // forever, since only a download clears it.
    modified: s.modified ?? false,
    // Absent on a record written before the field existed: such a file was already on the bar,
    // so "shown" is the correct default rather than a wrong `false` hiding it on upgrade.
    visible: s.visible ?? true,
    temps: new Set(s.temps ?? []),
    // A record written before the LED series existed has no `leds`; both being non-empty is
    // impossible by construction (see `updateSettings`), so nothing needs reconciling here.
    leds: new Set(s.leds ?? []),
    // Analysis fields are *not* read from the record here — they come from the file, and are
    // merged in by the store (see `legacyAnalysisFromStored` for the one migration exception).
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
  files: LoadedFile[];
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
   * counting as modified. Called by the Overview view's download button — the one that writes the
   * *whole* file including its `zpcrweb.json` ({@link ZpcrStore.exportBytes}), and so the only
   * download that actually gets the edits out of the browser.
   */
  markDownloaded: (fileId: string) => void;
  /**
   * Ids of files hidden from the file bar's summary row (see {@link FileSettings.visible}) — the
   * full files table's checkbox column reads this as "unchecked". A file's absence here, not its
   * presence, is the common case, since it mirrors {@link modifiedIds} in shape but is inverted
   * in meaning: most files are visible, most files are not modified.
   */
  hiddenIds: Set<string>;
  /**
   * Show or hide a file on the file bar without touching it otherwise — what the full files
   * table's checkbox column and a chip's ✕ (which only ever hides, never deletes) both call. See
   * {@link FileSettings.visible}.
   */
  setVisible: (fileId: string, visible: boolean) => void;
  /**
   * Attach (or replace) a `.zpcr` run's plate: rewrites the run's own archive bytes in place
   * (adding/replacing a `.pltd`/`.plt.csv` entry — see `attachPlateToZpcr`) and persists the
   * result, so the plate travels with the file from then on and `zpcr.plates()` picks it up
   * with no separate override state. Only valid for a `kind === "zpcr"` run; sets `error`
   * otherwise (a `.pcrd` has no real archive to attach an entry to).
   */
  attachPlate: (fileId: string, file: File) => Promise<void>;
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
   * Ids of the loaded runs that are still running on an instrument — `begun` present, `ended`
   * absent among the archive's own entries (see core's `runProgressFromNames`).
   *
   * Derived on every render from the parsed runs, and deliberately not state: the fact lives in
   * the file, arrives with it, and survives a reload. Nothing here has to be told when a run
   * finishes — the next snapshot the run watcher pulls simply contains `ended`.
   */
  inProgressIds: Set<string>;
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
  const [files, setFiles] = useState<LoadedFile[]>([]);
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
  /** Pre-split IndexedDB analysis state, awaiting a file with no `zpcrweb.json` to migrate into.
   * Populated once at hydration and consumed by the seeding effect below. */
  const legacyAnalysis = useRef<Record<string, Partial<AnalysisSettings>>>({});
  // Refs, not state, so the persister's `resolve` always sees current values without the
  // persister having to be rebuilt (and its pending timers reset) on every keystroke.
  const filesRef = useRef<LoadedFile[]>(files);
  filesRef.current = files;
  const analysisRef = useRef(analysisMap);
  analysisRef.current = analysisMap;

  const persister = useRef<AnalysisPersister>();
  if (!persister.current) {
    persister.current = new AnalysisPersister({
      resolve: (id) => {
        const file = filesRef.current.find((f) => f.id === id);
        // Only a `.zpcr` has an archive to put an entry in. A `.pcrd` is a single encrypted XML
        // document whose own `dataAnalysisParameters` we don't yet write (see `pcrd.md` §2.5),
        // and a standalone plate file has no analysis at all — for those, edits are live for
        // the session and then gone, which is the honest behavior while the file can't hold them.
        if (!file || file.kind !== "zpcr") return null;
        const settings = analysisRef.current[id];
        if (!settings) return null;
        return {
          file: {
            id: file.id,
            name: file.name,
            size: file.size,
            addedAt: file.addedAt,
            kind: file.kind,
            bytes: file.bytes.slice().buffer,
          },
          settings,
        };
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }
  useEffect(() => persister.current!.attach(), []);

  // Hydrate from IndexedDB on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [stored, storedSettings] = await Promise.all([getAllFiles(), getAllSettings()]);
        if (cancelled) return;
        const loaded: LoadedFile[] = stored.map((f) => ({
          id: f.id,
          name: f.name,
          size: f.size,
          addedAt: f.addedAt,
          kind: f.kind ?? "zpcr",
          bytes: new Uint8Array(f.bytes),
          // Records written before this field existed have no source mtime to recover; the load
          // time is the closest honest stand-in.
          lastModified: f.lastModified ?? f.addedAt,
        }));
        loaded.sort((a, b) => a.addedAt - b.addedAt);
        const map: Record<string, FileSettings> = {};
        for (const s of storedSettings) {
          map[s.fileId] = fromStored(s);
          // One-time migration of pre-split records: stash the analysis half for the seeding
          // effect, and immediately rewrite the record without it — `toStored` no longer emits
          // those fields, so this both strips them and makes the migration idempotent.
          const legacy = legacyAnalysisFromStored(s);
          if (legacy) {
            legacyAnalysis.current[s.fileId] = legacy;
            void putSettings(toStored(s.fileId, map[s.fileId]!));
          }
        }
        setFiles(loaded);
        setSettingsMap(map);
        // A `#file=` from the URL wins over "most recently added", when it names something
        // actually loaded here — files live in this browser's IndexedDB, so a link naming a
        // file the recipient doesn't have falls back to the default rather than erroring.
        const wanted = readHash().file;
        const fromHash = wanted ? loaded.find((f) => f.name === wanted) : undefined;
        setActiveId(fromHash?.id ?? loaded.at(-1)?.id ?? null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── URL hash sync ────────────────────────────────────────────────────────────────────
  // Both directions are guarded by "is it already that value?" checks (here and in
  // `writeHash`), so the echo each direction provokes in the other terminates immediately
  // instead of looping.
  const active = useMemo(() => files.find((f) => f.id === activeId) ?? null, [files, activeId]);
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
        const match = files.find((f) => f.name === h.file);
        if (match) setActiveId(match.id);
      }
    });
  }, [files]);

  /** Drop everything keyed by a file id except the `files` list itself — the cleanup
   * {@link remove} and the same-name replacement in {@link addFiles} both need. */
  const forget = useCallback(async (id: string) => {
    await deleteFile(id);
    setSettingsMap((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    // Drop any pending settings write for a file that no longer exists, and let it re-seed
    // from its own bytes if it's ever loaded again.
    persister.current!.forget(id);
    seeded.current.delete(id);
    setAnalysisMap((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
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
      void putSettings(toStored(id, next));
      return { ...prev, [id]: next };
    });
  }, []);

  const markDownloaded = useCallback(
    (id: string) => setModifiedFlag(id, false),
    [setModifiedFlag],
  );

  /**
   * Flip a file's file-bar visibility (see {@link FileSettings.visible}). Written straight
   * through like {@link setModifiedFlag}, for the same reason: it's a discrete, deliberate click
   * (a chip's ✕, the table's checkbox), not a value worth debouncing.
   */
  const setVisible = useCallback((id: string, value: boolean) => {
    setSettingsMap((prev) => {
      const current = prev[id] ?? defaultSettings();
      if (current.visible === value) return prev;
      const next = { ...current, visible: value };
      window.clearTimeout(saveTimers.current[id]);
      void putSettings(toStored(id, next));
      return { ...prev, [id]: next };
    });
  }, []);

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
          if (kind === "zpcr") parseZpcr(bytes);
          else if (kind === "pcrd") parsePcrd(bytes);
          else if (kind === "biomeme") parseBiomeme(bytes);
          else if (kind === "pltd") parsePltd(bytes);
          // Already validated by `fileKind`'s content sniff — parsing again would only repeat it.
          else if (kind === "prcl") void 0;
          else parsePlateCsv(new TextDecoder().decode(bytes));
          const id = fileId(file.name, file.size);
          // Re-loading a name that's already here replaces it. Ids hash name+size, so an edited
          // file (attached plate, saved thresholds, a re-export) gets a *different* id under the
          // same name — without this it would sit alongside the stale copy as an
          // indistinguishable second chip, and `#file=` would have two candidates to mean.
          const superseded = filesRef.current.filter((f) => f.name === file.name && f.id !== id);
          for (const old of superseded) await forget(old.id);
          const supersededIds = new Set(superseded.map((f) => f.id));
          const addedAt = Date.now();
          const lastModified = file.lastModified;
          await putFile({ id, name: file.name, size: file.size, addedAt, bytes: buf, kind, lastModified });
          lastId = id;
          lastKind = kind;
          setFiles((prev) => {
            const rest = prev.filter((f) => f.id !== id && !supersededIds.has(f.id));
            return [...rest, { id, name: file.name, size: file.size, addedAt, kind, bytes, lastModified }];
          });
          if (options?.modified) setModifiedFlag(id, true);
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
    [forget, setModifiedFlag],
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
      await forget(id);
      setFiles((prev) => {
        const next = prev.filter((f) => f.id !== id);
        setActiveId((cur) => (cur === id ? next.at(-1)?.id ?? null : cur));
        return next;
      });
    },
    [forget],
  );

  // Switching files flushes anything pending: the window of unsaved analysis edits then only
  // ever covers the file you're actually looking at.
  //
  // Also turns the file back on in the bar (see `FileSettings.visible`) — selecting a file and
  // then not seeing its chip would be a bug, not a feature, and this is the one place every path
  // to "make this the active file" already goes through: a chip click (a no-op, since a hidden
  // chip isn't there to click), the full files table's row click, and a `#file=` link landing on
  // something hidden.
  const setActive = useCallback(
    (id: string) => {
      void persister.current!.flushAll();
      setActiveId(id);
      setVisible(id, true);
    },
    [setVisible],
  );

  const attachPlate = useCallback(
    async (targetFileId: string, file: File) => {
      const kind = plateFileKind(file.name);
      if (!kind) {
        setError(`${file.name}: not a .pltd or .csv file`);
        return;
      }
      const target = files.find((f) => f.id === targetFileId);
      if (!target) return;
      if (target.kind !== "zpcr") {
        setError(`${target.name}: attaching a plate is only supported for .zpcr files`);
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        const plateBytes = new Uint8Array(buf);
        // .csv has no password step, so validate eagerly; a .pltd's container is validated by
        // attachPlateToZpcr re-zipping it, and its plate resolved reactively via `runs`.
        if (kind === "csv") parsePlateCsv(new TextDecoder().decode(plateBytes));
        const augmented = attachPlateToZpcr(target.bytes, { name: file.name, bytes: plateBytes });
        await putFile({
          id: target.id,
          name: target.name,
          size: augmented.byteLength,
          addedAt: target.addedAt,
          bytes: augmented.slice().buffer,
          kind: target.kind,
          // Kept as the original file's own mtime, not bumped to now — this is the app editing
          // the archive in place, not a new file arriving from the OS (see `StoredFile.lastModified`).
          lastModified: target.lastModified,
        });
        setFiles((prev) =>
          prev.map((f) =>
            f.id === target.id ? { ...f, size: augmented.byteLength, bytes: augmented } : f,
          ),
        );
        // The archive itself now differs from the one on disk, which is exactly what the flag is
        // for — a plate attached and then deleted is as much lost work as a threshold is.
        setModifiedFlag(target.id, true);
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [files, setModifiedFlag],
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
          // debounced persist
          window.clearTimeout(saveTimers.current[activeId]);
          saveTimers.current[activeId] = window.setTimeout(() => {
            void putSettings(toStored(activeId, next));
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
    for (const f of files) {
      if (f.kind === "zpcr" || f.kind === "pcrd" || f.kind === "biomeme") {
        map.set(f.id, parseRun(f.bytes, f.kind, password));
      }
    }
    return map;
  }, [files, password]);

  const activeRun = activeId ? runs.get(activeId) ?? null : null;

  const plateFiles = useMemo(() => {
    const map = new Map<string, PlateFileResult>();
    for (const f of files) {
      if (f.kind === "pltd" || f.kind === "csv") {
        map.set(f.id, parsePlateBytes(f.kind, f.bytes, password, f.name));
      }
    }
    return map;
  }, [files, password]);

  const activePlateFile = activeId ? plateFiles.get(activeId) ?? null : null;

  /**
   * Decoded `.prcl.txt` entries. Unlike a run or a plate file this needs no password and cannot
   * fail here — `fileKind` only admits bytes that already parsed — so the value is the canonical
   * one-line run definition itself rather than a result wrapper.
   */
  const protocolFiles = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of files) {
      if (f.kind !== "prcl") continue;
      try {
        map.set(f.id, parseRunDefinitionText(new TextDecoder().decode(f.bytes)));
      } catch {
        /* admitted only if it parsed; a failure here means the bytes changed underneath us */
      }
    }
    return map;
  }, [files]);

  const activeProtocolFile = activeId ? protocolFiles.get(activeId) ?? null : null;

  /**
   * Seed each file's analysis settings from its own `zpcrweb.json`, once — after hydration, after
   * an upload, and (for an encrypted `.pcrd`) once a working password finally decodes it. A file
   * that fails to parse stays unseeded rather than being seeded with defaults, so unlocking it
   * later still picks up whatever it carries.
   */
  useEffect(() => {
    const additions: Record<string, AnalysisSettings> = {};
    for (const f of files) {
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
        const legacy = legacyAnalysis.current[f.id];
        // The file is authoritative; pre-split IndexedDB state only fills a file that has
        // nothing to say, and is then written into it so the migration happens exactly once.
        if (!fromFile && legacy) {
          next = { ...next, ...legacy };
          persister.current!.markDirty(f.id);
        }
        delete legacyAnalysis.current[f.id];
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
  }, [files, runs]);

  /** One identity per file — see the interface's own comment for why it lives here. */
  const experiments = useMemo(() => {
    const map = new Map<string, ExperimentIdentity>();
    for (const f of files) {
      map.set(f.id, experimentIdentity(f, runs.get(f.id), analysisMap[f.id]?.experimentName));
    }
    return map;
  }, [files, runs, analysisMap]);

  /** The flag from every file's record, as the set the file bar wants — see
   * {@link ZpcrStore.modifiedIds}. */
  const modifiedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, s] of Object.entries(settingsMap)) if (s.modified) ids.add(id);
    return ids;
  }, [settingsMap]);

  /** See {@link ZpcrStore.hiddenIds}. */
  const hiddenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, s] of Object.entries(settingsMap)) if (!s.visible) ids.add(id);
    return ids;
  }, [settingsMap]);

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

  const exportBytes = useCallback(
    (id: string): Uint8Array | null => {
      const file = files.find((f) => f.id === id);
      if (!file) return null;
      const analysis = analysisMap[id];
      if (file.kind !== "zpcr" || !analysis) return file.bytes;
      try {
        return writeZpcrwebSettings(file.bytes, zpcrwebFromAnalysis(analysis));
      } catch {
        // A file we somehow can't re-zip still downloads as what was loaded.
        return file.bytes;
      }
    },
    [files, analysisMap],
  );

  return {
    files,
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
    hiddenIds,
    setVisible,
    inProgressIds,
    markDownloaded,
    attachPlate,
    settings,
    view,
    setView,
    loading,
    error,
    addFiles,
    addUrl,
    setActive,
    remove,
    updateSettings,
    exportBytes,
  };
}
