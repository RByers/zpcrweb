/**
 * Folders on the user's disk that the app has been granted read/write access to, and the files
 * inside them.
 *
 * Everywhere else in the app a file is a *copy*: uploaded, unpacked into IndexedDB, and stale on
 * disk from the first edit — which is what `db.ts`'s `StoredFile.modified` exists to nag about.
 * A file opened out of a granted folder is not a copy. Its bytes are read from disk when it is
 * loaded and written back to the same file when it changes, so the file on disk *is* the file.
 *
 * This module owns the handles and every operation on them; `db.ts` stores the folder handles,
 * `useZpcrStore` decides when to read and write, and `useDiskTree`/`FolderSection` present the
 * tree. It is a module singleton rather than a hook for the same reason `db.ts` is: the store needs
 * these primitives and shouldn't have to be handed them.
 *
 * ## Three deliberate shapes
 *
 * **Nothing is walked up front.** A picked folder can be an entire lab archive, so there is no
 * recursive scan anywhere in here. {@link listDirectory} reads exactly one directory level and
 * caches it; the tree calls it as the user opens nodes, and the app opens, by itself, only the
 * ancestors of files that are already loaded. The cost of that is that a file newly appearing on
 * disk doesn't announce itself — the tree learns about it when that level is next listed.
 *
 * **Watching is per file, never per tree.** {@link watchDiskFile} observes one loaded file. There
 * is no directory observation at all, recursive or otherwise, because that would mean caring about
 * a whole subtree the app has deliberately not read.
 *
 * **A watch has to re-arm itself.** Deleting an observed file emits `disappeared` and then
 * `errored`, after which the observation is *dead* — recreating the same path delivers nothing.
 * An external tool saving atomically (write a temp file, rename it over the original) looks exactly
 * like delete-then-recreate, so a watch that doesn't re-observe silently stops working after the
 * first such save. Measured against Chrome 151; see {@link rearmWatch}.
 */

import { matchesSupportedExtension } from "@zpcrweb/core";
import {
  deleteFolder as deleteStoredFolder,
  getFolders,
  putFolder,
  type DiskSource,
  type StoredFolder,
} from "./db";
import { cloneFileName } from "../lib/cloneName";

export { diskFileName, type DiskSource } from "./db";

