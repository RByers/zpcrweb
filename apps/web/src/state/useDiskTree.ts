/**
 * The state behind the Files view's folder trees: which nodes are open, what each open node turned
 * out to contain, and when to go and look again.
 *
 * **Nothing is read until a node is opened.** A granted folder can be an entire lab archive, so
 * there is no recursive walk anywhere here — {@link listDirectory} reads one directory level, and
 * this hook calls it exactly once per node the user opens (or that the app opens on their behalf).
 * A folder with ten thousand files in a hundred subdirectories therefore costs one `entries()` call
 * to show, and nothing at all until the Files view is looked at.
 *
 * **What opens by itself comes from the catalog, not from disk.** On first sight of a folder the
 * hook opens the ancestors of the disk-backed files already in the catalog, so the files someone is
 * working on are in front of them and every other branch stays shut and unread. Deriving that from
 * the catalog — which is in memory already — is what keeps the promise above: the app never has to
 * search the disk to find out where to look.
 *
 * The cost of all this is that a file newly written into a folder doesn't announce itself. The tree
 * re-reads when the Files view is opened, when a node is expanded, and when the folder's ↻ is
 * pressed. Files that are *loaded* do refresh by themselves — those are watched individually
 * (`diskFolders.ts`), which is a per-file cost the app can afford and a per-tree one it cannot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addFolder as pickFolder,
  folderPermission,
  invalidateListings,
  listDirectory,
  listFolders,
  removeFolder,
  requestFolderPermission,
  retryFailedWatches,
  supportsDiskFolders,
  type DiskEntry,
} from "./diskFolders";
import type { DiskSource } from "./db";

/** One granted folder as the Files view needs it. */
export interface FolderView {
  label: string;
  permission: PermissionState;
}

/** What is known about one directory node, keyed by {@link nodeKey}. */
export interface DiskNode {
  entries: DiskEntry[] | null;
  /** A listing in flight — the node is open but hasn't come back yet. */
  pending: boolean;
  /** Why the listing failed, if it did. Usually a lapsed permission or a deleted directory. */
  error: string | null;
}

/** The identity of a directory node across all folders — the folder label and the path to it. */
export function nodeKey(label: string, path: readonly string[]): string {
  return JSON.stringify([label, ...path]);
}

export interface DiskTree {
  /** Whether this browser can do folders at all; false hides every folder affordance. */
  supported: boolean;
  folders: FolderView[];
  nodes: Map<string, DiskNode>;
  open: ReadonlySet<string>;
  toggle: (label: string, path: readonly string[]) => void;
  /**
   * The directory whose files are showing, per folder — the right-hand pane's subject. Each folder
   * keeps its own, so switching between two folders doesn't lose your place in either. Absent means
   * the folder's own root.
   */
  selected: ReadonlyMap<string, readonly string[]>;
  /** Show this directory's files. Lists it if it hasn't been read, exactly as expanding does. */
  select: (label: string, path: readonly string[]) => void;
  /** Folders whose body is hidden. Stacked folders would otherwise push each other off the pane. */
  collapsed: ReadonlySet<string>;
  toggleFolder: (label: string) => void;
  /** Re-read everything currently open in this folder. */
  refresh: (label: string) => void;
  /** Ask for a folder and add it. Must be called from a user gesture. */
  add: () => Promise<void>;
  /** Ask for a lapsed folder's permission back. Must be called from a user gesture. */
  grant: (label: string) => Promise<void>;
  remove: (label: string) => Promise<void>;
  error: string | null;
}

