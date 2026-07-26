import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachPlateToZpcr,
  parsePcrd,
  parsePlateCsv,
  parsePltd,
  parseZpcr,
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
  putFile,
  putSettings,
  type StoredSettings,
} from "./db";
import { usePltdPassword } from "./pltdPassword";
import { onHashChange, readHash, writeHash } from "./urlHash";

/** The library's default for §5.1's auto-threshold multiplier, and the slider's starting point.
 * Must track `AutoThresholdOptions.multiplier`'s own default in `@zpcrweb/core`, which documents
 * where the figure comes from (and why it sits below what the CFX anchors imply). */
export const DEFAULT_THRESHOLD_MULTIPLIER = 20;

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
/** Min/max envelope bands: always off, always on, or auto (only when one well selected). */
export type BandsMode = "off" | "auto" | "on";
/**
 * What the Curves view's main pane shows once color separation is on: dye-space curves grouped
 * by fluorophore or by target/gene, or — `"table"` — the run's Cq/ΔRFU table in place of the
 * chart (the former standalone Analysis view). Table mode groups by target, like `"target"`.
 */
export type FluorViewMode = "fluorophore" | "target" | "table";

/** Per-file view settings, in-memory form (Sets for cheap toggling). */
export interface FileSettings {
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
  /** Min/max envelope bands mode. */
  bands: BandsMode;
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
  /**
   * Calibration matrix column normalization; see `calibration.md` §3. Deliberately **not**
   * exposed in the UI: §5.1 divides the scaling back out, so all three modes report identical
   * RFU for any full-column-rank matrix — it only changes conditioning, which matters solely
   * for a rank-deficient one (more dyes than scanned channels). Kept as a setting so that case
   * stays reachable, and so stored records keep round-tripping.
   */
  calibrationNormalization: NormalizationMode;
  /**
   * Whether the plate read's LED-off `DARKDATA` is subtracted from a reading before the solve —
   * the optional dark-current stage of `calibration.md` §4.2. Off by default.
   */
  subtractDark: boolean;
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
  /** Manual per-target threshold override (RFU), keyed by threshold group (target, or
   * fluorophore on a plate with no targets). A group with no entry uses the auto threshold
   * (`threshold.md` §5.1: 40 × median baseline noise across that group's wells). Edited in the
   * Curves rail's "Threshold overrides" section; applies to the chart's Cq markers, the hover
   * cards and the table alike, since all three read the run's one Cq table. */
  thresholdOverrides: Map<string, number>;
  /** §5.1's auto-threshold multiplier: `threshold = k × median baseline noise` across the group's
   * wells, for every group with no entry in {@link thresholdOverrides}. The scale comes from the
   * thresholds CFX itself persisted in a `.pcrd` (see `AutoThresholdOptions.multiplier`), but those
   * are two anchors from one run and the default sits deliberately below them — and it is the
   * single knob that most affects where every Cq lands, so the Curves rail exposes it as a slider
   * rather than burying it. */
  thresholdMultiplier: number;
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

function parsePlateBytes(kind: PlateFileKind, bytes: Uint8Array, password: string): PlateFileResult {
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
    return { plate: parsePlateCsv(new TextDecoder().decode(bytes)), needsPassword: false, error: null };
  } catch (e) {
    return { plate: null, needsPassword: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function wellKey(row: number, col: number): string {
  return `${row},${col}`;
}

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
    bands: "auto",
    step: null,
    // Temperatures are off by default — they are instrument context, not the measurement.
    temps: new Set<string>(),
    // Auto: on once plate + calibration data are available (see CurvesView).
    calibration: null,
    fluorViewMode: "target",
    calibrationNormalization: "global",
    // The dark-current stage is optional and off by default, which is what matches the reported
    // RFU scale of the reference run in `calibration.md` §8. See §4.2.
    subtractDark: false,
    disabledFluors: new Set<string>(),
    disabledSamples: new Set<string>(),
    showUnloadedFluors: false,
    thresholdOverrides: new Map<string, number>(),
    thresholdMultiplier: DEFAULT_THRESHOLD_MULTIPLIER,
  };
}

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
    calibrationNormalization: s.calibrationNormalization,
    subtractDark: s.subtractDark,
    disabledFluors: [...s.disabledFluors],
    disabledSamples: [...s.disabledSamples],
    showUnloadedFluors: s.showUnloadedFluors,
    thresholdOverrides: [...s.thresholdOverrides],
    thresholdMultiplier: s.thresholdMultiplier,
  };
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
    bands: s.bands ?? "auto",
    step: s.step ?? null,
    calibration: s.calibration ?? null,
    fluorViewMode: s.fluorViewMode ?? "fluorophore",
    calibrationNormalization: s.calibrationNormalization ?? "global",
    // Records written before this setting existed carry the retired three-way
    // calibrationBackground ("none"/"dark"/"plate"); only "dark" maps to the surviving stage.
    subtractDark: s.subtractDark ?? s.calibrationBackground === "dark",
    disabledFluors: new Set(s.disabledFluors ?? []),
    disabledSamples: new Set(s.disabledSamples ?? []),
    showUnloadedFluors: s.showUnloadedFluors ?? false,
    temps: new Set(s.temps ?? []),
    // Older records carry these under the Analysis view's own name (see StoredSettings).
    thresholdOverrides: new Map(s.thresholdOverrides ?? s.analysisThresholdOverrides ?? []),
    thresholdMultiplier: s.thresholdMultiplier ?? DEFAULT_THRESHOLD_MULTIPLIER,
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
  setActive: (id: string) => void;
  remove: (id: string) => Promise<void>;
  updateSettings: (patch: Partial<FileSettings>) => void;
}

