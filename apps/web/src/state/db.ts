/**
 * Thin IndexedDB wrapper — no dependencies. Three stores:
 *
 * - `files` — every file the app holds, as raw bytes, so they survive reloads and are re-parsed
 *   on demand. This is the app's *only* source of run data. **Records are read one id at a time**
 *   ({@link getFileBytes}), never all at once: the bytes of a file only enter memory when that
 *   file is loaded (see `useZpcrStore`'s loaded set, and `apps/web/ARCHITECTURE.md`'s "Files,
 *   loaded files, and the one selection").
 * - `meta` — one small record per file ({@link StoredMeta}): its identity, plus a cached
 *   {@link FileSummary} of what the *content* turned out to say, written each time the file is
 *   loaded. This is what lets the Files table list thousands of files — names, dates, protocol
 *   and plate names, read counts — without decoding, or even reading, a single archive.
 * - `settings` — per-file **display** state: which channels/wells/fluorophores are shown, log
 *   vs. linear, which protocol step, whether to draw baselines. A per-person view onto a run.
 *   Plus two fields that are not view settings at all — {@link StoredSettings.modified} and
 *   {@link StoredSettings.loaded} — which need a per-file record that survives a reload, and this
 *   is the app's only one.
 *
 * **Analysis state is deliberately absent.** Thresholds, the auto-threshold multiplier, dark
 * subtraction and calibration normalization all change the numbers the app reports, so they
 * belong to the run and travel inside the archive as its `zpcrweb.json` entry — see
 * `state/analysisSettings.ts` and `zpcrweb-json.md`. {@link StoredSettings} still *declares*
 * those fields, read-only, so records written before that split can be migrated into the file
 * on load (see `fromStored`'s callers); nothing writes them any more.
 */

const DB_NAME = "zpcrweb";
/** v2 added the `meta` store — see {@link openDb}'s upgrade path for how v1 data reaches it. */
const DB_VERSION = 2;
const FILES = "files";
const SETTINGS = "settings";
const META = "meta";

/** A stored file record. `kind` defaults to `"zpcr"` for records written before `.pcrd`
 * support was added (absent field on load), so existing IndexedDB data keeps working. */
export interface StoredFile {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  bytes: ArrayBuffer;
  kind?: "zpcr" | "pcrd" | "biomeme" | "pltd" | "csv" | "prcl";
  /** The source `File`'s own `lastModified` (its OS mtime, epoch ms) — when the file was last
   * saved to disk, as distinct from {@link addedAt} (when it was loaded into this browser).
   * Absent on records written before this field existed, or for one `attachPlate` rewrote in
   * place (which keeps the original file's own mtime rather than claiming a new one). */
  lastModified?: number;
}

/**
 * What a file's *content* turned out to say, cached from the last time the file was loaded.
 *
 * Every field here could be recomputed by decoding the file — and that is exactly the point of
 * caching it. Listing a thousand files in the Files table must not mean unzipping a thousand
 * archives, so the app decodes a file **only** when it is loaded (see
 * `apps/web/ARCHITECTURE.md`), and writes this summary at that moment. Everything the table and
 * its hover card show comes from here.
 *
 * Absent on a {@link StoredMeta} for a file that has never been loaded by a version of the app
 * that writes summaries — a v1 record carried into v2, say. Such a row renders with dashes until
 * the file is loaded once, which is the honest answer: nothing has read its content yet.
 */
export interface FileSummary {
  /** The experiment's resolved name (`lib/experiment.ts`'s `experimentIdentity`). */
  name: string;
  /** Whether {@link name} was given rather than derived from the file name. */
  named: boolean;
  /** Run start as epoch ms, or null for a file that records none. Stored as a number rather than
   * a `Date` because structured clone round-trips it either way and a number sorts directly. */
  dateMs: number | null;
  /** The thermal protocol's own name, or null when the file carries no protocol. */
  protocol: string | null;
  /** The plate's display name (`lib/plateNames.ts`), or null when there is no plate. */
  plate: string | null;
  /** The plate's targets, with the channel each is read on when that is known. */
  targets: { name: string; channel: number | null }[];
  /** The plate's sample names. */
  samples: string[];
  /** Plate-read count for a run; null for a file that isn't one. */
  reads: number | null;
  /** Loaded wells, for a standalone plate file; null otherwise. */
  wells: number | null;
  /**
   * Where the run stands: never started (`pending`), still being written to (`running`), over but
   * short of its protocol (`incomplete`), over (`complete`), or not a run at all (`none`). The
   * same three distinctions the file bar's chips draw — see `useZpcrStore`'s `pendingIds`,
   * `inProgressIds` and `incompleteIds`, which are what a *loaded* file's chip reads.
   */
  state: "none" | "pending" | "running" | "incomplete" | "complete";
  /** Mirrors `lib/encryptionStatus.ts`: nothing encrypted, encrypted and opened with the password
   * in force at load time, or encrypted and never opened. */
  encryption: "none" | "decrypted" | "locked";
}

/**
 * One record per file, holding everything the app can say about it **without reading its bytes**.
 * The `files` store's own records duplicate the identity fields; these exist so the whole catalog
 * can be listed in one small `getAll` while the archives stay on disk.
 */
