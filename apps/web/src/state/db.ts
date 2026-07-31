/**
 * Thin IndexedDB wrapper — no dependencies. Two stores:
 *
 * - `files` — loaded `.zpcr`/`.pcrd`/plate files as raw bytes, so they survive reloads and are
 *   re-parsed on demand. This is the app's *only* source of run data.
 * - `settings` — per-file **display** state: which channels/wells/fluorophores are shown, log
 *   vs. linear, which protocol step, whether to draw baselines. A per-person view onto a run.
 *
 * **Analysis state is deliberately absent.** Thresholds, the auto-threshold multiplier, dark
 * subtraction and calibration normalization all change the numbers the app reports, so they
 * belong to the run and travel inside the archive as its `zpcrweb.json` entry — see
 * `state/analysisSettings.ts` and `zpcrweb-json.md`. {@link StoredSettings} still *declares*
 * those fields, read-only, so records written before that split can be migrated into the file
 * on load (see `fromStored`'s callers); nothing writes them any more.
 */

const DB_NAME = "zpcrweb";
const DB_VERSION = 1;
const FILES = "files";
const SETTINGS = "settings";

/** A stored file record. `kind` defaults to `"zpcr"` for records written before `.pcrd`
 * support was added (absent field on load), so existing IndexedDB data keeps working. */
export interface StoredFile {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  bytes: ArrayBuffer;
  kind?: "zpcr" | "pcrd" | "biomeme" | "pltd" | "csv";
}

/** Persisted per-file view settings. */
export interface StoredSettings {
  fileId: string;
  enabledChannels: number[];
  enabledWells: string[]; // "row,col" keys
  /** Reference columns (0-based) shown in the Reference view. */
  enabledRefCols?: number[];
  baseline: "raw" | "delta" | "percent";
  /** Curves view's display mode; absent on records written before this setting existed
   * (falls back via {@link curveBaseline}, below). */
  curveView?: "relative" | "absolute";
  /** Overlay the auto-detected linear baseline on each curve. Absent on older records, which
   * then default to off. */
  drawBaseline?: boolean;
  /** Retired three-way baseline-subtraction mode (`threshold.md` §4) — kept only so older
   * records can be migrated to {@link curveView} (`"raw"` → `"absolute"`, else `"relative"`);
   * baselining itself is no longer configurable, always an auto-detected linear fit. */
  curveBaseline?: "raw" | "constant" | "linear";
  scale: "linear" | "log";
  showDark: boolean;
  /** Reference view's factory-calibration overlay. Absent in records written before the
   * toggle existed; `fromStored` defaults those to on, which is what they rendered. */
  showFactory?: boolean;
  /** Reference view's x-axis mode. Absent in older records, which default to `"cycle"`. */
  refXAxis?: "cycle" | "column";
  /** Min/max envelope bands. Older records carry the retired three-way mode; `fromStored`
   * migrates it (only `"on"` becomes `true`). */
  bands: boolean | "off" | "auto" | "on";
  step: number | null;
  /** Temperature field keys plotted on the right axis, e.g. `["BLOCKTEMP"]`. */
  temps?: string[];
  /** LED drive-current field keys plotted on the right axis, e.g. `["LEDCURRENT01"]`. Never
   * non-empty at the same time as {@link temps} — the two share one axis. */
  leds?: string[];
  /** Color separation: on/off, or unset to auto-enable when plate + calibration data exist. */
  calibration?: boolean | null;
  /** When color separation is on, group/label curves by fluorophore or by target/gene — or show
   * the Cq/ΔRFU table instead of the chart (`"table"`). */
  fluorViewMode?: "fluorophore" | "target" | "table";
  /** Fluorophore (or, in target view mode, target) names hidden from the dye-space view. */
  disabledFluors?: string[];
  /** Curves view: sample names hidden from the plotted curves. */
  disabledSamples?: string[];
  /** When true, dye-space curves are drawn for every enabled well/fluor pair, even ones the
   * plate definition doesn't actually load into that well. Off by default. */
  showUnloadedFluors?: boolean;
  /** Curves view: the Cq filter's bounds in cycles, `null`/absent for unbounded. An absent (or
   * `null`) {@link cqMax} is also what keeps the curves with no Cq at all on screen — see
   * `FileSettings.cqMin`. */
  cqMin?: number | null;
  cqMax?: number | null;
  /** Calibration view: `${dye}|${plateType}` keys of the `.Dcal` files plotted. Opt-in, so an
   * absent/empty list means "unseeded" rather than "none" — see `FileSettings.calFiles`. */
  calFiles?: string[];
  /** Calibration view: response curves (`"relative"`) or the raw dye/empty readings behind them
   * (`"absolute"`). Absent on older records, which then default to `"relative"`. */
  calView?: "relative" | "absolute";
  /** Curves view: file-vs-computed baseline/Cq toggles for a source that carries its own
   * analysis (Biomeme). Absent on older records, which then default to `"file"` — see
   * `FileSettings.baselineSource`/`cqSource`. */
  baselineSource?: "file" | "computed";
  cqSource?: "file" | "computed";
  /** Retired: the standalone Analysis view's own target opt-out set. That view is now the Curves
   * view's table mode and shares the rail's {@link disabledFluors}, so these are ignored. */
  analysisDisabledTargets?: string[];
  /** Retired: the Analysis view's Cq-algorithm selector. Cq is always `threshold.md` §6's
   * threshold crossing now, so this is ignored. */
  analysisCqAlgorithm?: "Threshold" | "NoThreshold";

