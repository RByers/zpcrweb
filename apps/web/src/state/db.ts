/**
 * Thin IndexedDB wrapper — no dependencies. Persists loaded `.zpcr` files (raw bytes, so
 * they survive reloads and are re-parsed on demand) and per-file view settings (which
 * channels/wells are enabled, baseline/scale mode).
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
  kind?: "zpcr" | "pcrd" | "pltd" | "csv";
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
  /** Min/max envelope bands. Older records carry the retired three-way mode; `fromStored`
   * migrates it (only `"on"` becomes `true`). */
  bands: boolean | "off" | "auto" | "on";
  step: number | null;
  /** Temperature field keys plotted on the right axis, e.g. `["BLOCKTEMP"]`. */
  temps?: string[];
  /** Color separation: on/off, or unset to auto-enable when plate + calibration data exist. */
  calibration?: boolean | null;
  /** When color separation is on, group/label curves by fluorophore or by target/gene — or show
   * the Cq/ΔRFU table instead of the chart (`"table"`). */
  fluorViewMode?: "fluorophore" | "target" | "table";
  /** Calibration normalization mode; see `calibration.md` §3. Not user-facing — see the
   * FileSettings field of the same name for why. */
  calibrationNormalization?: "none" | "column" | "global";
  /** Whether the LED-off `DARKDATA` is subtracted before color separation; see `calibration.md`
   * §4.2. Absent on older records, which migrate from {@link calibrationBackground} below. */
  subtractDark?: boolean;
  /** Retired three-way background selector ("none"/"dark"/"plate") — kept only so older records
   * can be migrated to {@link subtractDark} ("dark" → true, else false). Empty-plate subtraction
   * is gone; dark subtraction is the pipeline's one optional additive stage. */
  calibrationBackground?: "none" | "dark" | "plate";
  /** Fluorophore (or, in target view mode, target) names hidden from the dye-space view. */
  disabledFluors?: string[];
  /** Curves view: sample names hidden from the plotted curves. */
  disabledSamples?: string[];
  /** When true, dye-space curves are drawn for every enabled well/fluor pair, even ones the
   * plate definition doesn't actually load into that well. Off by default. */
  showUnloadedFluors?: boolean;
  /** Manual per-target threshold overrides (RFU), as `[target, value]` pairs. */
  thresholdOverrides?: [string, number][];
  /** §5.1's auto-threshold multiplier. Absent on records written before it was adjustable, which
   * fall back to the library default. */
  thresholdMultiplier?: number;
  /** Retired: the standalone Analysis view's own target opt-out set. That view is now the Curves
   * view's table mode and shares the rail's {@link disabledFluors}, so these are ignored. */
  analysisDisabledTargets?: string[];
  /** Retired: the Analysis view's Cq-algorithm selector. Cq is always `threshold.md` §6.1's
   * threshold crossing now, so this is ignored. */
  analysisCqAlgorithm?: "Threshold" | "NoThreshold";
  /** Retired name for {@link thresholdOverrides}, still read when migrating older records. */
  analysisThresholdOverrides?: [string, number][];
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
