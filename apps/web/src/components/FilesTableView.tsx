/**
 * The **catalog**: every file this browser holds, loaded or not, one row each, sortable by any
 * column. It is the "Files" tab of the view bar — the one tab that is not a lens on the selected
 * file — and fills `<main>` while it's open.
 *
 * The view is **two independently scrolling panes**: this table on top, and — only once a folder on
 * disk has been granted — `FolderSection`'s folder trees underneath. They answer different
 * questions, "what is this browser holding" and "what is on the disk", and are different lengths,
 * so scrolling one to the bottom must not push the other off screen. With no folders there is only
 * the table.
 *
 * **Every cell here comes from a file's cached summary** (`state/db.ts`'s `FileSummary`, written
 * by `lib/fileSummary.ts` each time a file is loaded), never from a decoded archive. That is what
 * makes a catalog of thousands of files cost nothing to list: no bytes are read to draw this
 * table, and nothing here can be the reason a file gets unzipped. A file that has never been
 * loaded by a version of the app that writes summaries shows dashes until it is opened once,
 * which is the honest answer — nothing has read its content yet.
 *
 * Two things live here that the file bar doesn't do:
 *
 * - The checkbox column is {@link FileSettings.loaded} — whether the file's bytes are in memory
 *   and it has a chip. A chip's ✕ only ever releases (see `FileBar.tsx`'s `UnloadButton`); this is
 *   where a file comes back, and the only other place besides selecting it.
 * - The delete control (✕ → red waste bin, click again to delete) — this is the one place a file
 *   is actually removed from IndexedDB, for every file, not only a modified one. See
 *   {@link DeleteButton}.
 *
 * A row's hover card (see {@link RowHoverCard}) mirrors the file bar's own — same detailed type
 * description and targets/samples chips — but leaves out whatever the table's columns already say
 * (name, date, protocol, plate, plateread count).
 *
 * Three cells are links into the file's own views rather than plain text — Protocol → Protocol,
 * Plate → Plates, Reads → Curves — so the table doubles as a way in to the thing the cell names.
 *
 * Clicking a row anywhere else selects that file (which also turns its checkbox back on — see
 * `useZpcrStore`'s `setActive`) and closes this view, landing on the file's own first enabled
 * tab — the same "click a file, go look at it" the bar has always done.
 */
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileKindDescription, type FileKind } from "@zpcrweb/core";
import type { FileEntry, ViewId } from "../state/useZpcrStore";
import type { FileSummary } from "../state/db";
import { formatCompactDateTime } from "../lib/experiment";
import { fluorColor } from "../lib/fluorColors";
import { FileKindIcon } from "./FileIcons";
import { FolderSection } from "./FolderSection";
import type { DiskTree } from "../state/useDiskTree";
import type { DiskSource } from "../state/db";
import { TrashIcon } from "./TrashIcon";

interface Props {
  /** The whole catalog — metadata and cached summaries, no bytes. */
  files: FileEntry[];
  activeName: string | null;
  /** Which files are loaded (`ZpcrStore.loadedIds`) — the checkbox column. */
  loadedIds: Set<string>;
  modifiedIds: Set<string>;
  /** Select this file — which loads it if it isn't — close the table, and land on its own view;
   * see `App.tsx`'s wiring. `view`, when given, overrides the usual first-enabled-tab landing
   * spot — the Protocol/Plate/Reads cells use it to go straight to that view rather than Overview. */
  onSelectFile: (id: string, view?: ViewId) => void;
  /** Load or release the file — see `ZpcrStore.setLoaded`. */
  onSetLoaded: (id: string, loaded: boolean) => void;
  onDelete: (id: string) => void | Promise<void>;
  onClose: () => void;
  /** The granted folders and their lazily-listed trees — see `FolderSection.tsx`. Rendered above
   * the table because they are a different question: the table is what the app is holding, the
   * trees are what is on the disk. */
  tree: DiskTree;
  onAddDiskFiles: (sources: DiskSource[]) => void;
}

/** The extension a kind is actually decoded as — independent of what the source file was named.
 * A `.csv` uploaded as `myplate.csv` is still a `.plt.csv` by content (`fileKind`'s content
 * sniffing), and a `.txt` is only ever admitted once it parses as a run definition, so this is
 * the kind's own canonical extension, not `r.fileName`'s. */
