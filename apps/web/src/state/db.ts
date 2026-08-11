/**
 * Thin IndexedDB wrapper — no dependencies. Three stores:
 *
 * - `content` — the bytes, and nothing else. A record holds either a file's raw bytes or, for a run
 *   still being written to, its archive entries individually — see {@link StoredContent} and
 *   `fileContent.ts`, which owns that choice. **Records are read one file at a time**
 *   ({@link getContent}), never all at once, so a session opens by reading the catalog and then the
 *   files it names, rather than everything the browser has ever held.
 * - `catalog` — one small record per file ({@link StoredFile}): its identity, the
 *   {@link StoredFile.modified} flag, and its {@link StoredView} display state.
 * - `folders` — the directories the user has granted access to ({@link StoredFolder}). A handle is
 *   structured-cloneable, so keeping one here is how folder access survives a reload; see
 *   `state/diskFolders.ts`.
 *
 * **Everything here is an open file.** Closing a file in the app deletes its records outright
 * ({@link deleteFile}) — there is no third state between "open" and "gone", and so nothing here
 * describes a file the app isn't currently holding. See `apps/web/ARCHITECTURE.md`, "Open files and
 * the one selection".
 *
 * **A file whose bytes live on disk has no `content` records.** {@link FileIdentity.source} says a
 * file is backed by a real file inside one of those folders, and then this module holds only its
 * catalog row — the bytes are read from and written back to disk by `state/diskFolders.ts`. The one
 * exception is a run still being written to by the instrument, which buffers its plate reads here
 * until it completes and is then written to disk once; see `apps/web/ARCHITECTURE.md`,
 * "Disk-backed files and folders".
 *
 * **Why content is a separate store.** {@link getAllFiles} reads the whole catalog in one
 * `getAll()` — every file's name, size, kind and display state — and that read happens on startup,
 * before a single archive is touched. IndexedDB has no way to fetch part of a record, so a store
 * holding both would structured-clone every archive in the database on that call. That is the one
 * split worth keeping, and the reason everything *else* about a file lives together in `catalog`.
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
const DB_VERSION = 8;
const CONTENT = "content";
const CATALOG = "catalog";
const FOLDERS = "folders";

/**
 * The entry name a plain file's bytes are stored under — a `.pcrd`, a `.pltd`, a `.prcl.txt`,
 * anything that isn't an archive of its own.
 *
 * U+0000 because no name an instrument or a filesystem produces can contain it, and because it
 * sorts before every real entry name. To this module it is simply one entry name among the others;
 * `fileContent.ts` is the only place that assigns it meaning.
 */
export const WHOLE_FILE = "\0";

/**
 * A file's content: entry name → bytes. A `.zpcr` has one key per archive entry; everything else
 * has the single {@link WHOLE_FILE} key. This module never looks at which — see `fileContent.ts`.
 */
export type FileBytes = Record<string, Uint8Array>;

/**
 * Every content record belonging to one file.
 *
 * The upper bound is `[name, []]` rather than a high sentinel string: IndexedDB orders arrays after
 * every other key type, so an empty array exceeds `[name, <any string>]` exactly, without assuming
 * anything about what an entry may be called. `[name]` — the shorter array — sorts before
 * `[name, x]` for the same reason, so the range is closed at both ends and holds only this file.
 */
function fileRange(name: string): IDBKeyRange {
  return IDBKeyRange.bound([name], [name, []]);
}

/**
 * Bytes as they should be handed to IndexedDB.
 *
 * Structured clone copies a typed array's **entire underlying buffer**, not just the view, so a
 * `subarray` into a 1 MB buffer would silently store 1 MB. Views that span their whole buffer —
 * which is what every archive entry is — are handed over untouched.
 */
