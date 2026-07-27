import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachPlateToZpcr,
  dyeChannelLookup,
  parsePcrd,
  parsePlateCsv,
  parsePltd,
  parseZpcr,
  parseZpcrwebSettings,
  writeZpcrwebSettings,
  type NormalizationMode,
  type PcrdContainer,
  type PlateDefinition,
  type PltdContainer,
  type Zpcr,
} from "@zpcrweb/core";
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
import { usePltdPassword } from "./pltdPassword";
import { onHashChange, readHash, writeHash } from "./urlHash";

export { DEFAULT_THRESHOLD_MULTIPLIER } from "./analysisSettings";
export type { AnalysisSettings } from "./analysisSettings";

export type FileKind = "zpcr" | "pcrd" | "pltd" | "csv";
/** The two kinds a plate — standalone or attached to a run — can be uploaded as. */
export type PlateFileKind = "pltd" | "csv";

export type ViewId = "overview" | "curves" | "plates" | "reference" | "raw";
/** Reference view only — drift relative to the factory calibration value; see `ReferenceView`. */
export type Baseline = "raw" | "delta" | "percent";
/**
 * Curves view only — what the chart plots each curve as. Baselining itself is never
 * configurable: it's always an auto-detected linear baseline (`threshold.md` §4's
 * `LinearBaseLineNormalized`, region from `autoBaselineRegion`) — `"relative"` plots the
 * baseline-corrected curve, `"absolute"` plots the raw curve unmodified. Cq/analysis always use
 * the baseline-corrected values regardless of which is shown.
 */
export type CurveView = "relative" | "absolute";
export type Scale = "linear" | "log";
/**
 * What the Curves view's main pane shows once color separation is on: dye-space curves grouped
 * by fluorophore or by target/gene, or — `"table"` — the run's Cq/ΔRFU table in place of the
 * chart (the former standalone Analysis view). Table mode groups by target, like `"target"`.
 */
export type FluorViewMode = "fluorophore" | "target" | "table";

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
  /** Draw each channel's min/max envelope band. Channel-space only, like {@link showDark}, and
   * off by default — with more than a well or two selected the envelopes overlap into noise. */
  bands: boolean;
  /** Selected protocol step (`STEP` value), or null to use the first step. */
  step: number | null;
  /**
   * Temperature field keys (e.g. `BLOCKTEMP`) plotted on the chart's right axis. Empty
   * hides the temperature axis entirely.
   */
  temps: Set<string>;
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
}

/** The outcome of parsing one {@link LoadedFile} against the current password. */
export interface RunResult {
  /** The decoded run, once available (immediately for `.zpcr`; after a correct password for
   * `.pcrd`). */
  zpcr: Zpcr | null;
  /** True when this is an encrypted `.pcrd` and no (or the wrong) password has been tried yet
   * — distinct from `error`, which means a password was tried and failed. */
  needsPassword: boolean;
  error: string | null;
  /** `.pcrd` container metadata, available even before/without a working password. */
  container?: PcrdContainer;
  /** A `.pcrd`'s full raw decrypted document — there's no inner-file archive to browse (see
   * `Zpcr.archive`'s doc comment), so the app's `.pcrd` raw view renders this directly as a
   * real XML tree. Undefined for `.zpcr` (and for a `.pcrd` before/without a working password). */
  documentXml?: string;
}