/** Whether this browser can do any of this. Everything folder-related in the UI is gated on it. */
export function supportsDiskFolders(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

/** Whether this browser can notice a loaded file changing underneath it. Folders still work
 * without it; the app just doesn't refresh by itself. */
export function supportsDiskWatching(): boolean {
  // `typeof` on a bare identifier is the one form that doesn't throw when the global is absent,
  // which it is on every browser that hasn't shipped the observer yet.
  return typeof FileSystemObserver === "function";
}

// ── The granted folders ──────────────────────────────────────────────────────────────────

/** Label → handle, the live copy of the `folders` store. Hydrated once, then authoritative. */
const folders = new Map<string, StoredFolder>();
let hydrated: Promise<void> | null = null;

/** Read the granted folders out of IndexedDB, once per page. Every entry point awaits this, so
 * callers never have to think about ordering. */
function hydrate(): Promise<void> {
  hydrated ??= (async () => {
    if (!supportsDiskFolders()) return;
    for (const folder of await getFolders()) folders.set(folder.label, folder);
  })();
  return hydrated;
}

/** The granted folders, oldest first — what the Files view lists a section for. */
export async function listFolders(): Promise<StoredFolder[]> {
  await hydrate();
  return [...folders.values()].sort((a, b) => a.addedAt - b.addedAt);
}

/**
 * Ask for a folder, and remember it.
 *
 * Resolves to the new folder, or `null` if the user dismissed the picker — a dismissal is an
 * answer, not an error, so it isn't thrown. **Nothing is read here**: granting access to a folder
 * of any size is one round trip.
 *
 * The label is the directory's own name, made unique with the same `(2)`/`(3)` counter the Clone
 * button uses, because two folders called `runs` in different places are a perfectly ordinary
 * thing to pick and the label is the first component of every file name beneath it.
 */
export async function addFolder(): Promise<StoredFolder | null> {
  await hydrate();
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker!({ id: "zpcrweb", mode: "readwrite", startIn: "documents" });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
  for (const existing of folders.values()) {
    // Re-picking a folder already granted re-grants it rather than adding a twin, which is what
    // the user means when they pick it again after a permission lapse.
    if (await existing.handle.isSameEntry(handle)) {
      const refreshed = { ...existing, handle };
      folders.set(refreshed.label, refreshed);
      await putFolder(refreshed);
      return refreshed;
    }
  }
  const label = folders.has(handle.name)
    ? cloneFileName(handle.name, (candidate) => folders.has(candidate))
    : handle.name;
  const folder: StoredFolder = { label, handle, addedAt: Date.now() };
  folders.set(label, folder);
  await putFolder(folder);
  return folder;
}

/** Forget a folder. Files opened from it keep their catalog rows — they simply become unreadable,
 * the same state a file whose permission lapsed is in — and their watches stop. */
export async function removeFolder(label: string): Promise<void> {
  await hydrate();
  folders.delete(label);
  for (const key of [...listings.keys()]) if (keyFolder(key) === label) listings.delete(key);
  for (const [name, watch] of [...watches]) {
    if (watch.source.folder === label) {
      watch.observer?.disconnect();
      window.clearTimeout(watch.rearmTimer);
      watches.delete(name);
    }
  }
  await deleteStoredFolder(label);
}

/**
 * Whether the app may currently read and write a folder.
 *
 * A handle restored from IndexedDB usually comes back as `prompt` — the grant does not survive a
 * reload unless the origin is an installed app the user has given persistent permission to. That is
 * why the folder's header has a button rather than the app silently re-asking: `requestPermission`
 * needs a user gesture, and the click supplies one.
 */
export async function folderPermission(label: string): Promise<PermissionState> {
  await hydrate();
  const folder = folders.get(label);
  if (!folder) return "denied";
  return (await folder.handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
}

/** Ask for a lapsed folder's permission back. Must be called from a user gesture. */
export async function requestFolderPermission(label: string): Promise<PermissionState> {
  await hydrate();
  const folder = folders.get(label);
  if (!folder) return "denied";
  return (await folder.handle.requestPermission?.({ mode: "readwrite" })) ?? "granted";
}

// ── Listing, one level at a time ─────────────────────────────────────────────────────────

/** One row in a directory listing. A directory carries no child count: counting would mean
 * descending into it, which is the whole thing this module avoids. */
export interface DiskEntry {
  name: string;
  kind: "file" | "directory";
  /** Files only. */
  size?: number;
  /** Files only — the file's mtime, epoch ms. */
  lastModified?: number;
}

const listings = new Map<string, DiskEntry[]>();

const cacheKey = (label: string, path: readonly string[]): string =>
  JSON.stringify([label, ...path]);
const keyFolder = (key: string): string => (JSON.parse(key) as string[])[0]!;

/**
 * The contents of one directory: its subdirectories, and the files in it the app could open.
 *
 * Exactly one level. Results are cached until {@link invalidateListings}, so re-opening a node the
 * user has already looked at costs nothing. Files are filtered by name only — a `.txt` that turns
 * out not to be a protocol is rejected later, when something tries to decode it.
 */
export async function listDirectory(label: string, path: readonly string[]): Promise<DiskEntry[]> {
  await hydrate();
  const key = cacheKey(label, path);
  const cached = listings.get(key);
  if (cached) return cached;
  const dir = await resolveDirectory(label, path);
  const entries: DiskEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    // Dot-entries are the OS's business, not the user's — and `.git`, `.Trash` and the like are
    // exactly the directories an accidental scan would get lost in.
    if (name.startsWith(".")) continue;
    if (handle.kind === "directory") {
      entries.push({ name, kind: "directory" });
    } else if (matchesSupportedExtension(name)) {
      const file = await (handle as FileSystemFileHandle).getFile();
      entries.push({ name, kind: "file", size: file.size, lastModified: file.lastModified });
    }
  }
  entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.kind === "directory"
        ? -1
        : 1,
  );
  listings.set(key, entries);
  return entries;
}

/** Drop cached listings so the next {@link listDirectory} re-reads. With no `label`, drops
 * everything; with one, just that folder's. This is what the ↻ button and a re-opened Files view
 * call — the app has no other way to notice a file appearing on disk, having chosen not to watch
 * directories. */
export function invalidateListings(label?: string): void {
  if (label === undefined) listings.clear();
  else for (const key of [...listings.keys()]) if (keyFolder(key) === label) listings.delete(key);
}

// ── Reading and writing a file ───────────────────────────────────────────────────────────

async function resolveDirectory(
  label: string,
  path: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  await hydrate();
  const folder = folders.get(label);
  if (!folder) throw new Error(`no folder named ${label} — it may have been removed`);
  let dir = folder.handle;
  for (const part of path) dir = await dir.getDirectoryHandle(part);
  return dir;
}

async function resolveFile(source: DiskSource): Promise<FileSystemFileHandle> {
  const dir = await resolveDirectory(source.folder, source.path.slice(0, -1));
  return dir.getFileHandle(source.path.at(-1)!);
}

/** A disk-backed file's bytes and mtime, read straight off disk. */
export async function readDiskFile(
  source: DiskSource,
): Promise<{ bytes: Uint8Array; lastModified: number }> {
  const file = await (await resolveFile(source)).getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), lastModified: file.lastModified };
}

/**
 * What the app's own last write to each file produced. A watch compares against this to tell its
 * own echo from a real external change — writing through `createWritable` fires `modified` (and,
 * for a file that didn't exist, `appeared` first), and acting on that would mean re-reading the
 * file the app just wrote, forever.
 */
const echo = new Map<string, { size: number; lastModified: number }>();

