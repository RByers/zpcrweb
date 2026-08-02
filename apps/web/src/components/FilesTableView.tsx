/**
 * The full files table — every loaded file (not just the visible ones the bar shows), one row
 * each, sortable by any column. Opened from the toggle at the file bar's left edge
 * (`FileBar.tsx`'s `FilesViewToggle`) and fills `<main>` while it's open, replacing whatever view
 * was showing.
 *
 * Two things live here that the bar no longer does:
 *
 * - The checkbox column is {@link FileSettings.visible} — what actually controls the bar. A
 *   chip's ✕ only ever hides now (see `FileBar.tsx`'s `HideButton`); this is where a file comes
 *   back, and the only other place besides selecting it.
 * - The delete control (✕ → red waste bin, click again to delete) moved here from the bar
 *   wholesale — this is the one place a file is actually removed from IndexedDB, for every file,
 *   not only a modified one. See {@link DeleteButton}.
 *
 * A row's hover card (see {@link RowHoverCard}) mirrors the file bar's own — same detailed type
 * description and targets/samples chips — but leaves out whatever the table's columns already say
 * (name, date, protocol, plate), showing only what neither does: the run's cycle count.
 *
 * Clicking a row anywhere else selects that file (which also turns its checkbox back on — see
 * `useZpcrStore`'s `setActive`) and closes this view, landing on the file's own first enabled
 * tab — the same "click a file, go look at it" the bar has always done.
 */
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileKindDescription, plateTargets, type FileKind, type PlateDefinition } from "@zpcrweb/core";
import type { LoadedFile, PlateFileResult, RunResult, ViewId } from "../state/useZpcrStore";
import type { ExperimentIdentity } from "../lib/experiment";
import { formatCompactDateTime } from "../lib/experiment";
import { plateDisplayName } from "../lib/plateNames";
import { channelColor } from "../lib/channelColors";
import { usePltdPassword } from "../state/pltdPassword";
import { FileKindIcon } from "./FileIcons";
import { TrashIcon } from "./TrashIcon";

interface Props {
  files: LoadedFile[];
  runs: Map<string, RunResult>;
  plateFiles: Map<string, PlateFileResult>;
  experiments: Map<string, ExperimentIdentity>;
  activeId: string | null;
  hiddenIds: Set<string>;
  modifiedIds: Set<string>;
  /** Select this file, close the table, and land on its own view — see `App.tsx`'s wiring.
   * `view`, when given, overrides the file's usual first-enabled-tab landing spot — the Plate
   * cell uses it to go straight to the Plates view rather than Overview. */
  onSelectFile: (id: string, view?: ViewId) => void;
  onSetVisible: (id: string, visible: boolean) => void;
  onDelete: (id: string) => void | Promise<void>;
  onClose: () => void;
}

/** The extension a kind is actually decoded as — independent of what the source file was named.
 * A `.csv` uploaded as `myplate.csv` is still a `.plt.csv` by content (`fileKind`'s content
 * sniffing), and a `.txt` is only ever admitted once it parses as a run definition, so this is
 * the kind's own canonical extension, not `r.fileName`'s. */
const EXTENSION_TEXT: Record<FileKind, string> = {
  zpcr: "zpcr",
  pcrd: "pcrd",
  biomeme: "json",
  pltd: "pltd",
  csv: "plt.csv",
  prcl: "prcl.txt",
};

/** The plate behind a row, resolved the same way the file bar's hover card does: a standalone
 * `.pltd`/`.csv`'s own parse, or the first plate a run's own archive carries. */
function plateFor(
  f: LoadedFile,
  run: RunResult | undefined,
  plateFile: PlateFileResult | undefined,
  password: string,
): PlateDefinition | null {
  if (f.kind === "pltd" || f.kind === "csv") return plateFile?.plate ?? null;
  if (f.kind === "prcl") return null;
  return run?.zpcr?.plates(password || undefined)[0]?.pltd.plate ?? null;
}

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
  protocol: string;
  plateName: string;
  cycles: number | undefined;
  plate: PlateDefinition | null;
  lastModified: number;
  modified: boolean;
  visible: boolean;
}