export interface StoredMeta {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  lastModified: number;
  kind: FileKindName;
  /** See {@link FileSummary} — absent until the file has been loaded at least once. */
  summary?: FileSummary;
}

type FileKindName = "zpcr" | "pcrd" | "biomeme" | "pltd" | "csv" | "prcl";

/** Persisted per-file view settings. */
export interface StoredSettings {
  fileId: string;
  /**
   * Not a view setting: whether this file's *content* has been edited since it was loaded (or
   * since it was last downloaded) — a threshold moved, the run renamed. It rides in this record
   * because that is the app's one per-file store keyed by id, and because the fact has to
   * outlive a reload: the edits themselves are already durable (in the archive's `zpcrweb.json`,
   * in IndexedDB), so what is at risk is the copy on the user's disk, which is stale until they
   * download again. See `useZpcrStore`'s `modifiedIds` and the file chip's two-stage delete.
   */
  modified?: boolean;
  /**
   * Not a view setting either: whether this file is **loaded** — its bytes in memory, decoded, and
   * so a chip on the file bar and a candidate for the tab strip. An unloaded file stays in
   * IndexedDB and in the full files table; only its bytes leave memory. This is what the app
   * restores on the next session, so a browser holding a thousand archives reopens holding the
   * handful that were in use.
   *
   * Absent on records written before this field existed (where it was called `visible` and meant
   * "shows on the file bar", a file being loaded either way) — {@link visible} is still read for
   * those, and defaults to loaded, which is what they did.
   */
  loaded?: boolean;
  /** @deprecated Former name for {@link loaded}, when every file was loaded and this only decided
   * whether it got a chip. Still read so an older record keeps its state; never written. */
  visible?: boolean;
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
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FILES)) {
        db.createObjectStore(FILES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS, { keyPath: "fileId" });
      }
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, { keyPath: "id" });
        // v1 → v2: seed one meta record per existing file from what the file record already says.
        // Deliberately **no summary**: deriving one means decoding the archive, and decoding
        // happens only when a file is loaded. Every one of these rows gets its summary the first
        // time its file is opened, which for the files that were in use is the very next moment
        // (they reload on hydration), and for the rest is whenever they are next wanted.
        if (e.oldVersion >= 1 && req.transaction) {
          const files = req.transaction.objectStore(FILES);
          files.openCursor().onsuccess = (ev) => {
            const cursor = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            const f = cursor.value as StoredFile;
            meta.put({
              id: f.id,
              name: f.name,
              size: f.size,
              addedAt: f.addedAt,
              lastModified: f.lastModified ?? f.addedAt,
              kind: f.kind ?? "zpcr",
            } satisfies StoredMeta);
            cursor.continue();
          };
        }
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

/**
 * Write a file's bytes **and** its identity metadata, so the two can never disagree about a
 * file's name, size or kind. The summary is left alone: it belongs to the file's content, is
 * written by whoever just decoded it ({@link putSummary}), and a caller rewriting bytes here has
 * usually not re-derived it yet.
 */
export async function putFile(file: StoredFile): Promise<void> {
  await tx(FILES, "readwrite", (s) => s.put(file));
  const existing = await tx<StoredMeta | undefined>(META, "readonly", (s) => s.get(file.id));
  await tx(META, "readwrite", (s) =>
    s.put({
      id: file.id,
      name: file.name,
      size: file.size,
      addedAt: file.addedAt,
      lastModified: file.lastModified ?? file.addedAt,
      kind: file.kind ?? "zpcr",
      ...(existing?.summary ? { summary: existing.summary } : {}),
    } satisfies StoredMeta),
  );
}

/** Cache what a file's content says, having just decoded it — see {@link FileSummary}. A no-op
 * for an id with no meta record, which can only mean the file was deleted mid-flight. */
export async function putSummary(id: string, summary: FileSummary): Promise<void> {
  const existing = await tx<StoredMeta | undefined>(META, "readonly", (s) => s.get(id));
  if (!existing) return;
  await tx(META, "readwrite", (s) => s.put({ ...existing, summary } satisfies StoredMeta));
}

/** The whole catalog, metadata only — no archive bytes are read. This is the query the Files
 * table is built on, and the reason a browser holding thousands of files still starts instantly. */
export function getAllMeta(): Promise<StoredMeta[]> {
  return tx<StoredMeta[]>(META, "readonly", (s) => s.getAll());
}

/** One file's bytes, by id — the only way bytes enter memory. Resolves to `undefined` for a file
 * that has since been deleted. */
export async function getFileBytes(id: string): Promise<ArrayBuffer | undefined> {
  const rec = await tx<StoredFile | undefined>(FILES, "readonly", (s) => s.get(id));
  return rec?.bytes;
}

export async function deleteFile(id: string): Promise<void> {
  await tx(FILES, "readwrite", (s) => s.delete(id));
  await tx(META, "readwrite", (s) => s.delete(id));
  await tx(SETTINGS, "readwrite", (s) => s.delete(id));
}

export function putSettings(settings: StoredSettings): Promise<unknown> {
  return tx(SETTINGS, "readwrite", (s) => s.put(settings));
}

export function getAllSettings(): Promise<StoredSettings[]> {
  return tx<StoredSettings[]>(SETTINGS, "readonly", (s) => s.getAll());
}