const EXTENSION_TEXT: Record<FileKind, string> = {
  zpcr: "zpcr",
  pcrd: "pcrd",
  biomeme: "bmrun",
  pltd: "pltd",
  csv: "plt.csv",
  prcl: "prcl.txt",
  alf: "alf",
};

/** `12.3 kB` under 1000 kB, `1.24 MB` above — the same threshold a file manager uses, so a run
 * archive (hundreds of kB) and a bare plate CSV (a few kB) both read at a sensible precision. */
function formatSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1000) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

interface Row {
  id: string;
  kind: FileKind;
  fileName: string;
  experimentName: string;
  dateText: string;
  dateMs: number;
  size: number;
  /** Null for a file that carries no protocol (a standalone plate, say) — rendered as a dash,
   * and not a link, since there is no Protocol view to open for it. */
  protocol: string | null;
  plateName: string;
  /** Plateread count — undefined for a file that isn't a run, or hasn't been read yet. */
  reads: number | undefined;
  /** The plate's targets and samples, for the hover card — empty when there is no plate. */
  targets: FileSummary["targets"];
  samples: string[];
  /** Whether the row has a cached summary at all; a row without one renders dashes rather than
   * claiming a file has no protocol or no plate. */
  summarized: boolean;
  lastModified: number;
  modified: boolean;
  loaded: boolean;
}

type SortKey =
  | "type"
  | "fileName"
  | "experimentName"
  | "date"
  | "size"
  | "protocol"
  | "plateName"
  | "reads"
  | "lastModified";

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: "type", label: "Type" },
  { key: "experimentName", label: "Name" },
  { key: "fileName", label: "File" },
  { key: "lastModified", label: "File modified" },
  { key: "size", label: "Size", numeric: true },
  { key: "date", label: "Run date" },
  { key: "protocol", label: "Protocol" },
  { key: "plateName", label: "Plate" },
  { key: "reads", label: "Reads", numeric: true },
];

function sortValue(r: Row, key: SortKey): string | number {
  switch (key) {
    case "type":
      return EXTENSION_TEXT[r.kind];
    case "fileName":
      return r.fileName;
    case "experimentName":
      return r.experimentName;
    case "date":
      return r.dateMs;
    case "size":
      return r.size;
    case "protocol":
      return r.protocol ?? "";
    case "plateName":
      return r.plateName;
    case "reads":
      return r.reads ?? -1;
    case "lastModified":
      return r.lastModified;
  }
}

function sortRows(rows: Row[], key: SortKey, dir: 1 | -1): Row[] {
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    const d =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return d !== 0 ? d * dir : a.fileName.localeCompare(b.fileName);
  });
}

function SortArrow({ state }: { state: "asc" | "desc" | null }) {
  return (
    <span className={"atbl__arrow" + (state ? " is-on" : "")} aria-hidden="true">
      {state === "asc" ? "▲" : state === "desc" ? "▼" : "↕"}
    </span>
  );
}

/**
 * A row's hover card: the file's detailed type description, then the same targets/samples chips
 * as the file bar's own (`FileBar.tsx`'s `HoverCard`) — everything else that card shows (the
 * run's name, protocol, file name, plateread count) already has its own table column here, so
 * repeating it would just be noise. Portalled to a fixed screen position for the same
 * reason the bar's version is: the table's own scroll container (`.filesview__scroll`) would
 * otherwise clip it.
 */
