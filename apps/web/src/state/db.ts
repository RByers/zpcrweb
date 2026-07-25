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
  /** Curves view's baseline-subtraction mode (`threshold.md` §4); absent on records written
   * before this setting existed. */
  curveBaseline?: "raw" | "constant" | "linear";
  /** Manual `[beginCycle, endCycle]` baseline-region override, or `null`/absent to auto-detect. */
  curveBaselineRange?: [number, number] | null;
  scale: "linear" | "log";
  showDark: boolean;
  bands: "off" | "auto" | "on";
  step: number | null;
  /** Temperature field keys plotted on the right axis, e.g. `["BLOCKTEMP"]`. */
  temps?: string[];
  /** Color separation: on/off, or unset to auto-enable when plate + calibration data exist. */
  calibration?: boolean | null;
  /** When color separation is on, group/label curves by fluorophore or by target/gene. */
  fluorViewMode?: "fluorophore" | "target";
  /** Calibration normalization mode; see `calibration.md` §3. Not user-facing — see the
   * FileSettings field of the same name for why. */
  calibrationNormalization?: "none" | "column" | "global";
  /** Additive background removed before color separation; see `calibration.md` §4.2. Absent on
   * records written before this setting existed, which then take the "none" default. */
  calibrationBackground?: "none" | "dark" | "plate";
  /** Fluorophore (or, in target view mode, target) names hidden from the dye-space view. */
  disabledFluors?: string[];
  /** When true, dye-space curves are drawn for every enabled well/fluor pair, even ones the
   * plate definition doesn't actually load into that well. Off by default. */
  showUnloadedFluors?: boolean;
  /** Analysis view: target/gene names hidden from the Cq/ΔRFU table. */
  analysisDisabledTargets?: string[];
  /** Analysis view's Cq determination algorithm. Absent on records written before this setting
   * existed, which then default to `"NoThreshold"`. */
  analysisCqAlgorithm?: "Threshold" | "NoThreshold";
  /** Manual per-target threshold overrides (RFU), as `[target, value]` pairs. */
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
