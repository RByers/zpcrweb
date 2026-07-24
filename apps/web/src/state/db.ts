/**
 * Thin IndexedDB wrapper — no dependencies. Persists loaded `.zpcr` files (raw bytes, so
 * they survive reloads and are re-parsed on demand) and per-file view settings (which
 * channels/wells are enabled, baseline/scale mode, last view).
 */

const DB_NAME = "zpcrweb";
const DB_VERSION = 1;
const FILES = "files";
const SETTINGS = "settings";

/** A stored file record. */
export interface StoredFile {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  bytes: ArrayBuffer;
}

/** Persisted per-file view settings. */
export interface StoredSettings {
  fileId: string;
  view: string;
  enabledChannels: number[];
  enabledWells: string[]; // "row,col" keys
  baseline: "raw" | "delta";
  scale: "linear" | "log";
  subtractDark: boolean;
  bands: "off" | "auto" | "on";
  step: number | null;
  /** Temperature field keys plotted on the right axis, e.g. `["BLOCKTEMP"]`. */
  temps?: string[];
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