function normalize(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

type FileKindName = "zpcr" | "pcrd" | "biomeme" | "pltd" | "platecsv" | "prcltxt" | "alf";

/**
 * Where a disk-backed file actually is: which granted folder, and the path to it within that
 * folder. Its presence on a {@link FileIdentity} is the whole definition of "disk-backed".
 *
 * **Not an absolute path, and it cannot be.** The File System Access API never discloses one — a
 * directory handle knows its own leaf name (`runs`) and nothing above it. So `folder` is the label
 * the app gave the granted directory, which is its leaf name plus a `(2)` if two picked folders
 * collided, and the file's *name* is the two joined: `runs/2026-07/a.zpcr`. That name is still the
 * file's identity and its key here, exactly as for an uploaded file; it just has slashes in it.
 */
export interface DiskSource {
  /** The granted folder's label — {@link StoredFolder.label}. */
  folder: string;
  /** Path components from the folder root down to the file, the last being its file name. */
  path: string[];
}

/** The app's name for a disk-backed file: its folder label and path joined with `/`. The inverse
 * doesn't exist — a name can't be split back into a source, because a folder label may itself
 * contain a slash-free but otherwise arbitrary string, so the {@link DiskSource} is stored. */
export function diskFileName(source: DiskSource): string {
  return [source.folder, ...source.path].join("/");
}

/** One directory the user has granted the app access to. The handle is stored as itself: handles
 * are structured-cloneable, and a stored one comes back able to re-open the same directory — though
 * usually with its permission reset to `prompt`, which is why the UI has a "grant access" affordance
 * (see `state/diskFolders.ts`). */
export interface StoredFolder {
  /** The folder's label, unique across granted folders — its key here, and the first component of
   * every {@link DiskSource} beneath it. */
  label: string;
  handle: FileSystemDirectoryHandle;
  addedAt: number;
}

/** A file's identity — everything about it that is knowable without reading its bytes, and the
 * half of a {@link StoredFile} that {@link putFile} owns. */
export interface FileIdentity {
  /**
   * The file's name, and its key in both stores.
   *
   * The app has always required names to be unique — adding a file supersedes any file already
   * holding its name, `lib/cloneName.ts` invents `(2)`/`(3)` precisely to avoid a collision, and
   * `#file=` addresses a file by name — so a separate id was a second identity layered over one
   * the app already maintained. Worse, the id it derived hashed the file's *size*, which moves
   * whenever the content does: a run in progress took a new key on every plate read, and with it a
   * deleted record, a freshly written one, and the loss of everything else keyed by the old id.
   */
  name: string;
  /** The size the app reports for this file — its byte length when stored as
   * {@link StoredContent.bytes}, and the total of its entries when stored as {@link StoredContent.files}.
   * See `fileContent.ts`'s `contentSize`. */
  size: number;
  /** When the file was loaded into this browser, epoch ms. */
  addedAt: number;
  /** The source `File`'s own `lastModified` (its OS mtime, epoch ms) — when the file was last saved
   * to disk, as distinct from {@link addedAt}. A file the app rewrote in place keeps the original
   * mtime rather than claiming a new one. */
  lastModified: number;
  kind: FileKindName;
  /**
   * Set when this file's bytes live in a granted folder rather than in the `content` store — see
   * {@link DiskSource}. An edit to a disk-backed file is written back to the file on disk, so its
   * {@link StoredFile.modified} flag stays down: there is no second copy to go stale.
   */
  source?: DiskSource;
}

/**
 * One record in the `content` store: one named blob of bytes belonging to one file.
 *
 * This is the whole of what the store knows. A `.zpcr` still being written to has ~40 of these,
 * one per archive entry, which is what makes appending a plate read cost one small record instead
 * of rewriting the archive; a `.pcrd` has one, under {@link WHOLE_FILE}. The store cannot tell the
 * two apart and does not need to — "which representation is this" stopped being a field and became
 * "which entry names does this file happen to have".
 */
export interface StoredContent {
  name: string;
  entry: string;
  bytes: Uint8Array;
}

/**
 * A file's **display** state: which channels/wells/fluorophores are shown, log vs. linear, which
 * protocol step, whether to draw baselines. A per-person view onto a run — see
 * {@link StoredFile.view}.
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
 * One record per open file, holding everything the app can say about it **without reading its
 * bytes**. This is what a session is restored from ({@link getAllFiles}) before any archive is
 * read, so it must stay small: {@link view} is the largest thing on it.
 */
export interface StoredFile extends FileIdentity {
  /**
   * Whether this file's *content* has been edited since it was loaded (or since it was last
   * downloaded) — a threshold moved, the run renamed. Not display state, and it has to outlive a
   * reload: the edits themselves are already durable (in the archive's `zpcrweb.json`, in
   * IndexedDB), so what is at risk is the copy on the user's disk, which is stale until they
   * download again. See `useZpcrStore`'s `modifiedIds` and the file chip's two-stage close.
   */
  modified: boolean;
  /**
   * This file's display state — absent until the file's first display edit, since defaults need no
   * record. Closing the file deletes it along with everything else about the file, which is what
   * makes this the one part of a run's state that does *not* survive: everything that changes a
   * reported number lives in the archive instead (see the module comment), while which wells you
   * had hidden is a property of looking at the run rather than of the run.
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
      db.createObjectStore(CONTENT, { keyPath: ["name", "entry"] });
      db.createObjectStore(CATALOG, { keyPath: "name" });
      db.createObjectStore(FOLDERS, { keyPath: "label" });
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

/** In-flight writes, per file name — see {@link serializeWrites}. */
const writes = new Map<string, Promise<unknown>>();

/**
 * Run a write after any already in flight for the same file.
 *
 * Every write here is a read-modify-write — a catalog write merges into what is already stored —
 * and the app fires several at once on one file: an edit writes the modified flag and the view from
 * two places in the same tick. Without this, two of them could read the
 * same "before" record and the later write would silently undo the earlier one. Deletes and
 * renames join the same chain, or a delete racing a put would leave the row it just removed
 * resurrected by the put's merge. Per file, so unrelated files still write in parallel.
 */
function serializeWrites<T>(name: string, run: () => Promise<T>): Promise<T> {
  const result = (writes.get(name) ?? Promise.resolve()).then(run, run);
  // The chain must survive a rejection, or one failed write would wedge that file forever.
  const settled = result.then(
    () => {},
    () => {},
  );
  writes.set(name, settled);
  void settled.then(() => {
    if (writes.get(name) === settled) writes.delete(name);
  });
  return result;
}

/**
 * Write a file's content **and** its identity, so the two can never disagree about a file's name,
 * size or kind. Everything else on the catalog record — the modified flag, the view — belongs to
 * whoever last wrote it ({@link updateFile}) and is carried over untouched; a file being seen for
 * the first time starts unmodified, which is what opening a file means.
 *
 * Carrying the rest over is what lets a run in progress be re-put every cycle without losing the
 * display settings or the modified flag it accumulated — the record is the file's, not this
 * snapshot's. A *different* file arriving under a used name is a replacement rather than
 * another snapshot, and the store resets those fields explicitly (see `useZpcrStore`'s `install`).
 *
 * The content is written **a record per entry**, in one transaction: entries the file no longer has
 * are deleted, so a `.zpcr` can never be left holding an entry it dropped. What is already stored
 * is read back as *keys only* (`getAllKeys`), which clones no values and is what keeps this honest
 * about deletions even when the caller's idea of the file is stale.
 *
 * `changed` — `fileContent.ts`'s `changedEntries` — is what makes appending a plate read cost one
 * record instead of forty: an entry the store already has and the caller didn't touch is left
 * alone. It is an optimization and only an optimization. Existence comes from `getAllKeys`, so an
 * entry the store is missing is written whatever `changed` says, and omitting the argument writes
 * everything.
 */
export async function putFile(
  identity: FileIdentity,
  content: FileBytes,
  changed?: ReadonlySet<string>,
): Promise<void> {
  const entries = Object.entries(content);
  if (entries.length === 0) {
    // A file with no records reads back as deleted (see {@link getContent}), so refusing here beats
    // writing something that silently disappears. Nothing the app can produce is empty.
    throw new Error(`${identity.name}: refusing to store a file with no content`);
  }
  await serializeWrites(identity.name, async () => {
    await writeContent(identity.name, entries, changed);
    await writeIdentity(identity);
  });
}

/**
 * Write a file's identity alone, leaving the `content` store untouched — what a **disk-backed**
 * file's catalog row is written by, since its bytes are on the user's disk and there is nothing
 * here to keep in step with them.
 *
 * Same merge as {@link putFile}: the modified flag and the view belong to whoever last wrote them,
 * and a file seen for the first time starts unmodified.
 */
export async function putIdentity(identity: FileIdentity): Promise<void> {
  await serializeWrites(identity.name, () => writeIdentity(identity));
}

/** The catalog half of {@link putFile} and the whole of {@link putIdentity}. Callers hold the
 * per-file write lock. */
async function writeIdentity(identity: FileIdentity): Promise<void> {
  const existing = await tx<StoredFile | undefined>(CATALOG, "readonly", (s) =>
    s.get(identity.name),
  );
  await tx(CATALOG, "readwrite", (s) =>
    s.put({ modified: false, ...existing, ...identity } satisfies StoredFile),
  );
}

/**
 * The content half of {@link putFile}: one transaction holding every put and delete.
 *
 * The stale-key read and the writes it decides are issued from the same transaction — the puts go
 * out from `getAllKeys`'s own success handler rather than after an `await`, so there is no question
 * of the transaction having committed in between.
 */
function writeContent(
  name: string,
  entries: [string, Uint8Array][],
  changed?: ReadonlySet<string>,
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(CONTENT, "readwrite");
        const store = t.objectStore(CONTENT);
        const keys = store.getAllKeys(fileRange(name));
        keys.onsuccess = () => {
          const stored = new Set((keys.result as [string, string][]).map(([, entry]) => entry));
          for (const [entry, bytes] of entries) {
            const known = stored.delete(entry);
            // Already stored and untouched: leave the record alone. Anything the store doesn't
            // have is written regardless of what `changed` claims.
            if (known && changed && !changed.has(entry)) continue;
            store.put({ name, entry, bytes: normalize(bytes) } satisfies StoredContent);
          }
          for (const entry of stored) store.delete([name, entry]);
        };
        t.oncomplete = () => {
          resolve();
          db.close();
        };
        t.onerror = () => {
          reject(t.error);
          db.close();
        };
      }),
  );
}

