/**
 * The open files, one row each, sortable by any column — the same set the file bar's chips are,
 * with room to say much more about each. It is the "Files" tab of the view bar — the one tab that
 * is not a lens on the selected file — and fills `<main>` while it's open.
 *
 * The view is **two independently scrolling panes**: this table on top, and — only once a folder on
 * disk has been granted — `FolderSection`'s folder trees underneath. They answer different
 * questions, "what is the app holding" and "what is on the disk", and are different lengths, so
 * scrolling one to the bottom must not push the other off screen. With no folders there is only the
 * table. Opening a file that isn't open yet is the folder pane's job, not this one's.
 *
 * **Every cell is derived from the decoded file**, live, in {@link FilesTableView}'s `rows` — there
 * is no cached per-file summary anywhere any more. Every row here is a file the app is already
 * holding decoded, so there is nothing to cache: the numbers are the ones the rest of the app is
 * showing, and a rename or an attached plate updates the row as it happens rather than after a
 * write lands. A row whose file hasn't been read yet — a folder waiting on its permission back —
 * renders dashes, which is the honest answer.
 *
 * The ✕ at the right of each row **closes** the file: bytes out of memory, records out of
 * IndexedDB, in one act. It is the same control as the chip's, and the same component
 * (`CloseFileButton.tsx`) — one click for a file that is only a copy of something on disk, two for
 * one carrying edits that exist nowhere else.
 *
 * A row's hover card (see {@link RowHoverCard}) mirrors the file bar's own — same detailed type
 * description and targets/samples chips — but leaves out whatever the table's columns already say
 * (name, date, protocol, plate, plateread count).
 *
 * Three cells are links into the file's own views rather than plain text — Protocol → Protocol,
 * Plate → Plates, Reads → Curves — so the table doubles as a way in to the thing the cell names.
 *
 * Clicking a row anywhere else selects that file and closes this view, landing on the file's own
 * first enabled tab — the same "click a file, go look at it" the bar has always done. The folder
 * pane below deliberately does *not*: a row there is a file on disk you may be browsing past, so a
 * click ticks it open or closed and stays, and a double-click is what leaves. See
 * `FolderSection.tsx`.
 */
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileKindDescription, plateTargets, type FileKind } from "@zpcrweb/core";
import type { FileEntry, PlateFileResult, RunResult, ViewId } from "../state/useZpcrStore";
import { formatCompactDateTime, type ExperimentIdentity } from "../lib/experiment";
import { plateDisplayName } from "../lib/plateNames";
import { fluorColor } from "../lib/fluorColors";
import { usePltdPassword } from "../state/pltdPassword";
import { FileKindIcon } from "./FileIcons";
import { FolderSection } from "./FolderSection";
import type { DiskTree } from "../state/useDiskTree";
import type { DiskSource } from "../state/db";
import { CloseFileButton } from "./CloseFileButton";

interface Props {
  /** Every open file, metadata only — one row each. */
  files: FileEntry[];
  activeName: string | null;
  modifiedIds: Set<string>;
  /** The decoded runs and plate files, and each file's resolved name/date — what every cell in the
   * table is read out of (`ZpcrStore.runs`/`plateFiles`/`experiments`). */
  runs: Map<string, RunResult>;
  plateFiles: Map<string, PlateFileResult>;
  experiments: Map<string, ExperimentIdentity>;
  /** Select this file, close the table, and land on its own view; see `App.tsx`'s wiring. `view`,
   * when given, overrides the usual first-enabled-tab landing spot — the Protocol/Plate/Reads cells
   * use it to go straight to that view rather than Overview. */
  onSelectFile: (id: string, view?: ViewId) => void;
  /** Close the file — see `ZpcrStore.closeFile`. */
  onCloseFile: (id: string) => void | Promise<void>;
  /** Leave the Files view. */
  onClose: () => void;
  /** The granted folders and their lazily-listed trees — see `FolderSection.tsx`. Rendered above
   * the table because they are a different question: the table is what the app is holding, the
   * trees are what is on the disk. */
  tree: DiskTree;
  /** Resolves once the files are open — `FolderSection.tsx`'s double-click waits on it. */
  onAddDiskFiles: (sources: DiskSource[], goToFile?: boolean) => void | Promise<void>;
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
  targets: { name: string; fluor: string | null }[];
  samples: string[];
  lastModified: number;
  modified: boolean;
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
  targets: Row["targets"];
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

/** One row plus its hover card — a component of its own (rather than inline in the table map)
 * because the card needs its own ref/position state, the same reason `FileBar.tsx` splits
 * `FileChip` out of `FileBar`. */
function FilesRow({
  r,
  isActive,
  onSelectFile,
  onCloseFile,
}: {
  r: Row;
  isActive: boolean;
  onSelectFile: (id: string, view?: ViewId) => void;
  onCloseFile: (id: string) => void | Promise<void>;
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
          <span className="filesview__moddot" title="Edited since it was opened, not yet downloaded" />
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
        <CloseFileButton
          name={r.experimentName}
          modified={r.modified}
          onClose={() => void onCloseFile(r.id)}
          className="ftbl__del"
        />
      </td>
    </tr>
  );
}

export function FilesTableView({
  files,
  activeName,
  modifiedIds,
  runs,
  plateFiles,
  experiments,
  onSelectFile,
  onCloseFile,
  onClose,
  tree,
  onAddDiskFiles,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [dir, setDir] = useState<1 | -1>(-1);
  const [password] = usePltdPassword();

  // Read straight off the decoded files — see the module comment. Memoized because naming a run's
  // plate means decrypting it, and that is not work to repeat on every hover.
  const rows = useMemo<Row[]>(() => {
    return files.map((f) => {
      const identity = experiments.get(f.name);
      const zpcr = runs.get(f.name)?.zpcr ?? null;
      const plateFile = plateFiles.get(f.name);
      const plate = plateFile
        ? plateFile.plate
        : zpcr?.plates(password || undefined)[0]?.pltd.plate ?? null;
      return {
        id: f.name,
        kind: f.kind,
        fileName: f.name,
        experimentName: identity?.name || f.name,
        dateText: identity?.dateText ?? "",
        dateMs: identity?.date?.getTime() ?? 0,
        size: f.size,
        protocol: zpcr?.protocol()?.name || null,
        plateName: plate ? plateDisplayName(plate) : "—",
        reads: zpcr ? zpcr.reads.length : undefined,
        targets: plate ? plateTargets(plate) : [],
        samples: plate?.samples ?? [],
        lastModified: f.lastModified,
        modified: modifiedIds.has(f.name),
      };
    });
  }, [files, modifiedIds, runs, plateFiles, experiments, password]);

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
                onCloseFile={onCloseFile}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="filesview__totals">
              {/* every data column but the last (Reads) */}
              <td colSpan={COLUMNS.length - 1}>
                {files.length} file{files.length === 1 ? "" : "s"} open · {formatSize(totalSize)} total
              </td>
              {/* the last data column (Reads) + the close column */}
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
        {files.length === 0 && <div className="filesview__empty mono">No files open.</div>}
      </div>
      {tree.supported && tree.folders.length > 0 && (
        <div className="filesview__pane filesview__pane--folders">
          <FolderSection
            tree={tree}
            entries={files}
            activeName={activeName}
            onCloseFile={onCloseFile}
            onAddDiskFiles={onAddDiskFiles}
            onOpenFile={(id) => onSelectFile(id, "overview")}
          />
        </div>
      )}
    </div>
  );
}
