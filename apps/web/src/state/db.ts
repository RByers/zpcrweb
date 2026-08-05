/**
 * Thin IndexedDB wrapper — no dependencies. Two stores:
 *
 * - `files` — the bytes, and nothing else. A record holds either a file's raw bytes or, for a run
 *   still being written to, its archive entries individually — see {@link StoredFile} and
 *   `fileContent.ts`, which owns that choice. **Records are read one id at a time**
 *   ({@link getFileContent}), never all at once: the content of a file only enters memory when that
 *   file is loaded (see `useZpcrStore`'s loaded set, and `apps/web/ARCHITECTURE.md`'s "Files,
 *   loaded files, and the one selection").
 * - `catalog` — one small record per file ({@link StoredEntry}): its identity, a cached
 *   {@link FileSummary} of what the *content* turned out to say, the two per-file flags that must
 *   outlive a reload ({@link StoredEntry.modified} and {@link StoredEntry.loaded}), and — for a
 *   loaded file only — its {@link StoredView} display state.
 *
 * **Why content is a separate store.** {@link getAllEntries} reads the whole catalog in one
 * `getAll()`, which is what lets the Files table list thousands of files — names, dates, protocol
 * and plate names, read counts — without decoding, or even reading, a single archive. IndexedDB has
 * no way to fetch part of a record, so a store holding both would structured-clone every archive in
 * the database on that call. That is the one split worth keeping, and the reason everything *else*
 * about a file lives together in `catalog`.
 *
 * **Analysis state is deliberately absent.** Thresholds, the auto-threshold multiplier and
 * calibration normalization all change the numbers the app reports, so they belong to the run and
 * travel inside the archive as its `zpcrweb.json` entry — see `state/analysisSettings.ts` and
 * `zpcrweb-json.md`. What is left here is display state, which never leaves this browser.
 *
 * **The schema is not migrated.** While the app is in development, a change to the shape of what is
 * stored bumps {@link DB_VERSION} and drops every store, rebuilding empty — see {@link openDb}.
 * There is therefore no such thing as a record written by an older version, and nothing here has to
 * tolerate a missing or renamed field. See `apps/web/ARCHITECTURE.md`, "Stored state".
 */

const DB_NAME = "zpcrweb";
/** Bumping this **erases the database**. See {@link openDb}. */
const DB_VERSION = 3;
const FILES = "files";
const CATALOG = "catalog";

type FileKindName = "zpcr" | "pcrd" | "biomeme" | "pltd" | "csv" | "prcl";

/** A file's identity — everything about it that is knowable without reading its bytes, and the
 * half of a {@link StoredEntry} that {@link putFile} owns. */
export interface FileIdentity {
  id: string;
  name: string;
  /** The size the app reports for this file — its byte length when stored as
   * {@link StoredFile.bytes}, and the total of its entries when stored as {@link StoredFile.files}.
   * See `fileContent.ts`'s `contentSize`. */
  size: number;
  /** When the file was loaded into this browser, epoch ms. */
  addedAt: number;
  /** The source `File`'s own `lastModified` (its OS mtime, epoch ms) — when the file was last saved
   * to disk, as distinct from {@link addedAt}. A file the app rewrote in place keeps the original
   * mtime rather than claiming a new one. */
  lastModified: number;
  kind: FileKindName;
}

/** A stored file's content — exactly one of the two representations, keyed by the same id as its
 * {@link StoredEntry}. */