export function useZpcrStore(): ZpcrStore {
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [settingsMap, setSettingsMap] = useState<Record<string, FileSettings>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  // Seed the view from the URL hash so a shared link opens on the right tab with no flash of
  // the default one (see `urlHash.ts`); the file half can only be resolved after hydration.
  const [view, setView] = useState<ViewId>(() => readHash().view ?? "curves");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const saveTimers = useRef<Record<string, number>>({});
  const [password] = usePltdPassword();

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
        for (const s of storedSettings) map[s.fileId] = fromStored(s);
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
      if (h.file) {
        const match = files.find((f) => f.name === h.file);
        if (match) setActiveId(match.id);
      }
    });
  }, [files]);

  const addFiles = useCallback(async (input: FileList | File[]) => {
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
        const addedAt = Date.now();
        await putFile({ id, name: file.name, size: file.size, addedAt, bytes: buf, kind });
        lastId = id;
        setFiles((prev) => {
          const rest = prev.filter((f) => f.id !== id);
          return [...rest, { id, name: file.name, size: file.size, addedAt, kind, bytes }];
        });
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (lastId) setActiveId(lastId);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await deleteFile(id);
      setFiles((prev) => {
        const next = prev.filter((f) => f.id !== id);
        setActiveId((cur) => (cur === id ? next.at(-1)?.id ?? null : cur));
        return next;
      });
      setSettingsMap((prev) => {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      });
    },
    [],
  );

  const setActive = useCallback((id: string) => setActiveId(id), []);

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

  const settings = activeId
    ? settingsMap[activeId] ?? defaultSettings()
    : null;

  const updateSettings = useCallback(
    (patch: Partial<FileSettings>) => {
      if (!activeId) return;
      setSettingsMap((prev) => {
        const current = prev[activeId] ?? defaultSettings();
        const next = { ...current, ...patch };
        // debounced persist
        window.clearTimeout(saveTimers.current[activeId]);
        saveTimers.current[activeId] = window.setTimeout(() => {
          void putSettings(toStored(activeId, next));
        }, 300);
        return { ...prev, [activeId]: next };
      });
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

  const plateFiles = useMemo(() => {
    const map = new Map<string, PlateFileResult>();
    for (const f of files) {
      if (f.kind === "pltd" || f.kind === "csv") map.set(f.id, parsePlateBytes(f.kind, f.bytes, password));
    }
    return map;
  }, [files, password]);

  const activePlateFile = activeId ? plateFiles.get(activeId) ?? null : null;

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
    setActive,
    remove,
    updateSettings,
  };
}