function parseRun(bytes: Uint8Array, kind: "zpcr" | "pcrd", password: string): RunResult {
  if (kind === "zpcr") {
    try {
      return { zpcr: parseZpcr(bytes), needsPassword: false, error: null };
    } catch (e) {
      return { zpcr: null, needsPassword: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const pcrd = parsePcrd(bytes, password ? { password } : undefined);
  return {
    zpcr: pcrd.zpcr ?? null,
    needsPassword: !!pcrd.needsPassword,
    error: pcrd.error ?? null,
    container: pcrd.container,
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
  channelForFluor?: (fluor: string) => number | undefined,
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
    // The file name is the plate's identity — a `.plt.csv` carries no identityKey of its own —
    // and its fluor columns are dye names with no channel, resolved via `channelForFluor`
    // (see `plateCsv.ts`). Standing on its own, a plate CSV has no calibration of its own to
    // consult, so the lookup comes from whatever runs are loaded alongside it.
    return {
      plate: parsePlateCsv(new TextDecoder().decode(bytes), { sourceName: name, channelForFluor }),
      needsPassword: false,
      error: null,
    };
  } catch (e) {
    return { plate: null, needsPassword: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function wellKey(row: number, col: number): string {
  return `${row},${col}`;
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
    // Relative (baseline-corrected) is threshold.md §8's recommended default.
    curveView: "relative",
    drawBaseline: false,
    scale: "linear",
    showDark: false,
    bands: false,
    step: null,
    // Temperatures are off by default — they are instrument context, not the measurement.
    temps: new Set<string>(),
    // Auto: on once plate + calibration data are available (see CurvesView).
    calibration: null,
    fluorViewMode: "target",
    disabledFluors: new Set<string>(),
    disabledSamples: new Set<string>(),
    showUnloadedFluors: false,
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
    bands: s.bands,
    step: s.step ?? null,
    temps: [...s.temps],
    calibration: s.calibration,
    fluorViewMode: s.fluorViewMode,
    disabledFluors: [...s.disabledFluors],
    disabledSamples: [...s.disabledSamples],
    showUnloadedFluors: s.showUnloadedFluors,
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
  // Records predating `subtractDark` carry the retired three-way calibrationBackground
  // ("none"/"dark"/"plate"); only "dark" maps to the surviving stage.
  if (s.subtractDark !== undefined) out.subtractDark = s.subtractDark;
  else if (s.calibrationBackground !== undefined) out.subtractDark = s.calibrationBackground === "dark";
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
    temps: new Set(s.temps ?? []),
    // Analysis fields are *not* read from the record here — they come from the file, and are
    // merged in by the store (see `legacyAnalysisFromStored` for the one migration exception).
    ...defaultAnalysisSettings(),
  };
}

/** True for file names this app knows how to load. */
function fileKind(name: string): FileKind | null {
  if (/\.zpcr$/i.test(name)) return "zpcr";
  if (/\.pcrd$/i.test(name)) return "pcrd";
  if (/\.pltd$/i.test(name)) return "pltd";
  if (/\.csv$/i.test(name)) return "csv";
  return null;
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
  activePlateFile: PlateFileResult | null;
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
  addFiles: (files: FileList | File[]) => Promise<void>;
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

  const addFiles = useCallback(
    async (input: FileList | File[]) => {
      const list = Array.from(input)
        .map((file) => ({ file, kind: fileKind(file.name) }))
        .filter((f): f is { file: File; kind: FileKind } => f.kind !== null);
      let lastId: string | null = null;
      for (const { file, kind } of list) {
        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          // Validate the container eagerly so obviously-bad files are rejected up front; a
          // .pcrd/.pltd's payload may still need a password, resolved reactively via `runs`/
          // `plateFiles`.
          if (kind === "zpcr") parseZpcr(bytes);
          else if (kind === "pcrd") parsePcrd(bytes);
          else if (kind === "pltd") parsePltd(bytes);
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
          await putFile({ id, name: file.name, size: file.size, addedAt, bytes: buf, kind });
          lastId = id;
          setFiles((prev) => {
            const rest = prev.filter((f) => f.id !== id && !supersededIds.has(f.id));
            return [...rest, { id, name: file.name, size: file.size, addedAt, kind, bytes }];
          });
        } catch (e) {
          setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (lastId) setActiveId(lastId);
    },
    [forget],
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
        if (!fileKind(name)) throw new Error("not a .zpcr, .pcrd, .pltd or .csv file");
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
  const setActive = useCallback((id: string) => {
    void persister.current!.flushAll();
    setActiveId(id);
  }, []);

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
        });
        setFiles((prev) =>
          prev.map((f) =>
            f.id === target.id ? { ...f, size: augmented.byteLength, bytes: augmented } : f,
          ),
        );
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [files],
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
      }
    },
    [activeId],
  );

  const runs = useMemo(() => {
    const map = new Map<string, RunResult>();
    for (const f of files) {
      if (f.kind === "zpcr" || f.kind === "pcrd") map.set(f.id, parseRun(f.bytes, f.kind, password));
    }
    return map;
  }, [files, password]);

  const activeRun = activeId ? runs.get(activeId) ?? null : null;

  /**
   * Dye → optical channel for standalone plate CSVs, pooled from every loaded run's `.Dcal`
   * set. A plate CSV opened on its own carries no calibration, but which channel a dye is read
   * on is a property of the instrument's optics, not of the plate — so any run in the session
   * answers it, and runs from the same instrument agree. With no run loaded there's nothing to
   * consult and channels fall back to column position.
   *
   * Only built when a plate CSV is actually loaded: `calibrations()` decodes every `.Dcal` in
   * an archive (typically 28), which isn't free.
   */
  const plateCsvChannels = useMemo(() => {
    if (!files.some((f) => f.kind === "csv")) return undefined;
    const dcals = [...runs.values()].flatMap((r) => r.zpcr?.calibrations() ?? []).map((e) => e.dcal);
    return dcals.length ? dyeChannelLookup(dcals) : undefined;
  }, [files, runs]);

  const plateFiles = useMemo(() => {
    const map = new Map<string, PlateFileResult>();
    for (const f of files) {
      if (f.kind === "pltd" || f.kind === "csv") {
        map.set(f.id, parsePlateBytes(f.kind, f.bytes, password, f.name, plateCsvChannels));
      }
    }
    return map;
  }, [files, password, plateCsvChannels]);

  const activePlateFile = activeId ? plateFiles.get(activeId) ?? null : null;

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
      if (f.kind === "zpcr" || f.kind === "pcrd") {
        const zpcr = runs.get(f.id)?.zpcr;
        if (!zpcr) continue; // not decoded yet (needs a password, or failed) — try again later
        const fromFile = parseZpcrwebSettings(zpcr);
        next = analysisFromZpcrweb(fromFile);
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
    activePlateFile,
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
