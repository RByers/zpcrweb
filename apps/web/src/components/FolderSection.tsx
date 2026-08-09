/**
 * The folders in the lower half of the Files view: **one tree column, one file column**. Every
 * folder the user has granted is a group in the left column — a heading carrying its name and its
 * own ↻ and ✕, then its directory tree — with the app's own bundled `samples` last. The right
 * column shows the files of whichever directory is picked, wherever it was picked from.
 *
 * **One file column, not one per folder.** A folder is picked, a directory inside it is picked, and
 * the right column answers "what is in there" — which is what lets the left column be a single
 * scrolling list of every folder at once. Five granted folders then cost five headings rather than
 * five stacked panes with five scrollbars. Which folder the column is showing is
 * `DiskTree.activeFolder`; which directory inside it is `DiskTree.selected`, still kept per folder
 * so a folder that opened itself on the branch holding your work (see `useDiskTree.ts`) keeps that
 * branch marked in the tree while you read another folder.
 *
 * This is the *disk*, not the app: it lists what is in the folder, whether or not the app has ever
 * opened it. **A file's checkbox is whether it is open** — ticking one reads it off disk and opens
 * it, unticking one closes it again, and closing is all it is: nothing on disk is touched. This is
 * the only place a file is opened out of a folder. Files opened here are written back to the same
 * file on disk when they change, which is the whole point of granting the folder
 * (`state/diskFolders.ts`).
 *
 * **Two columns, one when it doesn't fit.** Side by side the tree stays put while you look through
 * a directory, which is what makes a folder of a hundred subdirectories navigable at all. Below a
 * container width the same two columns stack — tree above, files below — rather than the app
 * growing a second, differently-behaved narrow layout. There is one interaction model either way:
 * click a directory to see its files, click its chevron to open it in the tree. Each column scrolls
 * on its own, so a long tree and a long directory don't fight over one scrollbar.
 *
 * **Click opens or closes, double-click goes there** — and the reason a row here behaves
 * differently from a row of the catalog table above it. Browsing a folder means clicking through a
 * lot of files to decide which ones you want the app to hold; if the first click left for that
 * file's own view every time, the tree would throw you out of the folder you are reading. So a
 * click here is the checkbox — it ticks the file open, or unticks it closed — and stays put, and a
 * double-click on a file the app hasn't got open opens it *and* goes to it. Closing is the safe
 * half of that: these files are written back to disk as they change, so an unticked file has lost
 * nothing.
 *
 * The click acts at once rather than waiting to find out whether a second one is coming, so the
 * two gestures compose rather than one deferring to the other: the first click of a double-click
 * has already ticked the file, and the `dblclick` only follows it to the file's Overview. Which
 * means **double-clicking a file that is already open just closes it** — the click unticks it, and
 * there is then nothing to go to. That is the honest consequence of an instant checkbox, and the
 * gesture that matters is the other one, on a file you are opening for the first time.
 *
 * **The type chips narrow the file column** (`KindFilter.tsx`), one per kind of file the directory
 * holds. This is where a type filter earns its place rather than over the catalog: the column is a
 * directory on disk, it can be very long, and the job it exists for is finding the file to open out
 * of it. A directory's kinds are read from the file *names* (`fileKindFromName`) — nothing here has
 * been opened, and a name is all a listing knows.
 *
 * **A closed branch has not been read.** The tree lists lazily, one directory level per expansion,
 * because a folder handed to the app may hold a career's worth of runs. What opens by itself is only
 * the branch containing files that are already loaded, and the file pane starts on that directory.
 * That is also why a directory row shows no file count — counting would mean descending into it.
 *
 * The consequence, worth knowing while reading this: a file written into the folder by something
 * else won't appear on its own. The ↻ re-reads. (Files that are *loaded* do refresh by themselves;
 * those are watched one by one.)
 *
 * **The bundled samples are the same group, three things fewer.** The app ships a folder of
 * example files (`lib/samples.ts`), and it is drawn here rather than in a panel of its own so there
 * is one folder UI to learn and one to maintain. Being built in rather than on disk, it has no ↻
 * (its listing is fixed at build time), no ✕ (it is part of the app), and no tree under its heading
 * (it is flat, so the heading is the whole group). It always keeps the name `samples`; a granted
 * folder picked under that name gets the `(2)` instead, so no two groups in the pane ever share a
 * label. Everything else — the checkbox that opens a file, the click/double-click pair, the
 * selected row, the `samples/`-rooted name the file is filed under — is the same code doing the
 * same thing. The one difference a user can feel is what opening one gives them: a *copy*, like a
 * dropped file, since there is no writing back to a file inside the app's own bundle.
 */