function RowHoverCard({
  kind,
  targets,
  samples,
  style,
}: {
  kind: FileKind;
  targets: FileSummary["targets"];
  samples: string[];
  style: React.CSSProperties;
}) {
  const hasPlate = targets.length > 0 || samples.length > 0;
  return (
    <div className="filecard mono" style={style}>
      <div className="filecard__type">{fileKindDescription(kind)}</div>
      {hasPlate && (
        <>
          <div className="filecard__section">
            <div className="filecard__label">Targets</div>
            {targets.length ? (
              <div className="filecard__chips">
                {targets.map((t) => (
                  <span
                    key={t.name}
                    className="filecard__chip"
                    style={t.fluor != null ? { color: fluorColor(t.fluor) } : undefined}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            ) : (
              <div className="filecard__empty">none</div>
            )}
          </div>
          <div className="filecard__section">
            <div className="filecard__label">Samples</div>
            {samples.length ? (
              <div className="filecard__chips">
                {samples.map((s) => (
                  <span key={s} className="filecard__chip">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <div className="filecard__empty">none</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The row's delete control: ✕ always arms first (a red waste bin), regardless of whether the
 * file carries unsaved edits — the click after that is the one that deletes. Unlike the old
 * file-bar delete this replaced (`FileBar.tsx`'s former `DeleteButton`, which let an untouched
 * file go on the first click), this is the *only* delete in the app now, so it always asks twice
 * rather than making that depend on a state the person clicking may not have noticed.
 */
function DeleteButton({
  name,
  modified,
  onDelete,
}: {
  name: string;
  modified: boolean;
  onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      className={"ftbl__del" + (armed ? " is-armed" : "")}
      aria-label={
        armed
          ? `Confirm deleting ${name}${modified ? " — its unsaved changes will be lost" : ""}`
          : `Delete ${name} from storage`
      }
      title={
        armed
          ? modified
            ? "Click again to delete. This file has changes that aren't on disk — download it first to keep them."
            : "Click again to delete"
          : "Delete from storage"
      }
      onMouseLeave={() => setArmed(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) onDelete();
        else setArmed(true);
      }}
    >
      {armed ? <TrashIcon /> : "✕"}
    </button>
  );
}

/** One row plus its hover card — a component of its own (rather than inline in the table map)
 * because the card needs its own ref/position state, the same reason `FileBar.tsx` splits
 * `FileChip` out of `FileBar`. */
function FilesRow({
  r,
  isActive,
  onSelectFile,
  onSetLoaded,
  onDelete,
}: {
  r: Row;
  isActive: boolean;
  onSelectFile: (id: string, view?: ViewId) => void;
  onSetLoaded: (id: string, loaded: boolean) => void;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const rowRef = useRef<HTMLTableRowElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);

  return (
    <tr
      ref={rowRef}
      className={"filesview__row" + (isActive ? " is-active" : "")}
      onClick={() => onSelectFile(r.id)}
      onMouseEnter={() => {
        const rect = rowRef.current?.getBoundingClientRect();
        if (rect) setCardPos({ top: rect.bottom + 4, left: rect.left });
      }}
      onMouseLeave={() => setCardPos(null)}
    >
      <td className="filesview__checkcol">
        <input
          type="checkbox"
          checked={r.loaded}
          aria-label={`Load ${r.experimentName} into memory`}
          title={
            r.loaded
              ? "Loaded — uncheck to release it from memory; the file stays here"
              : "Not loaded — check to read it in and give it a chip on the file bar"
          }
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSetLoaded(r.id, e.target.checked)}
        />
      </td>
      <td className="filesview__typecol">
        <span className="filesview__kind">
          <FileKindIcon kind={r.kind} />
        </span>
        <span className="mono">{EXTENSION_TEXT[r.kind]}</span>
      </td>
      <td>
        {r.experimentName}
        {cardPos &&
          createPortal(
            <RowHoverCard
              kind={r.kind}
              targets={r.targets}
              samples={r.samples}
              style={{ position: "fixed", top: cardPos.top, left: cardPos.left, zIndex: 50 }}
            />,
            document.body,
          )}
      </td>
      <td className="mono filesview__filename" title={r.fileName}>
        {r.fileName}
      </td>
      <td className="mono">
        {formatCompactDateTime(new Date(r.lastModified))}
        {r.modified && (
          <span className="filesview__moddot" title="Edited since it was loaded, not yet downloaded" />
        )}
      </td>
      <td className="mono atbl__num">{formatSize(r.size)}</td>
      <td className="mono">{r.dateText || "—"}</td>
      <td>
        {r.protocol != null ? (
          <button
            type="button"
            className="filesview__link"
            onClick={(e) => {
              e.stopPropagation();
              onSelectFile(r.id, "protocol");
            }}
            title="Open the Protocol view"
          >
            {r.protocol}
          </button>
        ) : (
          "—"
        )}
      </td>
      <td>
        {r.plateName !== "—" ? (
          <button
            type="button"
            className="filesview__link"
            onClick={(e) => {
              e.stopPropagation();
              onSelectFile(r.id, "plates");
            }}
            title="Open the Plates view"
          >
            {r.plateName}
          </button>
        ) : (
          r.plateName
        )}
      </td>
      <td className="mono atbl__num">
        {r.reads ? (
          <button
            type="button"
            className="filesview__link"
            onClick={(e) => {
              e.stopPropagation();
              onSelectFile(r.id, "curves");
            }}
            title="Open the Curves view"
          >
            {r.reads}
          </button>
        ) : (
          (r.reads ?? "—")
        )}
      </td>
      <td className="filesview__delcol">
        <DeleteButton name={r.experimentName} modified={r.modified} onDelete={() => void onDelete(r.id)} />
      </td>
    </tr>
  );
}

export function FilesTableView({
  files,
  activeName,
  loadedIds,
  modifiedIds,
  onSelectFile,
  onSetLoaded,
  onDelete,
  onClose,
  tree,
  onAddDiskFiles,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [dir, setDir] = useState<1 | -1>(-1);

  // Straight from each file's cached summary — see the module comment. Nothing here decodes, or
  // even reads, an archive.
  const rows = useMemo<Row[]>(() => {
    return files.map((f) => {
      const s = f.summary;
      return {
        id: f.name,
        kind: f.kind,
        fileName: f.name,
        experimentName: s?.name || f.name,
        dateText: s?.dateMs ? formatCompactDateTime(new Date(s.dateMs)) : "",
        dateMs: s?.dateMs ?? 0,
        size: f.size,
        protocol: s?.protocol ?? null,
        plateName: s?.plate ?? "—",
        reads: s?.reads ?? undefined,
        targets: s?.targets ?? [],
        samples: s?.samples ?? [],
        summarized: !!s,
        lastModified: f.lastModified,
        modified: modifiedIds.has(f.name),
        loaded: loadedIds.has(f.name),
      };
    });
  }, [files, modifiedIds, loadedIds]);

  const sorted = useMemo(() => sortRows(rows, sortKey, dir), [rows, sortKey, dir]);

  const totalSize = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(1);
    }
  };

  return (
    <div
      className="filesview"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {/* Two panes, each scrolling on its own: what this browser is holding, and what is on the
          disk. They answer different questions and are different lengths, so scrolling one to the
          bottom must not push the other off screen. The lower pane is absent entirely when no
          folder has been granted, which leaves the catalog exactly the full-height table it was. */}
      <div className="filesview__pane filesview__pane--catalog">
        <table className="filesview__tbl">
          <thead>
            <tr>
              <th className="filesview__checkcol">Loaded</th>
              {COLUMNS.map((c) => {
                const state = c.key === sortKey ? (dir === 1 ? "asc" : "desc") : null;
                return (
                  <th
                    key={c.key}
                    className={c.numeric ? "atbl__num" : undefined}
                    aria-sort={state === "asc" ? "ascending" : state === "desc" ? "descending" : "none"}
                  >
                    <button
                      type="button"
                      className={"atbl__sort" + (state ? " is-sorted" : "")}
                      onClick={() => toggle(c.key)}
                      title={`Sort by ${c.label}`}
                    >
                      {c.label}
                      <SortArrow state={state} />
                    </button>
                  </th>
                );
              })}
              <th className="filesview__delcol" aria-label="Delete" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <FilesRow
                key={r.id}
                r={r}
                isActive={r.id === activeName}
                onSelectFile={onSelectFile}
                onSetLoaded={onSetLoaded}
                onDelete={onDelete}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="filesview__totals">
              {/* checkbox column + every data column but the last (Reads) */}
              <td colSpan={COLUMNS.length}>
                {files.length} file{files.length === 1 ? "" : "s"} · {formatSize(totalSize)} total ·{" "}
                {loadedIds.size} loaded
              </td>
              {/* the last data column (Reads) + the delete column */}
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
        {files.length === 0 && <div className="filesview__empty mono">No files.</div>}
      </div>
      {tree.supported && tree.folders.length > 0 && (
        <div className="filesview__pane filesview__pane--folders">
          <FolderSection
            tree={tree}
            entries={files}
            loadedNames={loadedIds}
            onSetLoaded={onSetLoaded}
            onAddDiskFiles={onAddDiskFiles}
            onSelectFile={onSelectFile}
          />
        </div>
      )}
    </div>
  );
}