type SortKey =
  | "type"
  | "fileName"
  | "experimentName"
  | "date"
  | "size"
  | "protocol"
  | "plateName"
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
  { key: "date", label: "Date" },
  { key: "size", label: "Size", numeric: true },
  { key: "protocol", label: "Protocol" },
  { key: "plateName", label: "Plate" },
  { key: "lastModified", label: "File modified" },
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
      return r.protocol;
    case "plateName":
      return r.plateName;
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
 * as the file bar's own (`FileBar.tsx`'s `HoverCard`), plus the run's cycle count — everything
 * else that card shows (the run's name, protocol, file name) already has its own table column
 * here, so repeating it would just be noise. Portalled to a fixed screen position for the same
 * reason the bar's version is: the table's own scroll container (`.filesview__scroll`) would
 * otherwise clip it.
 */
function RowHoverCard({
  kind,
  cycles,
  plate,
  style,
}: {
  kind: FileKind;
  cycles: number | undefined;
  plate: PlateDefinition | null;
  style: React.CSSProperties;
}) {
  const targets = plate ? plateTargets(plate) : [];
  const samples = plate?.samples ?? [];
  return (
    <div className="filecard mono" style={style}>
      <div className="filecard__type">{fileKindDescription(kind)}</div>
      {cycles != null && (
        <dl className="filecard__dl">
          <dt>Cycles</dt>
          <dd>{cycles}</dd>
        </dl>
      )}
      {plate && (
        <>
          <div className="filecard__section">
            <div className="filecard__label">Targets</div>
            {targets.length ? (
              <div className="filecard__chips">
                {targets.map((t) => (
                  <span
                    key={t.name}
                    className="filecard__chip"
                    style={t.channel != null ? { color: channelColor(t.channel) } : undefined}
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
  onSetVisible,
  onDelete,
}: {
  r: Row;
  isActive: boolean;
  onSelectFile: (id: string, view?: ViewId) => void;
  onSetVisible: (id: string, visible: boolean) => void;
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
          checked={r.visible}
          aria-label={`Show ${r.experimentName} in the file bar`}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSetVisible(r.id, e.target.checked)}
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
              cycles={r.cycles}
              plate={r.plate}
              style={{ position: "fixed", top: cardPos.top, left: cardPos.left, zIndex: 50 }}
            />,
            document.body,
          )}
      </td>
      <td className="mono filesview__filename" title={r.fileName}>
        {r.fileName}
      </td>
      <td className="mono">{r.dateText || "—"}</td>
      <td className="mono atbl__num">{formatSize(r.size)}</td>
      <td>{r.protocol}</td>
      <td>
        {r.plate ? (
          <button
            type="button"
            className="filesview__platelink"
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
      <td className="mono">
        {formatCompactDateTime(new Date(r.lastModified))}
        {r.modified && (
          <span className="filesview__moddot" title="Edited since it was loaded, not yet downloaded" />
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
  runs,
  plateFiles,
  experiments,
  activeId,
  hiddenIds,
  modifiedIds,
  onSelectFile,
  onSetVisible,
  onDelete,
  onClose,
}: Props) {
  const [password] = usePltdPassword();
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [dir, setDir] = useState<1 | -1>(-1);

  const rows = useMemo<Row[]>(() => {
    return files.map((f) => {
      const run = runs.get(f.id);
      const plateFile = plateFiles.get(f.id);
      const identity = experiments.get(f.id);
      const plate = plateFor(f, run, plateFile, password);
      return {
        id: f.id,
        kind: f.kind,
        fileName: f.name,
        experimentName: identity?.name || f.name,
        dateText: identity?.dateText || "",
        dateMs: identity?.date?.getTime() ?? 0,
        size: f.size,
        protocol: run?.zpcr?.protocol()?.name || "—",
        plateName: plate ? plateDisplayName(plate) : "—",
        cycles: run?.zpcr?.reads.length,
        plate,
        lastModified: f.lastModified,
        modified: modifiedIds.has(f.id),
        visible: !hiddenIds.has(f.id),
      };
    });
  }, [files, runs, plateFiles, experiments, password, modifiedIds, hiddenIds]);

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
      <div className="filesview__header">
        <h2 className="filesview__title">All files</h2>
        <button className="filesview__close" onClick={onClose} aria-label="Close all files">
          ✕
        </button>
      </div>
      <div className="filesview__scroll">
        <table className="filesview__tbl">
          <thead>
            <tr>
              <th className="filesview__checkcol">Show</th>
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
                isActive={r.id === activeId}
                onSelectFile={onSelectFile}
                onSetVisible={onSetVisible}
                onDelete={onDelete}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="filesview__totals">
              {/* checkbox column + every data column but the last (File modified) */}
              <td colSpan={COLUMNS.length}>
                {files.length} file{files.length === 1 ? "" : "s"} · {formatSize(totalSize)} total
              </td>
              {/* the last data column (File modified) + the delete column */}
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
        {files.length === 0 && <div className="filesview__empty mono">No files loaded.</div>}
      </div>
    </div>
  );
}