export interface StoredFile {
  id: string;
  /**
   * The file's bytes. Exactly one of this and {@link files} is set.
   *
   * IndexedDB stores an `ArrayBuffer` by structured clone, so this is a copy rather than a view
   * onto whatever the app is holding.
   */
  bytes?: ArrayBuffer;
  /**
   * A `.zpcr`'s archive entries, name → bytes, stored individually instead of as one ZIP — what a
   * run still being written to is kept as, so appending a plate read or renaming the experiment
   * doesn't unzip and re-zip several hundred KB. Set instead of {@link bytes}, never alongside it,
   * and only ever for `kind: "zpcr"`.
   *
   * Which form a run takes is decided in one place, from the archive's own `begun`/`ended`
   * markers: see `fileContent.ts`. Once the run ends, the record is rewritten as ordinary
   * {@link bytes}. Nothing outside `fileContent.ts` should read either field directly.
   */
  files?: Record<string, ArrayBuffer>;
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
 * Absent on a file that has never been loaded. Such a row renders with dashes, which is the honest
 * answer: nothing has read its content yet.
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
 * A file's **display** state: which channels/wells/fluorophores are shown, log vs. linear, which
 * protocol step, whether to draw baselines. A per-person view onto a run, and the one part of a
 * {@link StoredEntry} that is not kept for every file — see {@link StoredEntry.view}.
 *
 * Sets are stored as arrays. Structured clone would round-trip a `Set` directly, but the persisted
 * shape is worth keeping plain: it is what a person reads in the browser's storage inspector, and
 * `useZpcrStore`'s `viewOf`/`fromStored` are the one place the two shapes meet.
 */
export interface StoredView {
  enabledChannels: number[];
  enabledWells: string[]; // "row,col" keys
  /** Reference columns (0-based) shown in the Reference view. */
  enabledRefCols: number[];
  baseline: "raw" | "delta" | "percent";
  /** Curves view's display mode. */
  curveView: "relative" | "absolute";
  /** Overlay the auto-detected linear baseline on each curve. */
  drawBaseline: boolean;
  scale: "linear" | "log";
  showDark: boolean;
  /** Reference view's factory-calibration overlay. */
  showFactory: boolean;
  /** Reference view's x-axis mode. */
  refXAxis: "cycle" | "column";
  /** Min/max envelope bands. */
  bands: boolean;
  step: number | null;
  /** Temperature field keys plotted on the right axis, e.g. `["BLOCKTEMP"]`. */
  temps: string[];
  /** LED drive-current field keys plotted on the right axis, e.g. `["LEDCURRENT01"]`. Never
   * non-empty at the same time as {@link temps} — the two share one axis. */
  leds: string[];
  /** Color separation: on/off, or null to auto-enable when plate + calibration data exist. */
  calibration: boolean | null;
  /** When color separation is on, group/label curves by fluorophore or by target/gene — or show
   * the Cq/ΔRFU table instead of the chart (`"table"`). */
  fluorViewMode: "fluorophore" | "target" | "table";
  /** Fluorophore (or, in target view mode, target) names hidden from the dye-space view. */
  disabledFluors: string[];
  /** Curves view: sample names hidden from the plotted curves. */
  disabledSamples: string[];
  /** When true, dye-space curves are drawn for every enabled well/fluor pair, even ones the
   * plate definition doesn't actually load into that well. */
  showUnloadedFluors: boolean;
  /** Curves view: the Cq filter's bounds in cycles, `null` for unbounded. A `null` {@link cqMax} is
   * also what keeps the curves with no Cq at all on screen — see `FileSettings.cqMin`. */
  cqMin: number | null;
  cqMax: number | null;
  /** Calibration view: `${dye}|${plateType}` keys of the `.Dcal` files plotted. Opt-in, so an
   * empty list means "unseeded" rather than "none" — see `FileSettings.calFiles`. */
  calFiles: string[];
  /** Calibration view: response curves (`"relative"`) or the raw dye/empty readings behind them
   * (`"absolute"`). */
  calView: "relative" | "absolute";
  /** Curves view: file-vs-computed baseline/Cq toggles for a source that carries its own
   * analysis (Biomeme) — see `FileSettings.baselineSource`/`cqSource`. */
  baselineSource: "file" | "computed";
  cqSource: "file" | "computed";
}

/**
 * One record per file, holding everything the app can say about it **without reading its bytes**.
 * This is what the whole catalog is listed from ({@link getAllEntries}) while the archives stay on
 * disk, so it must stay small: {@link view} is the largest thing on it, and it is kept only for the
 * handful of files that are loaded.
 */
export interface StoredEntry extends FileIdentity {
  /** See {@link FileSummary} — absent until the file has been loaded at least once. */
  summary?: FileSummary;
  /**
   * Whether this file's *content* has been edited since it was loaded (or since it was last
   * downloaded) — a threshold moved, the run renamed. Not display state, and it has to outlive a
   * reload: the edits themselves are already durable (in the archive's `zpcrweb.json`, in
   * IndexedDB), so what is at risk is the copy on the user's disk, which is stale until they
   * download again. See `useZpcrStore`'s `modifiedIds` and the file chip's two-stage delete.
   */
  modified: boolean;
  /**
   * Whether this file is **loaded** — its bytes in memory, decoded, and so a chip on the file bar
   * and a candidate for the tab strip. An unloaded file stays in IndexedDB and in the full files
   * table; only its bytes leave memory. This is what the app restores on the next session, so a
   * browser holding a thousand archives reopens holding the handful that were in use.
   */
  loaded: boolean;
  /**
   * This file's display state — **present only while {@link loaded} is true**.
   *
   * Releasing a file drops it, and re-loading the file starts from defaults again. That is the
   * deliberate bargain of the two sets: everything that changes a reported number lives in the
   * archive and survives (see the module comment), while which wells you had hidden is a property
   * of looking at the run, not of the run, and lasts as long as you are looking at it. Keeping it
   * for every file the browser has ever seen would also put the largest field on this record into
   * the one query that has to stay cheap.
   */
  view?: StoredView;
}

/**
 * Open the database, **erasing it whenever {@link DB_VERSION} has moved**.
 *
 * The app is in development and nobody's data lives only here: a run is a file the user has on
 * disk, and everything the app adds to one is written back into that file. So a schema change
 * drops every store and rebuilds empty rather than carrying a migration path — and, more to the
 * point, rather than carrying the compatibility shims a migration path grows (optional fields,
 * renamed-field fallbacks, "records written before this existed" defaults) into every type in this
 * module. Change a stored shape, bump the version, and the next load starts clean.
 *
 * > **Future:** once the app ships to people who keep files only in the browser, this becomes a
 * > real upgrade path, and stored types go back to tolerating older shapes.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore(FILES, { keyPath: "id" });
      db.createObjectStore(CATALOG, { keyPath: "id" });
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

/** In-flight catalog writes, per file id — see {@link serializeCatalog}. */
const catalogWrites = new Map<string, Promise<unknown>>();

/**
 * Run a catalog read-modify-write after any already in flight for the same id.
 *
 * Every write to a `catalog` record merges into what is already stored, and the app fires several
 * at once on one file — releasing it writes the flags, the summary and the dropped view from three
 * places in the same tick. Without this, two of them could read the same "before" record and the
 * later write would silently undo the earlier one. Per id, so unrelated files still write in
 * parallel.
 */
function serializeCatalog<T>(id: string, run: () => Promise<T>): Promise<T> {
  const result = (catalogWrites.get(id) ?? Promise.resolve()).then(run, run);
  // The chain must survive a rejection, or one failed write would wedge that id forever.
  const settled = result.then(
    () => {},
    () => {},
  );
  catalogWrites.set(id, settled);
  void settled.then(() => {
    if (catalogWrites.get(id) === settled) catalogWrites.delete(id);
  });
  return result;
}

/**
 * Write a file's content **and** its identity, so the two can never disagree about a file's name,
 * size or kind. Everything else on the catalog record — the summary, the flags, the view — belongs
 * to whoever last wrote it ({@link updateEntry}) and is carried over untouched; a file being seen
 * for the first time starts unmodified and loaded, which is what adding a file means.
 *
 * The content record is held to "one representation, never both" (see {@link StoredFile}):
 * whichever of `bytes`/`files` the caller supplied wins and the other is cleared. Callers build
 * records by spreading an existing one, so a run that has just been collapsed to a ZIP would
 * otherwise keep its exploded entries alongside the bytes — twice the storage, and two answers to
 * what the file is.
 */
export async function putFile(
  identity: FileIdentity,
  content: Omit<StoredFile, "id">,
): Promise<void> {
  const record: StoredFile = content.files
    ? { id: identity.id, files: content.files }
    : { id: identity.id, bytes: content.bytes };
  await tx(FILES, "readwrite", (s) => s.put(record));
  await serializeCatalog(identity.id, async () => {
    const existing = await tx<StoredEntry | undefined>(CATALOG, "readonly", (s) =>
      s.get(identity.id),
    );
    await tx(CATALOG, "readwrite", (s) =>
      s.put({ modified: false, loaded: true, ...existing, ...identity } satisfies StoredEntry),
    );
  });
}

/**
 * Change part of a file's catalog record, leaving the rest as it stands — how the summary, the two
 * flags and the view are all written. A key set to `undefined` is **removed**, which is how
 * releasing a file drops its {@link StoredEntry.view}.
 *
 * A no-op for an id with no record, which can only mean the file was deleted mid-flight.
 */
export async function updateEntry(
  id: string,
  patch: Partial<Omit<StoredEntry, "id">>,
): Promise<void> {
  await serializeCatalog(id, async () => {
    const existing = await tx<StoredEntry | undefined>(CATALOG, "readonly", (s) => s.get(id));
    if (!existing) return;
    const next = { ...existing, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key];
    }
    await tx(CATALOG, "readwrite", (s) => s.put(next satisfies StoredEntry));
  });
}

/** The whole catalog — no archive bytes are read. This is the query the Files table is built on,
 * and the reason a browser holding thousands of files still starts instantly. */
export function getAllEntries(): Promise<StoredEntry[]> {
  return tx<StoredEntry[]>(CATALOG, "readonly", (s) => s.getAll());
}

/** One file's stored content, by id — the only way a file's content enters memory. Handed back as
 * the whole record so the caller can read whichever representation it was stored in (`bytes` or
 * `files`; see `fileContent.ts`'s `fromStoredContent`). Resolves to `undefined` for a file that
 * has since been deleted. */
export function getFileContent(id: string): Promise<StoredFile | undefined> {
  return tx<StoredFile | undefined>(FILES, "readonly", (s) => s.get(id));
}

export async function deleteFile(id: string): Promise<void> {
  await tx(FILES, "readwrite", (s) => s.delete(id));
  await tx(CATALOG, "readwrite", (s) => s.delete(id));
}