  // ── Migrated-away analysis fields ────────────────────────────────────────────────────────
  // Read once on load and folded into the file's own `zpcrweb.json` (see the module comment and
  // `legacyAnalysisFromStored` in `useZpcrStore.ts`), then dropped: nothing writes them, so the
  // first save of any display setting rewrites the record without them.
  /** @deprecated → `zpcrweb.json` `analysis.thresholdOverrides`. `[fluor, RFU]` pairs. */
  thresholdOverrides?: [string, number][];
  /** @deprecated → `zpcrweb.json` `analysis.curveThresholdOverrides`.
   * `["row,col,fluor", RFU]` pairs. */
  curveThresholdOverrides?: [string, number][];
  /** @deprecated → `zpcrweb.json` `analysis.thresholdMultiplier`. */
  thresholdMultiplier?: number;
  /** @deprecated → `zpcrweb.json` `analysis.subtractDark`. */
  subtractDark?: boolean;
  /** @deprecated → `zpcrweb.json` `analysis.calibrationNormalization`. */
  calibrationNormalization?: "none" | "column" | "global";
  /** @deprecated Retired three-way background selector ("none"/"dark"/"plate"), migrated to
   * {@link subtractDark} ("dark" → true, else false) and from there into the file. */
  calibrationBackground?: "none" | "dark" | "plate";
  /** @deprecated Retired name for {@link thresholdOverrides}, still read when migrating. */
  analysisThresholdOverrides?: [string, number][];
}

/** True when a stored record still carries analysis fields that now belong in the file — the
 * trigger for the one-time migration, and for rewriting the record without them. */
export function hasLegacyAnalysisFields(s: StoredSettings): boolean {
  return (
    s.thresholdOverrides !== undefined ||
    s.curveThresholdOverrides !== undefined ||
    s.analysisThresholdOverrides !== undefined ||
    s.thresholdMultiplier !== undefined ||
    s.subtractDark !== undefined ||
    s.calibrationNormalization !== undefined ||
    s.calibrationBackground !== undefined
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) {
        db.createObjectStore(FILES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS, { keyPath: "fileId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        t.oncomplete = () => {
          resolve(req.result);
          db.close();
        };
        t.onerror = () => {
          reject(t.error);
          db.close();
        };
      }),
  );
}

/** Stable id derived from name + size (cheap dedupe of the same file). */
export function fileId(name: string, size: number): string {
  return `${name}:${size}`;
}

export function putFile(file: StoredFile): Promise<unknown> {
  return tx(FILES, "readwrite", (s) => s.put(file));
}

export function getAllFiles(): Promise<StoredFile[]> {
  return tx<StoredFile[]>(FILES, "readonly", (s) => s.getAll());
}

export async function deleteFile(id: string): Promise<void> {
  await tx(FILES, "readwrite", (s) => s.delete(id));
  await tx(SETTINGS, "readwrite", (s) => s.delete(id));
}

export function putSettings(settings: StoredSettings): Promise<unknown> {
  return tx(SETTINGS, "readwrite", (s) => s.put(settings));
}

export function getAllSettings(): Promise<StoredSettings[]> {
  return tx<StoredSettings[]>(SETTINGS, "readonly", (s) => s.getAll());
}
