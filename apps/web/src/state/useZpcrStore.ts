import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parsePcrd,
  parseZpcr,
  type NormalizationMode,
  type PcrdContainer,
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

export type FileKind = "zpcr" | "pcrd";

export type ViewId = "overview" | "curves" | "reference" | "plates" | "raw";
/** Reference view only — drift relative to the factory calibration value; see `ReferenceView`. */
export type Baseline = "raw" | "delta" | "percent";
/**
 * Curves view only — the `threshold.md` §4 baseline-subtraction modes implemented by
 * `packages/core/src/baseline.ts`: `"raw"` plots the curve unmodified, `"constant"` subtracts
 * the mean of an auto-detected baseline region (`RawBaseLineSubtracted`), and `"linear"` fits
 * and subtracts a line over that region (`LinearBaseLineNormalized`) — the recommended default
 * per §8, since it also removes baseline drift rather than just an offset.
 */
export type CurveBaselineMode = "raw" | "constant" | "linear";
/** Manual override of the baseline region (1-based, inclusive `[beginCycle, endCycle]`), or
 * `null` to auto-detect it per curve (`autoBaselineRegion`) — the default. */
export type CurveBaselineRange = [number, number] | null;
export type Scale = "linear" | "log";
/** Min/max envelope bands: always off, always on, or auto (only when one well selected). */
export type BandsMode = "off" | "auto" | "on";
/** How dye-space curves are grouped/labeled once color separation is on. */
export type FluorViewMode = "fluorophore" | "target";

/** Per-file view settings, in-memory form (Sets for cheap toggling). */
export interface FileSettings {
  view: ViewId;
  enabledChannels: Set<number>;
  enabledWells: Set<string>; // "row,col"
  /** Reference columns (0-based) shown in the Reference chart. */
  enabledRefCols: Set<number>;
  baseline: Baseline;
  /** Curves view's baseline-subtraction mode; see {@link CurveBaselineMode}. */
  curveBaseline: CurveBaselineMode;
  /** Manual baseline-region override for the Curves view; see {@link CurveBaselineRange}. */
  curveBaselineRange: CurveBaselineRange;
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
  /** Calibration matrix column normalization; see `calibration.md` §3. */
  calibrationNormalization: NormalizationMode;
  /** Fluorophore (or, in target view mode, target) names hidden from the dye-space curves (an
   * opt-out set, like `enabledChannels` inverted — new entries default to shown without needing
   * to know their names up front). */
  disabledFluors: Set<string>;
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

function parseRun(bytes: Uint8Array, kind: FileKind, password: string): RunResult {
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

export function wellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function defaultSettings(): FileSettings {
  const wells = new Set<string>();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 12; col++) wells.add(wellKey(row, col));
  }
  return {
    view: "curves",
    // Channels 1–5 (the standard dye set) on by default; channel 6 (FRET) is off — it is a
    // real optical channel but standard runs don't use it. The user can toggle it on.
    enabledChannels: new Set([0, 1, 2, 3, 4]),
    enabledWells: wells,
    // All 12 reference columns on by default in the Reference view.
    enabledRefCols: new Set(Array.from({ length: 12 }, (_, c) => c)),
    baseline: "raw",
    // Linear baseline subtraction (auto-detected region) is threshold.md §8's recommended
    // default — it removes drift, not just offset, and matches the observed instrument default.
    curveBaseline: "linear",
    // null: auto-detect the baseline region per curve, same as leaving the slider untouched.
    curveBaselineRange: null,
    scale: "linear",
    showDark: false,
    bands: "auto",
    step: null,
    // Temperatures are off by default — they are instrument context, not the measurement.
    temps: new Set<string>(),
    // Auto: on once plate + calibration data are available (see CurvesView).
    calibration: null,
    fluorViewMode: "fluorophore",
    calibrationNormalization: "global",
    disabledFluors: new Set<string>(),
    showUnloadedFluors: false,
  };
}

function toStored(id: string, s: FileSettings): StoredSettings {
  return {
    fileId: id,
    view: s.view,
    enabledChannels: [...s.enabledChannels],
    enabledWells: [...s.enabledWells],
    enabledRefCols: [...s.enabledRefCols],
    baseline: s.baseline,
    curveBaseline: s.curveBaseline,
    curveBaselineRange: s.curveBaselineRange,
    scale: s.scale,
    showDark: s.showDark,
    bands: s.bands,
    step: s.step ?? null,
    temps: [...s.temps],
    calibration: s.calibration,
    fluorViewMode: s.fluorViewMode,
    calibrationNormalization: s.calibrationNormalization,
    disabledFluors: [...s.disabledFluors],
    showUnloadedFluors: s.showUnloadedFluors,
  };
}

function fromStored(s: StoredSettings): FileSettings {
  return {
    view: (s.view as ViewId) ?? "curves",
    enabledChannels: new Set(s.enabledChannels),
    enabledWells: new Set(s.enabledWells),
    enabledRefCols: new Set(s.enabledRefCols ?? Array.from({ length: 12 }, (_, c) => c)),
    baseline: s.baseline ?? "raw",
    curveBaseline: s.curveBaseline ?? "linear",
    curveBaselineRange: s.curveBaselineRange ?? null,
    scale: s.scale ?? "linear",
    showDark: s.showDark ?? false,
    bands: s.bands ?? "auto",
    step: s.step ?? null,
    calibration: s.calibration ?? null,
    fluorViewMode: s.fluorViewMode ?? "fluorophore",
    calibrationNormalization: s.calibrationNormalization ?? "global",
    disabledFluors: new Set(s.disabledFluors ?? []),
    showUnloadedFluors: s.showUnloadedFluors ?? false,
    temps: new Set(s.temps ?? []),
  };
}

/** True for file names this app knows how to load. */
function fileKind(name: string): FileKind | null {
  if (/\.zpcr$/i.test(name)) return "zpcr";
  if (/\.pcrd$/i.test(name)) return "pcrd";
  return null;
}

export interface ZpcrStore {
  files: LoadedFile[];
  activeId: string | null;
  active: LoadedFile | null;
  /** Parse result for every loaded file, keyed by id — recomputed when the shared
   * decryption password changes, so a `.pcrd` unlocks reactively without reloading. */
  runs: Map<string, RunResult>;
  activeRun: RunResult | null;
  settings: FileSettings | null;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const saveTimers = useRef<Record<string, number>>({});
  const [password] = usePltdPassword();

  // Hydrate from IndexedDB on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [stored, storedSettings] = await Promise.all([
          getAllFiles(),
          getAllSettings(),
        ]);
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
        setActiveId(loaded.at(-1)?.id ?? null);
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
        // .pcrd's payload may still need a password, resolved reactively via `runs`.
        if (kind === "zpcr") parseZpcr(bytes);
        else parsePcrd(bytes);
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

  const active = useMemo(
    () => files.find((f) => f.id === activeId) ?? null,
    [files, activeId],
  );

  const runs = useMemo(() => {
    const map = new Map<string, RunResult>();
    for (const f of files) map.set(f.id, parseRun(f.bytes, f.kind, password));
    return map;
  }, [files, password]);

  const activeRun = activeId ? runs.get(activeId) ?? null : null;

  return {
    files,
    activeId,
    active,
    runs,
    activeRun,
    settings,
    loading,
    error,
    addFiles,
    setActive,
    remove,
    updateSettings,
  };
}
