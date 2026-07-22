import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseZpcr, type Zpcr } from "@zpcrweb/core";
import {
  deleteFile,
  fileId,
  getAllFiles,
  getAllSettings,
  putFile,
  putSettings,
  type StoredSettings,
} from "./db";

export type ViewId = "overview" | "curves" | "raw";
export type Baseline = "raw" | "delta";
export type Scale = "linear" | "log";
/** Min/max envelope bands: always off, always on, or auto (only when one well selected). */
export type BandsMode = "off" | "auto" | "on";

/** Per-file view settings, in-memory form (Sets for cheap toggling). */
export interface FileSettings {
  view: ViewId;
  enabledChannels: Set<number>;
  enabledWells: Set<string>; // "row,col"
  baseline: Baseline;
  scale: Scale;
  /** Subtract each channel's dark (LED-off) background from its curves. */
  subtractDark: boolean;
  /** Min/max envelope bands mode. */
  bands: BandsMode;
}

/** A file loaded and parsed in memory. */
export interface LoadedFile {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  zpcr: Zpcr;
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
    // Sample rows A–H by default; the reference row (row 8) is off until enabled.
    enabledWells: wells,
    baseline: "raw",
    scale: "linear",
    subtractDark: false,
    bands: "auto",
  };
}

function toStored(id: string, s: FileSettings): StoredSettings {
  return {
    fileId: id,
    view: s.view,
    enabledChannels: [...s.enabledChannels],
    enabledWells: [...s.enabledWells],
    baseline: s.baseline,
    scale: s.scale,
    subtractDark: s.subtractDark,
    bands: s.bands,
  };
}

function fromStored(s: StoredSettings): FileSettings {
  return {
    view: (s.view as ViewId) ?? "curves",
    enabledChannels: new Set(s.enabledChannels),
    enabledWells: new Set(s.enabledWells),
    baseline: s.baseline ?? "raw",
    scale: s.scale ?? "linear",
    subtractDark: s.subtractDark ?? false,
    bands: s.bands ?? "auto",
  };
}

export interface ZpcrStore {
  files: LoadedFile[];
  activeId: string | null;
  active: LoadedFile | null;
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
        const loaded: LoadedFile[] = [];
        for (const f of stored) {
          try {
            loaded.push({
              id: f.id,
              name: f.name,
              size: f.size,
              addedAt: f.addedAt,
              zpcr: parseZpcr(new Uint8Array(f.bytes)),
            });
          } catch {
            /* skip corrupt entries */
          }
        }
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
    const list = Array.from(input).filter((f) => /\.zpcr$/i.test(f.name));
    let lastId: string | null = null;
    for (const file of list) {
      try {
        const buf = await file.arrayBuffer();
        const zpcr = parseZpcr(new Uint8Array(buf));
        const id = fileId(file.name, file.size);
        const record = {
          id,
          name: file.name,
          size: file.size,
          addedAt: Date.now(),
          bytes: buf,
        };
        await putFile(record);
        lastId = id;
        setFiles((prev) => {
          const rest = prev.filter((f) => f.id !== id);
          return [...rest, { id, name: file.name, size: file.size, addedAt: record.addedAt, zpcr }];
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

  return {
    files,
    activeId,
    active,
    settings,
    loading,
    error,
    addFiles,
    setActive,
    remove,
    updateSettings,
  };
}