/**
 * Change part of a file's catalog record, leaving the rest as it stands — how the modified flag and
 * the view are both written. A key set to `undefined` is **removed**.
 *
 * A no-op for a name with no record, which can only mean the file was deleted mid-flight.
 */
export async function updateFile(
  name: string,
  patch: Partial<Omit<StoredFile, "name">>,
): Promise<void> {
  await serializeWrites(name, async () => {
    const existing = await tx<StoredFile | undefined>(CATALOG, "readonly", (s) => s.get(name));
    if (!existing) return;
    const next = { ...existing, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key];
    }
    await tx(CATALOG, "readwrite", (s) => s.put(next satisfies StoredFile));
  });
}

/** The whole catalog — no archive bytes are read. This is the query a session is restored from:
 * the app knows what it is holding before it reads any of it. */
export function getAllFiles(): Promise<StoredFile[]> {
  return tx<StoredFile[]>(CATALOG, "readonly", (s) => s.getAll());
}

/**
 * One file's stored content, by name — the only way a file's content enters memory. Every record in
 * the file's range, reassembled into the map it was written from; `fileContent.ts` decides what the
 * entry names mean. Resolves to `undefined` for a file that has since been deleted.
 *
 * The arrays come back as IndexedDB handed them over, uncopied — see `fileContent.ts`'s note on
 * entry bytes never being mutated in place.
 */