export function useDiskTree(
  /** Every disk-backed file in the catalog, loaded or not — what the initial expansion is derived
   * from. Only the loaded ones open their ancestors; a released file is in the catalog but isn't
   * what anybody is looking at. */
  loadedSources: DiskSource[],
  /** True while the Files view is on screen. Opening it is the app's "look at the disk again"
   * moment: cached listings are dropped and watches that had nothing to attach to try again. */
  active: boolean,
  /**
   * Called when a folder's permission is granted back. The files the app has open inside that
   * folder have been unreadable until this moment — a granted folder is exactly when they can be
   * read in — so this is what makes them come back without the user having to click each one
   * (`ZpcrStore.retryUnread`).
   */
  onGranted?: () => void,
): DiskTree {
  const supported = supportsDiskFolders();
  const [folders, setFolders] = useState<FolderView[]>([]);
  const [nodes, setNodes] = useState<Map<string, DiskNode>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /**
   * What has already been auto-opened, so re-rendering doesn't re-open a branch the user has since
   * closed. Tracked per folder (its root) *and* per file (its ancestors) rather than per folder
   * alone: the loaded files arrive from IndexedDB after the folder list does, so a per-folder mark
   * would be set while there was nothing yet to open, and the branch holding the file someone was
   * working on would never open at all on a reload.
   */
  const expanded = useRef(new Set<string>());

  const load = useCallback(async (label: string, path: readonly string[]) => {
    const key = nodeKey(label, path);
    setNodes((prev) => {
      const next = new Map(prev);
      next.set(key, { entries: prev.get(key)?.entries ?? null, pending: true, error: null });
      return next;
    });
    try {
      const entries = await listDirectory(label, path);
      setNodes((prev) => new Map(prev).set(key, { entries, pending: false, error: null }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setNodes((prev) => new Map(prev).set(key, { entries: null, pending: false, error: message }));
    }
  }, []);

  /** Every directory node currently on screen: the expanded ones plus each folder's selected one.
   * What a re-read has to cover. */
  const liveNodes = useCallback(
    () => new Set([...open, ...[...selected].map(([label, path]) => nodeKey(label, path))]),
    [open, selected],
  );

  const readFolders = useCallback(async () => {
    if (!supported) return;
    const stored = await listFolders();
    setFolders(
      await Promise.all(
        stored.map(async (f) => ({ label: f.label, permission: await folderPermission(f.label) })),
      ),
    );
  }, [supported]);

  useEffect(() => {
    void readFolders();
  }, [readFolders]);

  // Opening the Files view is the only routine chance the app gets to notice work done on disk
  // while it wasn't looking, since it deliberately doesn't watch directories.
  useEffect(() => {
    if (!active || !supported) return;
    invalidateListings();
    retryFailedWatches();
    void readFolders();
    // The expanded nodes *and* the selected ones: a directory picked for the file pane isn't
    // necessarily expanded in the tree, and it is the one whose contents are actually on screen.
    for (const key of liveNodes()) {
      const [label, ...path] = JSON.parse(key) as string[];
      void load(label!, path);
    }
    // Deliberately only on becoming active: re-running as `open` grows would re-read every node
    // on every expansion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, supported]);

  // A folder seen for the first time opens the branches holding the files already in use, and
  // nothing else. Derived from the catalog, so no directory is read to work out where to look.
  useEffect(() => {
    if (!supported) return;
    const known = new Set(folders.map((f) => f.label));
    const toOpen: string[] = [];
    /** Where each folder's file pane should start out. */
    const toSelect = new Map<string, readonly string[]>();
    for (const folder of folders) {
      const mark = `folder:${folder.label}`;
      if (expanded.current.has(mark)) continue;
      expanded.current.add(mark);
      toOpen.push(nodeKey(folder.label, []));
      toSelect.set(folder.label, []);
    }
    for (const source of loadedSources) {
      if (!known.has(source.folder)) continue;
      const mark = `file:${nodeKey(source.folder, source.path)}`;
      if (expanded.current.has(mark)) continue;
      expanded.current.add(mark);
      // Every directory between the folder root and the file, but not the file itself.
      for (let i = 1; i < source.path.length; i++) {
        toOpen.push(nodeKey(source.folder, source.path.slice(0, i)));
      }
      // …and land the file pane on the directory that file is actually in, so the work in progress
      // is what's showing rather than whatever happens to be at the top of the folder.
      toSelect.set(source.folder, source.path.slice(0, -1));
    }
    if (toOpen.length === 0) return;
    setOpen((prev) => new Set([...prev, ...toOpen]));
    setSelected((prev) => {
      const next = new Map(prev);
      for (const [label, path] of toSelect) next.set(label, path);
      return next;
    });
    for (const key of new Set([...toOpen, ...[...toSelect].map(([l, p]) => nodeKey(l, p))])) {
      const [label, ...path] = JSON.parse(key) as string[];
      void load(label!, path);
    }
  }, [folders, loadedSources, supported, load]);

  const select = useCallback(
    (label: string, path: readonly string[]) => {
      setSelected((prev) => new Map(prev).set(label, path));
      void load(label, path);
    },
    [load],
  );

  const toggleFolder = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const toggle = useCallback(
    (label: string, path: readonly string[]) => {
      const key = nodeKey(label, path);
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else {
          next.add(key);
          void load(label, path);
        }
        return next;
      });
    },
    [load],
  );

  const refresh = useCallback(
    (label: string) => {
      invalidateListings(label);
      retryFailedWatches();
      void readFolders();
      for (const key of liveNodes()) {
        const [keyLabel, ...path] = JSON.parse(key) as string[];
        if (keyLabel === label) void load(keyLabel, path);
      }
    },
    [liveNodes, load, readFolders],
  );

  const add = useCallback(async () => {
    try {
      setError(null);
      const folder = await pickFolder();
      if (folder) await readFolders();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [readFolders]);

  const grant = useCallback(
    async (label: string) => {
      try {
        setError(null);
        await requestFolderPermission(label);
        invalidateListings(label);
        retryFailedWatches();
        await readFolders();
        for (const key of liveNodes()) {
          const [keyLabel, ...path] = JSON.parse(key) as string[];
          if (keyLabel === label) void load(keyLabel, path);
        }
        onGranted?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [readFolders, liveNodes, load, onGranted],
  );

  const remove = useCallback(
    async (label: string) => {
      await removeFolder(label);
      for (const k of [...expanded.current]) {
        if (k === `folder:${label}` || k.startsWith(`file:["${label}"`)) expanded.current.delete(k);
      }
      setOpen((prev) => new Set([...prev].filter((k) => (JSON.parse(k) as string[])[0] !== label)));
      setSelected((prev) => {
        const next = new Map(prev);
        next.delete(label);
        return next;
      });
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(label);
        return next;
      });
      await readFolders();
    },
    [readFolders],
  );

  return {
    supported,
    folders,
    nodes,
    open,
    toggle,
    selected,
    select,
    collapsed,
    toggleFolder,
    refresh,
    add,
    grant,
    remove,
    error,
  };
}