/** Write a disk-backed file, replacing it. Returns the mtime it ended up with. */
export async function writeDiskFile(source: DiskSource, bytes: Uint8Array): Promise<number> {
  const handle = await resolveFile(source);
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as unknown as BufferSource);
  } catch (e) {
    await writable.abort();
    throw e;
  }
  await writable.close();
  const written = await handle.getFile();
  echo.set(echoKey(source), { size: written.size, lastModified: written.lastModified });
  // The file's size and mtime both moved, so any cached listing that mentions it is now wrong.
  listings.delete(cacheKey(source.folder, source.path.slice(0, -1)));
  return written.lastModified;
}

const echoKey = (source: DiskSource): string => cacheKey(source.folder, source.path);

// ── Watching one loaded file ─────────────────────────────────────────────────────────────

/** What a watch reports. `changed` means re-read it; `missing` means the file is gone and the app
 * should stop expecting it (the watch keeps trying to re-attach, so a file that comes back is
 * picked up). */
export type DiskFileEvent = "changed" | "missing";

interface Watch {
  source: DiskSource;
  notify: (event: DiskFileEvent) => void;
  observer: FileSystemObserver | null;
  rearmTimer: number | undefined;
}

const watches = new Map<string, Watch>();

/** How long to wait before re-attaching after the observed file vanishes. Long enough for the
 * rename half of an atomic save to land, short enough not to be noticed. */
const REARM_DELAY_MS = 300;

/**
 * Watch one loaded file for changes made outside the app, by anything at all — another program, a
 * sync client, the user's editor.
 *
 * Keyed by `name` so re-watching the same file replaces its watch rather than stacking a second
 * one. A no-op on a browser without `FileSystemObserver`.
 */
export function watchDiskFile(
  name: string,
  source: DiskSource,
  notify: (event: DiskFileEvent) => void,
): void {
  if (!supportsDiskWatching()) return;
  unwatchDiskFile(name);
  const watch: Watch = { source, notify, observer: null, rearmTimer: undefined };
  watches.set(name, watch);
  void attachWatch(name, watch);
}

export function unwatchDiskFile(name: string): void {
  const watch = watches.get(name);
  if (!watch) return;
  watch.observer?.disconnect();
  window.clearTimeout(watch.rearmTimer);
  watches.delete(name);
}

async function attachWatch(name: string, watch: Watch): Promise<void> {
  let handle: FileSystemFileHandle;
  try {
    handle = await resolveFile(watch.source);
  } catch {
    // The file isn't there (or the folder's permission has lapsed). Nothing to observe, and no
    // point retrying on a timer — `retryFailedWatches` picks it up next time the tree is looked at.
    watch.notify("missing");
    return;
  }
  const observer = new FileSystemObserver((records) => {
    void handleRecords(name, records);
  });
  try {
    await observer.observe(handle);
  } catch {
    watch.notify("missing");
    return;
  }
  // A `watchDiskFile` that landed while this was awaiting has already replaced us.
  if (watches.get(name) !== watch) {
    observer.disconnect();
    return;
  }
  watch.observer = observer;
}

async function handleRecords(name: string, records: FileSystemChangeRecord[]): Promise<void> {
  const watch = watches.get(name);
  if (!watch) return;
  // `disappeared` is always followed by `errored`, and the observation is dead either way, so the
  // re-arm is what matters and it only needs doing once per batch.
  if (records.some((r) => r.type === "disappeared" || r.type === "errored")) {
    rearmWatch(name, watch);
    return;
  }
  if (!records.some((r) => r.type === "modified" || r.type === "appeared" || r.type === "moved")) {
    return;
  }
  if (await isOwnWrite(watch.source)) return;
  watch.notify("changed");
}

/** Whether the file on disk is exactly what the app last wrote there — see {@link echo}. */
async function isOwnWrite(source: DiskSource): Promise<boolean> {
  const mine = echo.get(echoKey(source));
  if (!mine) return false;
  try {
    const file = await (await resolveFile(source)).getFile();
    return file.size === mine.size && file.lastModified === mine.lastModified;
  } catch {
    return false;
  }
}

/**
 * Re-attach a watch whose file was deleted, and tell the store to re-read.
 *
 * The observation is already dead by the time this runs — that is what `errored` means — so this is
 * not an optimization. Without it, one atomic save from any external tool (write temp, rename over)
 * ends the watch for the rest of the session, and the app would go on showing stale contents while
 * looking like it was watching.
 */
function rearmWatch(name: string, watch: Watch): void {
  watch.observer?.disconnect();
  watch.observer = null;
  window.clearTimeout(watch.rearmTimer);
  watch.rearmTimer = window.setTimeout(() => {
    void (async () => {
      if (watches.get(name) !== watch) return;
      await attachWatch(name, watch);
      // Attaching only tells us the file is back; its contents are whatever the save wrote.
      if (watch.observer) watch.notify("changed");
    })();
  }, REARM_DELAY_MS);
}

/** Re-attach every watch that has no observer — a file that was missing when it was last tried, or
 * whose folder's permission has since been granted. Called when the Files view is opened, which is
 * the app's general "look at the disk again" moment. */
export function retryFailedWatches(): void {
  for (const [name, watch] of watches) if (!watch.observer) void attachWatch(name, watch);
}