export async function getContent(name: string): Promise<FileBytes | undefined> {
  const records = await tx<StoredContent[]>(CONTENT, "readonly", (s) => s.getAll(fileRange(name)));
  if (records.length === 0) return undefined;
  const content: FileBytes = {};
  for (const r of records) content[r.entry] = r.bytes;
  return content;
}

export async function deleteFile(name: string): Promise<void> {
  await serializeWrites(name, async () => {
    // One request: `delete` takes a key range, so a file's whole archive goes at once.
    await tx(CONTENT, "readwrite", (s) => s.delete(fileRange(name)));
    await tx(CATALOG, "readwrite", (s) => s.delete(name));
  });
}

/**
 * Drop a file's bytes but keep its catalog row — how a disk-backed run in progress lets go of the
 * buffer it accumulated once the finished run has been written to disk. The file goes on existing;
 * it is simply read from disk from now on. The one place a catalog row outlives its content, and
 * only because the bytes are on disk instead.
 */
export async function deleteContent(name: string): Promise<void> {
  await serializeWrites(name, async () => {
    await tx(CONTENT, "readwrite", (s) => s.delete(fileRange(name)));
  });
}

/** Every granted folder. Read once at startup by `state/diskFolders.ts`, which owns the handles
 * from then on. */
export function getFolders(): Promise<StoredFolder[]> {
  return tx<StoredFolder[]>(FOLDERS, "readonly", (s) => s.getAll());
}

export async function putFolder(folder: StoredFolder): Promise<void> {
  await tx(FOLDERS, "readwrite", (s) => s.put(folder));
}

/** Forget a granted folder. The files opened from it keep their catalog rows and stay open — they
 * are simply unreadable until the folder is granted again, which is the same state a file whose
 * permission lapsed is in. */
export async function deleteFolder(label: string): Promise<void> {
  await tx(FOLDERS, "readwrite", (s) => s.delete(label));
}

// A rename is a write under the new name followed by a delete of the old — see `useZpcrStore`'s
// `renameFile`, which does exactly that. It stays there rather than becoming a primitive here
// because the record it writes has to carry the file's *current* analysis settings, which only the
// store knows about.
//
// > **Future:** a rename moves the file's records only because the name is the key. An opaque id,
// > with the name kept as a catalog lookup, would make it a single catalog write — worth doing if
// > renames ever stop being rare, or once the schema is migrated rather than dropped.
