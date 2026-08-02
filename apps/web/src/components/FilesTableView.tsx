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
 * Clicking a row anywhere else selects that file (which also turns its checkbox back on — see
 * `useZpcrStore`'s `setActive`) and closes this view, landing on the file's own first enabled
 * tab — the same "click a file, go look at it" the bar has always done.
 */
import { useMemo, useState } from "react";
import { fileCategory, plateTargets, type FileKind, type PlateDefinition } from "@zpcrweb/core";
import type { LoadedFile, PlateFileResult, RunResult } from "../state/useZpcrStore";
import type { ExperimentIdentity } from "../lib/experiment";
import { formatCompactDateTime } from "../lib/experiment";
import { plateDisplayName } from "../lib/plateNames";
import { usePltdPassword } from "../state/pltdPassword";
import { FileKindIcon } from "./FileIcons";
import { TrashIcon } from "./TrashIcon";

interface Props {
  files: LoadedFile[];
  runs: Map<string, RunResult>;
  plateFiles: Map<string, PlateFileResult>;
  protocolFiles: Map<string, string>;
  experiments: Map<string, ExperimentIdentity>;
  activeId: string | null;
  hiddenIds: Set<string>;
  modifiedIds: Set<string>;
  /** Select this file, close the table, and land on its own view — see `App.tsx`'s wiring. */
  onSelectFile: (id: string) => void;
  onSetVisible: (id: string, visible: boolean) => void;
  onDelete: (id: string) => void | Promise<void>;
  onClose: () => void;
}

const CATEGORY_TEXT: Record<string, string> = {
  run: "Run",
  plate: "Plate map",
  protocol: "Thermal protocol",
};

/** Join up to `max` names with commas, collapsing the rest to a `"+N more"` tail — keeps the
 * description column to roughly a line regardless of how many targets/samples a plate carries. */
function joinTrunc(names: string[], max = 6): string {
  if (names.length === 0) return "";
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")}, +${names.length - max} more`;
}

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

/** One line summarizing what a file actually contains — targets and samples for anything with a
 * plate, the run definition text for a standalone thermal protocol. */
function describeRow(f: LoadedFile, plate: PlateDefinition | null, protocolText: string | undefined): string {
  if (plate) {
    const targets = plateTargets(plate).map((t) => t.name);
    const samples = plate.samples;
    const parts: string[] = [];
    if (targets.length) parts.push(`Targets: ${joinTrunc(targets)}`);
    if (samples.length) parts.push(`Samples: ${joinTrunc(samples)}`);
    return parts.join(" · ") || "—";
  }
  if (f.kind === "prcl" && protocolText) {
    return protocolText.length > 140 ? `${protocolText.slice(0, 140)}…` : protocolText;
  }
  return "—";
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
  description: string;
  lastModified: number;
  modified: boolean;
  visible: boolean;
}

type SortKey =
  | "fileName"
  | "experimentName"
  | "date"
  | "size"
  | "protocol"
  | "plateName"
  | "description"
  | "lastModified"
  | "modified";

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: "experimentName", label: "Name" },
  { key: "fileName", label: "File" },
  { key: "date", label: "Date" },
  { key: "size", label: "Size", numeric: true },
  { key: "protocol", label: "Protocol" },
  { key: "plateName", label: "Plate" },
  { key: "description", label: "Contents" },
  { key: "lastModified", label: "File modified" },
  { key: "modified", label: "Unsaved" },
];

function sortValue(r: Row, key: SortKey): string | number {
  switch (key) {
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
    case "description":
      return r.description;
    case "lastModified":
      return r.lastModified;
    case "modified":
      return r.modified ? 1 : 0;
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
 * The row's delete control: ✕ deletes on the first click for an untouched file, or arms (a red
 * waste bin) for one with unsaved edits, exactly like the old file-bar delete this replaced (see
 * `FileBar.tsx`'s former `DeleteButton`) — moved here rather than duplicated, since it's now the
 * only delete in the app.
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
  const isArmed = armed && modified;
  return (
    <button
      className={"ftbl__del" + (isArmed ? " is-armed" : "")}
      aria-label={
        isArmed
          ? `Confirm deleting ${name} — its unsaved changes will be lost`
          : `Delete ${name} from storage`
      }
      title={
        isArmed
          ? "Click again to delete. This file has changes that aren't on disk — download it first to keep them."
          : modified
            ? "Delete from storage — this file has changes that aren't on disk, so it will ask again"
            : "Delete from storage"
      }
      onMouseLeave={() => setArmed(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (isArmed) onDelete();
        else if (modified) setArmed(true);
        else onDelete();
      }}
    >
      {isArmed ? <TrashIcon /> : "✕"}
    </button>
  );
}

export function FilesTableView({
  files,
  runs,
  plateFiles,
  protocolFiles,
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
        description: describeRow(f, plate, protocolFiles.get(f.id)),
        lastModified: f.lastModified,
        modified: modifiedIds.has(f.id),
        visible: !hiddenIds.has(f.id),
      };
    });
  }, [files, runs, plateFiles, protocolFiles, experiments, password, modifiedIds, hiddenIds]);

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
              <th className="filesview__checkcol" aria-label="Shown in file bar" />
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
              <tr
                key={r.id}
                className={"filesview__row" + (r.id === activeId ? " is-active" : "")}
                onClick={() => onSelectFile(r.id)}
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
                <td>
                  <span
                    className="filesview__kind"
                    title={CATEGORY_TEXT[fileCategory(r.kind)]}
                  >
                    <FileKindIcon kind={r.kind} />
                  </span>
                  {r.experimentName}
                </td>
                <td className="mono filesview__filename" title={r.fileName}>
                  {r.fileName}
                </td>
                <td className="mono">{r.dateText || "—"}</td>
                <td className="mono atbl__num">{formatSize(r.size)}</td>
                <td>{r.protocol}</td>
                <td>{r.plateName}</td>
                <td className="filesview__desc" title={r.description}>
                  {r.description}
                </td>
                <td className="mono">{formatCompactDateTime(new Date(r.lastModified))}</td>
                <td>
                  {r.modified && (
                    <span className="filesview__moddot" title="Edited since it was loaded, not yet downloaded" />
                  )}
                </td>
                <td className="filesview__delcol">
                  <DeleteButton
                    name={r.experimentName}
                    modified={r.modified}
                    onDelete={() => void onDelete(r.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="filesview__totals">
              {/* checkbox column + every data column but the last (Unsaved) + delete column */}
              <td colSpan={COLUMNS.length}>
                {files.length} file{files.length === 1 ? "" : "s"} · {formatSize(totalSize)} total
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
        {files.length === 0 && <div className="filesview__empty mono">No files loaded.</div>}
      </div>
    </div>
  );
}
