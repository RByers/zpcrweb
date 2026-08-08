/**
 * The granted folders, in the lower half of the Files view: one stacked section each, and inside
 * each a **directory tree beside the files of the directory you have picked**.
 *
 * This is the *disk*, not the catalog: it lists what is in the folder, whether or not the app has
 * ever opened it. A file's checkbox is the same "loaded" switch the catalog table's is — ticking one
 * the app has never seen reads it off disk and opens it; ticking one it knows brings its bytes back.
 * Files opened here are written back to the same file on disk when they change, which is the whole
 * point of granting the folder (`state/diskFolders.ts`).
 *
 * **Two panes, one when it doesn't fit.** Side by side the tree stays put while you look through a
 * directory, which is what makes a folder of a hundred subdirectories navigable at all. Below a
 * container width the same two panes stack — tree above, files below — rather than the app growing
 * a second, differently-behaved narrow layout. There is one interaction model either way: click a
 * directory to see its files, click its chevron to open it in the tree.
 *
 * **A closed branch has not been read.** The tree lists lazily, one directory level per expansion,
 * because a folder handed to the app may hold a career's worth of runs. What opens by itself is only
 * the branch containing files that are already loaded, and the file pane starts on that directory.
 * That is also why a directory row shows no file count — counting would mean descending into it.
 *
 * The consequence, worth knowing while reading this: a file written into the folder by something
 * else won't appear on its own. The ↻ re-reads. (Files that are *loaded* do refresh by themselves;
 * those are watched one by one.)
 */
import { fileKindDescription } from "@zpcrweb/core";
import type { DiskSource } from "../state/db";
import type { DiskTree } from "../state/useDiskTree";
import { nodeKey } from "../state/useDiskTree";
import { diskFileName } from "../state/diskFolders";
import type { DiskEntry } from "../state/diskFolders";
import type { FileEntry } from "../state/useZpcrStore";
import { formatCompactDateTime } from "../lib/experiment";
import { FileKindIcon } from "./FileIcons";
import { FolderIcon } from "./ViewIcons";

interface Props {
  tree: DiskTree;
  /** The catalog, so a row can tell "in the app" from "on disk only". */
  entries: FileEntry[];
  loadedNames: ReadonlySet<string>;
  /** Bring an already-known file's bytes back, or let it go. */
  onSetLoaded: (id: string, loaded: boolean) => void;
  /** Open files the app has never seen, straight off disk. */
  onAddDiskFiles: (sources: DiskSource[]) => void;
  onSelectFile: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FolderSection({
  tree,
  entries,
  loadedNames,
  onSetLoaded,
  onAddDiskFiles,
  onSelectFile,
}: Props) {
  return (
    <>
      {tree.folders.map((folder) => {
        const isOpen = !tree.collapsed.has(folder.label);
        const selected = tree.selected.get(folder.label) ?? [];
        return (
          <section className="folders__folder" key={folder.label}>
            {/* Not a <details>/<summary>: the header carries three separate actions — collapse the
                section, select the folder's own root, and the buttons on the right — and a
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
                  "folders__title mono" + (isOpen && selected.length === 0 ? " is-selected" : "")
                }
                title={`Show the files directly in ${folder.label}`}
                onClick={() => tree.select(folder.label, [])}
              >
                <span className="folders__icon">
                  <FolderIcon />
                </span>
                {folder.label}
              </button>
              <span className="folders__actions">
                {folder.permission !== "granted" && (
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
              </span>
            </div>
            {isOpen &&
              (folder.permission === "granted" ? (
                <div className="folders__body">
                  <div className="folders__tree">
                    <DirectoryLevel
                      tree={tree}
                      label={folder.label}
                      path={[]}
                      depth={0}
                      selected={selected}
                    />
                  </div>
                  <div className="folders__files">
                    <FilePane
                      tree={tree}
                      label={folder.label}
                      path={selected}
                      entries={entries}
                      loadedNames={loadedNames}
                      onSetLoaded={onSetLoaded}
                      onAddDiskFiles={onAddDiskFiles}
                      onSelectFile={onSelectFile}
                    />
                  </div>
                </div>
              ) : (
                <div className="folders__note mono">
                  This browser needs permission again before it can read this folder.
                </div>
              ))}
          </section>
        );
      })}
      {tree.error && <div className="folders__note folders__note--error mono">{tree.error}</div>}
    </>
  );
}

const indent = (depth: number): number => 8 + depth * 13;

/** The subdirectories of one directory — the tree pane's recursive half. Files are not here; they
 * are the other pane's job. */
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
  selected: readonly string[];
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
        const isSelected = key === nodeKey(label, selected);
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
  entries,
  loadedNames,
  onSetLoaded,
  onAddDiskFiles,
  onSelectFile,
}: {
  tree: DiskTree;
  label: string;
  path: readonly string[];
} & Omit<Props, "tree">) {
  const node = tree.nodes.get(nodeKey(label, path));
  const files = node?.entries?.filter((e) => e.kind === "file") ?? [];
  return (
    <>
      <div className="folders__crumbs mono">
        {/* Every ancestor is a way back up, which is the only navigation the file pane needs. */}
        <button className="folders__crumb" onClick={() => tree.select(label, [])}>
          {label}
        </button>
        {path.map((part, i) => (
          <span key={i}>
            <span className="folders__crumbsep" aria-hidden="true">
              /
            </span>
            <button className="folders__crumb" onClick={() => tree.select(label, path.slice(0, i + 1))}>
              {part}
            </button>
          </span>
        ))}
      </div>
      {node?.error ? (
        <div className="folders__note folders__note--error mono">{node.error}</div>
      ) : !node?.entries ? (
        <div className="folders__note mono">{node?.pending ? "reading…" : ""}</div>
      ) : files.length === 0 ? (
        <div className="folders__note mono">nothing here the app can open</div>
      ) : (
        <ul className="folders__list">
          {files.map((entry) => (
            <FileRow
              key={entry.name}
              label={label}
              path={path}
              entry={entry}
              entries={entries}
              loadedNames={loadedNames}
              onSetLoaded={onSetLoaded}
              onAddDiskFiles={onAddDiskFiles}
              onSelectFile={onSelectFile}
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
  entries,
  loadedNames,
  onSetLoaded,
  onAddDiskFiles,
  onSelectFile,
}: {
  label: string;
  path: readonly string[];
  entry: DiskEntry;
} & Omit<Props, "tree">) {
  const source: DiskSource = { folder: label, path: [...path, entry.name] };
  const name = diskFileName(source);
  const known = entries.find((e) => e.name === name);
  const loaded = loadedNames.has(name);
  return (
    <li>
      <div className={"folders__file" + (loaded ? " is-loaded" : "")}>
        <input
          type="checkbox"
          className="folders__check"
          checked={loaded}
          title={loaded ? "Release this file" : "Open this file"}
          aria-label={loaded ? `Release ${entry.name}` : `Open ${entry.name}`}
          onChange={(e) => {
            // A file the catalog already knows just gets its bytes back; one it has never seen has
            // to be read and decoded first, which is what tells the app what kind of file it is.
            if (known) onSetLoaded(name, e.target.checked);
            else if (e.target.checked) onAddDiskFiles([source]);
          }}
        />
        <span
          className="folders__kind"
          title={known ? fileKindDescription(known.kind) : undefined}
        >
          {known && <FileKindIcon kind={known.kind} />}
        </span>
        <button
          className="folders__name mono"
          // Only a file the app is holding has anything to select; one merely sitting on disk has
          // no views yet, so its name is plain text until the checkbox opens it.
          disabled={!known}
          title={name}
          onClick={() => onSelectFile(name)}
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
