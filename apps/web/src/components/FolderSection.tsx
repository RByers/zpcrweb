/**
 * One granted folder, as a directory tree, above the catalog table in the Files view.
 *
 * This is the *disk*, not the catalog: it lists what is in the folder, whether or not the app has
 * ever opened it. A file's checkbox is the same "loaded" switch the table's is — ticking one that
 * the app has never seen reads it off disk and opens it; ticking one it knows brings its bytes
 * back. Files opened from here are written back to the same file on disk when they change, which
 * is the whole point of granting the folder (`state/diskFolders.ts`).
 *
 * **A closed branch has not been read.** Every node lists lazily, one directory level per
 * expansion, because a folder handed to the app may hold a career's worth of runs. What opens by
 * itself is only the branches containing files that are already loaded. That is also why a
 * directory row shows no file count — counting would mean descending into it.
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
  /** The catalog, so a row can tell "in the app and loaded" from "on disk only". */
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
  if (!tree.supported || tree.folders.length === 0) return null;
  return (
    <div className="folders">
      {tree.folders.map((folder) => (
        <details className="folders__folder" key={folder.label} open>
          <summary className="folders__head">
            <span className="folders__title mono">
              <span className="rail__chevron" aria-hidden="true">
                ▸
              </span>
              <span className="folders__icon">
                <FolderIcon />
              </span>
              {folder.label}
            </span>
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
          </summary>
          {folder.permission === "granted" ? (
            <DirectoryNode
              tree={tree}
              label={folder.label}
              path={[]}
              depth={0}
              entries={entries}
              loadedNames={loadedNames}
              onSetLoaded={onSetLoaded}
              onAddDiskFiles={onAddDiskFiles}
              onSelectFile={onSelectFile}
            />
          ) : (
            <div className="folders__note mono">
              This browser needs permission again before it can read this folder.
            </div>
          )}
        </details>
      ))}
      {tree.error && <div className="folders__note folders__note--error mono">{tree.error}</div>}
    </div>
  );
}

interface NodeProps extends Omit<Props, "tree"> {
  tree: DiskTree;
  label: string;
  path: string[];
  depth: number;
}

/** The contents of one directory: its subdirectories (each a node of its own once opened) and the
 * files in it the app could open. */
function DirectoryNode({
  tree,
  label,
  path,
  depth,
  entries,
  loadedNames,
  onSetLoaded,
  onAddDiskFiles,
  onSelectFile,
}: NodeProps) {
  const node = tree.nodes.get(nodeKey(label, path));
  if (node?.error) {
    return (
      <div className="folders__note folders__note--error mono" style={{ paddingLeft: indent(depth) }}>
        {node.error}
      </div>
    );
  }
  if (!node?.entries) {
    return (
      <div className="folders__note mono" style={{ paddingLeft: indent(depth) }}>
        {node?.pending ? "reading…" : ""}
      </div>
    );
  }
  if (node.entries.length === 0) {
    return (
      <div className="folders__note mono" style={{ paddingLeft: indent(depth) }}>
        nothing here the app can open
      </div>
    );
  }
  return (
    <ul className="folders__list">
      {node.entries.map((entry) =>
        entry.kind === "directory" ? (
          <DirectoryRow
            key={entry.name}
            tree={tree}
            label={label}
            path={path}
            entry={entry}
            depth={depth}
            entries={entries}
            loadedNames={loadedNames}
            onSetLoaded={onSetLoaded}
            onAddDiskFiles={onAddDiskFiles}
            onSelectFile={onSelectFile}
          />
        ) : (
          <FileRow
            key={entry.name}
            label={label}
            path={path}
            entry={entry}
            depth={depth}
            entries={entries}
            loadedNames={loadedNames}
            onSetLoaded={onSetLoaded}
            onAddDiskFiles={onAddDiskFiles}
            onSelectFile={onSelectFile}
          />
        ),
      )}
    </ul>
  );
}

const indent = (depth: number): number => 10 + depth * 14;

function DirectoryRow({
  tree,
  label,
  path,
  entry,
  depth,
  ...rest
}: NodeProps & { entry: DiskEntry }) {
  const childPath = [...path, entry.name];
  const isOpen = tree.open.has(nodeKey(label, childPath));
  return (
    <li className="folders__item">
      <button
        className="folders__dir mono"
        style={{ paddingLeft: indent(depth) }}
        aria-expanded={isOpen}
        onClick={() => tree.toggle(label, childPath)}
      >
        <span className={"rail__chevron" + (isOpen ? " is-open" : "")} aria-hidden="true">
          ▸
        </span>
        {entry.name}
      </button>
      {isOpen && (
        <DirectoryNode tree={tree} label={label} path={childPath} depth={depth + 1} {...rest} />
      )}
    </li>
  );
}

function FileRow({
  label,
  path,
  entry,
  depth,
  entries,
  loadedNames,
  onSetLoaded,
  onAddDiskFiles,
  onSelectFile,
}: Omit<NodeProps, "tree"> & { entry: DiskEntry }) {
  const source: DiskSource = { folder: label, path: [...path, entry.name] };
  const name = diskFileName(source);
  const known = entries.find((e) => e.name === name);
  const loaded = loadedNames.has(name);
  return (
    <li className="folders__item">
      <div className={"folders__file" + (loaded ? " is-loaded" : "")} style={{ paddingLeft: indent(depth) }}>
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
        <span className="folders__kind" title={known ? fileKindDescription(known.kind) : undefined}>
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
          {entry.lastModified !== undefined && ` · ${formatCompactDateTime(new Date(entry.lastModified))}`}
        </span>
      </div>
    </li>
  );
}