import { useRef, useState } from "react";
import { fileKindDescription, fileKindFromName, type FileKind } from "@zpcrweb/core";
import type { DiskSource } from "../state/db";
import type { DiskTree } from "../state/useDiskTree";
import { nodeKey } from "../state/useDiskTree";
import { diskFileName } from "../state/diskFolders";
import type { DiskEntry } from "../state/diskFolders";
import type { FileEntry } from "../state/useZpcrStore";
import { formatCompactDateTime } from "../lib/experiment";
import { FileKindIcon } from "./FileIcons";
import { countKinds, KindFilter } from "./KindFilter";
import { FolderIcon } from "./ViewIcons";
import { sampleFileName } from "../lib/samples";

interface Props {
  tree: DiskTree;
  /** The open files, so a row can tell "in the app" from "on disk only". */
  entries: FileEntry[];
  /** Close a file the app has open — see `ZpcrStore.closeFile`. */
  onCloseFile: (id: string) => void | Promise<void>;
  /** The selection — opening a file makes it the selected one, and its row says so. */
  activeName: string | null;
  /** Open files straight off disk. Resolves once they are open, which is what lets a double-click
   * wait for its own first click before going to the file. `goToFile` also lands on the file's
   * Overview — used where the app is doing the opening rather than a gesture. */
  onAddDiskFiles: (sources: DiskSource[], goToFile?: boolean) => void | Promise<void>;
  /** The same thing for a bundled sample, which is fetched rather than read off disk and lands as
   * an ordinary copy — under `samples/<name>`, like any other folder's file. See `lib/samples.ts`.
   * Called with the plain file names; the prefix is the store's business. */
  onAddSampleFiles: (names: string[], goToFile?: boolean) => void | Promise<void>;
  /** Select it *and* go look at it, on whichever view that kind of file is for (`App.tsx`'s
   * `defaultViewFor`) — a double click. */
  onOpenFile: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FolderSection({
  tree,
  entries,
  activeName,
  onCloseFile,
  onAddDiskFiles,
  onAddSampleFiles,
  onOpenFile,
}: Props) {
  const shown = tree.folders.find((f) => f.label === tree.activeFolder) ?? null;
  const shownPath = shown ? (tree.selected.get(shown.label) ?? []) : [];
  /** Which kinds the file column is narrowed to; empty is the whole listing. Held here rather than
   * in the column itself so it survives walking into another directory — hunting for the one
   * `.pltd` in a folder is a hunt across its subdirectories, not within one of them. */
  const [kinds, setKinds] = useState<ReadonlySet<FileKind>>(new Set());
  const toggleKind = (kind: FileKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });
  return (
    <div className="folders">
      <div className="folders__pane folders__pane--tree">
        {tree.folders.map((folder) => {
          const isOpen = !tree.collapsed.has(folder.label);
          const selected = tree.selected.get(folder.label) ?? [];
          const isShowing = folder.label === tree.activeFolder;
          return (
            <section
              className={"folders__folder" + (folder.builtin ? " folders__folder--builtin" : "")}
              key={folder.label}
            >
              {/* Not a <details>/<summary>: the heading carries three separate actions — collapse
                  the group, select the folder's own root, and the buttons on the right — and a
                  <summary> would swallow all of them into "toggle". */}
              <div className="folders__head">
                <button
                  className="folders__collapse"
                  aria-expanded={isOpen}
                  title={isOpen ? "Collapse this folder" : "Expand this folder"}
                  onClick={() => tree.toggleFolder(folder.label)}
                >
                  <span className={"rail__chevron" + (isOpen ? " is-open" : "")} aria-hidden="true">
                    ▸
                  </span>
                </button>
                <button
                  className={
                    "folders__title mono" + (isShowing && selected.length === 0 ? " is-selected" : "")
                  }
                  title={
                    folder.builtin
                      ? "Example files that come with the app"
                      : `Show the files directly in ${folder.label}`
                  }
                  onClick={() => tree.select(folder.label, [])}
                >
                  <span className="folders__icon">
                    <FolderIcon />
                  </span>
                  {folder.label}
                </button>
                <span className="folders__actions">
                  {/* Nothing to re-read and nothing to give up: the bundled folder's listing is
                      fixed when the app is built, and it is part of the app. */}
                  {!folder.builtin && folder.permission !== "granted" && (
                    /* The grant does not survive a reload unless the browser has been told to keep
                       it, so this is the ordinary state on a fresh session rather than an error.
                       A button because re-asking needs a user gesture. */
                    <button
                      className="btn btn--sm btn--primary"
                      onClick={() => void tree.grant(folder.label)}
                    >
                      Grant access
                    </button>
                  )}
                  {!folder.builtin && (
                    <>
                      <button
                        className="btn btn--sm"
                        title="Read this folder again"
                        onClick={() => tree.refresh(folder.label)}
                      >
                        ↻
                      </button>
                      <button
                        className="btn btn--sm"
                        title="Stop using this folder. Nothing on disk is deleted."
                        onClick={() => void tree.remove(folder.label)}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </span>
              </div>
              {isOpen &&
                (folder.permission === "granted"
                  ? /* No tree under the bundled folder: it is one flat directory, and a branch
                       whose only content would be "no subfolders" is one worth not drawing. */
                    !folder.builtin && (
                      <div className="folders__tree">
                        <DirectoryLevel
                          tree={tree}
                          label={folder.label}
                          path={[]}
                          depth={0}
                          selected={isShowing ? selected : null}
                        />
                      </div>
                    )
                  : (
                    <div className="folders__note mono">
                      This browser needs permission again before it can read this folder.
                    </div>
                  ))}
            </section>
          );
        })}
        {tree.error && <div className="folders__note folders__note--error mono">{tree.error}</div>}
      </div>
      {/* One file column for every folder: whichever directory is picked on the left, whichever
          folder it belongs to. */}
      <div className="folders__pane folders__pane--files">
        {shown == null ? (
          <div className="folders__note mono">Pick a folder to see what is in it.</div>
        ) : shown.permission !== "granted" ? (
          <div className="folders__note mono">
            This browser needs permission again before it can read {shown.label}.
          </div>
        ) : (
          <FilePane
            tree={tree}
            label={shown.label}
            path={shownPath}
            builtin={shown.builtin}
            kinds={kinds}
            onToggleKind={toggleKind}
            entries={entries}
            activeName={activeName}
            onCloseFile={onCloseFile}
            onAddDiskFiles={onAddDiskFiles}
            onAddSampleFiles={onAddSampleFiles}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </div>
  );
}

const indent = (depth: number): number => 8 + depth * 13;

/** The subdirectories of one directory — the tree column's recursive half. Files are not here; they
 * are the other column's job. */
function DirectoryLevel({
  tree,
  label,
  path,
  depth,
  selected,
}: {
  tree: DiskTree;
  label: string;
  path: string[];
  depth: number;
  /** The directory the file column is showing, or null when that column is showing some *other*
   * folder — in which case no row in this tree is the one on screen, and none is marked. */
  selected: readonly string[] | null;
}) {
  const node = tree.nodes.get(nodeKey(label, path));
  const dirs = node?.entries?.filter((e) => e.kind === "directory") ?? [];
  if (node?.error) {
    return (
      <div className="folders__note folders__note--error mono" style={{ paddingLeft: indent(depth) }}>
        {node.error}
      </div>
    );
  }
  if (!node?.entries) {
    return node?.pending ? (
      <div className="folders__note mono" style={{ paddingLeft: indent(depth) }}>
        reading…
      </div>
    ) : null;
  }
  if (dirs.length === 0) {
    // Only said at the top level; deeper down an empty branch is just a leaf, and saying so on
    // every one of them would be noise.
    return depth === 0 ? (
      <div className="folders__note mono" style={{ paddingLeft: indent(depth) }}>
        no subfolders
      </div>
    ) : null;
  }
  return (
    <ul className="folders__list">
      {dirs.map((entry) => {
        const childPath = [...path, entry.name];
        const key = nodeKey(label, childPath);
        const isOpen = tree.open.has(key);
        const isSelected = selected != null && key === nodeKey(label, selected);
        return (
          <li key={entry.name}>
            <div
              className={"folders__dirrow" + (isSelected ? " is-selected" : "")}
              style={{ paddingLeft: indent(depth) }}
            >
              <button
                className="folders__twisty"
                aria-expanded={isOpen}
                aria-label={isOpen ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
                onClick={() => tree.toggle(label, childPath)}
              >
                <span className={"rail__chevron" + (isOpen ? " is-open" : "")} aria-hidden="true">
                  ▸
                </span>
              </button>
              {/* The name selects; the chevron beside it opens. Two targets because they are two
                  questions — "what is in here?" and "what is under here?" — and answering the
                  first by also opening the branch is what makes a deep tree unfold as you dig. */}
              <button
                className="folders__dir mono"
                onClick={() => {
                  tree.select(label, childPath);
                  if (!isOpen) tree.toggle(label, childPath);
                }}
              >
                {entry.name}
              </button>
            </div>
            {isOpen && (
              <DirectoryLevel
                tree={tree}
                label={label}
                path={childPath}
                depth={depth + 1}
                selected={selected}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The files of the selected directory, with a breadcrumb saying which one that is. */
function FilePane({
  tree,
  label,
  path,
  builtin,
  kinds,
  onToggleKind,
  entries,
  activeName,
  onCloseFile,
  onAddDiskFiles,
  onAddSampleFiles,
  onOpenFile,
}: {
  tree: DiskTree;
  label: string;
  path: readonly string[];
  builtin: boolean;
  /** The type filter — see {@link FolderSection}. */
  kinds: ReadonlySet<FileKind>;
  onToggleKind: (kind: FileKind) => void;
} & Omit<Props, "tree">) {
  const node = tree.nodes.get(nodeKey(label, path));
  const files = node?.entries?.filter((e) => e.kind === "file") ?? [];
  // What kinds this directory holds, from the file names — nothing here has been read, and the
  // name is all a listing knows (`fileKindFromName`). A chip per kind, and only when there is more
  // than one to tell apart.
  const counts = countKinds(files, (e) => fileKindFromName(e.name));
  // The filter as it applies to *this* directory: it is kept while you move between directories,
  // so a kind absent from the one you are in now must not empty the list with no chip left to
  // turn off. The choice itself is kept, so walking back into a directory that has them restores
  // it.
  const present = new Set(counts.map(([k]) => k));
  const on = new Set([...kinds].filter((k) => present.has(k)));
  const visible =
    on.size === 0
      ? files
      : files.filter((e) => {
          const kind = fileKindFromName(e.name);
          return kind != null && on.has(kind);
        });
  return (
    <>
      {/* Which directory this column is showing — its folder's own name included, since the
          heading that says it is over in the other column now. Every ancestor is a way back up,
          which is the only navigation the file column needs. */}
      <div className="folders__crumbs mono">
        <button className="folders__crumb" onClick={() => tree.select(label, [])}>
          {label}
        </button>
        {path.map((part, i) => (
          <span key={i}>
            <span className="folders__crumbsep" aria-hidden="true">
              /
            </span>
            <button
              className="folders__crumb"
              onClick={() => tree.select(label, path.slice(0, i + 1))}
            >
              {part}
            </button>
          </span>
        ))}
      </div>
      {/* Only worth drawing when there is more than one kind here to tell apart. */}
      {counts.length > 1 && <KindFilter counts={counts} on={on} onToggle={onToggleKind} />}
      {node?.error ? (
        <div className="folders__note folders__note--error mono">{node.error}</div>
      ) : !node?.entries ? (
        <div className="folders__note mono">{node?.pending ? "reading…" : ""}</div>
      ) : files.length === 0 ? (
        <div className="folders__note mono">nothing here the app can open</div>
      ) : visible.length === 0 ? (
        <div className="folders__note mono">nothing of that type here</div>
      ) : (
        <ul className="folders__list">
          {visible.map((entry) => (
            <FileRow
              key={entry.name}
              label={label}
              path={path}
              entry={entry}
              builtin={builtin}
              entries={entries}
              activeName={activeName}
              onCloseFile={onCloseFile}
              onAddDiskFiles={onAddDiskFiles}
              onAddSampleFiles={onAddSampleFiles}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function FileRow({
  label,
  path,
  entry,
  builtin,
  entries,
  activeName,
  onCloseFile,
  onAddDiskFiles,
  onAddSampleFiles,
  onOpenFile,
}: {
  label: string;
  path: readonly string[];
  entry: DiskEntry;
  builtin: boolean;
} & Omit<Props, "tree">) {
  const source: DiskSource = { folder: label, path: [...path, entry.name] };
  // Either way the file is known by its folder-rooted path. For a disk file that path *is* the
  // file; for a sample it is only where the copy came from, but everything in the app is keyed by
  // name, and a sample under its bare name would replace a file of that name someone had dropped
  // in themselves (`lib/samples.ts`).
  const name = builtin ? sampleFileName(entry.name) : diskFileName(source);
  const open = entries.find((e) => e.name === name);
  // What the click of this gesture did: which way it left the file, and when that has finished.
  // A `dblclick` arrives after its own two clicks have been handled and after `open` was last
  // rendered, so it has nothing else to go on.
  const gesture = useRef<{ open: boolean; settled: Promise<unknown> } | null>(null);

  // Exactly what the checkbox does, and for the same reason: opening reads and decodes the file
  // (which is also what tells the app what kind of file it is), closing lets go of it and leaves
  // the file on disk exactly as it is.
  const toggleLoaded = () => {
    gesture.current = open
      ? { open: false, settled: Promise.resolve(onCloseFile(name)) }
      : {
          open: true,
          settled: Promise.resolve(
            builtin ? onAddSampleFiles([entry.name]) : onAddDiskFiles([source]),
          ),
        };
  };

  return (
    <li>
      <div
        className={
          "folders__file" + (open ? " is-loaded" : "") + (name === activeName ? " is-selected" : "")
        }
      >
        <input
          type="checkbox"
          className="folders__check"
          checked={!!open}
          title={
            open
              ? builtin
                ? "Close this file. The example itself stays here."
                : "Close this file. Nothing on disk is deleted."
              : "Open this file"
          }
          aria-label={open ? `Close ${entry.name}` : `Open ${entry.name}`}
          onChange={toggleLoaded}
        />
        <span className="folders__kind" title={open ? fileKindDescription(open.kind) : undefined}>
          {open && <FileKindIcon kind={open.kind} />}
        </span>
        <button
          className="folders__name mono"
          title={
            open
              ? `${name} — click to close it`
              : builtin
                ? `${name} — click to open a copy of this example, double-click to go to it`
                : `${name} — click to open it off disk, double-click to go to it`
          }
          // `detail` is the click count, so the toggle runs once per gesture rather than again as
          // the second half of a double-click.
          onClick={(e) => {
            if (e.detail > 1) return;
            toggleLoaded();
          }}
          onDoubleClick={() => {
            // The click that opened this gesture has already run, so `open` is a render behind:
            // `gesture` is what the file is on its way to being.
            const g = gesture.current;
            gesture.current = null;
            if (!(g ? g.open : !!open)) return;
            void Promise.resolve(g?.settled).then(() => onOpenFile(name));
          }}
        >
          {entry.name}
        </button>
        <span className="folders__meta mono">
          {entry.size !== undefined && formatSize(entry.size)}
          {entry.lastModified !== undefined &&
            ` · ${formatCompactDateTime(new Date(entry.lastModified))}`}
        </span>
      </div>
    </li>
  );
}
