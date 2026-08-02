import { Fragment, useEffect, useState, type ReactNode } from "react";
import { fileKindDescription, type FileKind } from "@zpcrweb/core";
import { DownloadIcon } from "../DownloadIcon";
import { RenameIcon } from "../RenameIcon";
import { CloneIcon } from "../CloneIcon";
import { formatCompactDateTime } from "../../lib/experiment";

/**
 * The Overview tab, for every file kind there is.
 *
 * There is one Overview panel rather than one per format, because what an Overview *is* — what a
 * file is, what it's called, and the tools to save/rename/copy it — is the same question for a
 * run, a standalone plate and a standalone protocol alike. Three panels answering it separately is
 * how they drifted apart before: download existed only for a run, the rename control only as a
 * lone button, and each kept its own copy of the info table and the edit-in-place filename logic.
 *
 * So this owns everything shared and unconditional:
 *
 * - the `Type` / `Filename` / `Last modified` rows every kind leads with, in that order;
 * - the filename's edit-in-place behaviour ({@link useFilenameEditor}) and the toolbar button
 *   that opens it, including the auto-open a fresh clone arrives with;
 * - the download / edit / clone button column ({@link OverviewToolbar}).
 *
 * A kind varies it through four optional slots and nothing else: extra {@link OverviewPanelProps.rows}
 * appended to the info table, a {@link OverviewPanelProps.header} above it, a
 * {@link OverviewPanelProps.banner} under that, and `children` — the sections below (a plate's
 * chips, a password prompt). A caller with none of them, like a `.prcl.txt`'s, renders the bare
 * identity card by passing nothing at all.
 */

/** One label/value line of the info table. */
export interface InfoRow {
  label: string;
  value: ReactNode;
}

export interface OverviewPanelProps {
  /** The loaded file this Overview is about — its name, kind and OS mtime are the three rows the
   * panel writes itself. */
  file: { name: string; kind: FileKind; lastModified: number };
  /** What the "Filename" row shows when it isn't being edited, if that differs from `file.name` —
   * a run passes its resolved `ExperimentIdentity.fileName`. */
  fileNameDisplay?: ReactNode;
  /** Rename the loaded file (`ZpcrStore.renameFile`), committed from the editable row. */
  onRenameFile: (name: string) => void;
  /** Save the file to disk — `App.tsx`'s `downloadActiveFile`, which writes `exportBytes` and
   * clears the file's modified flag. */
  onDownload: () => void;
  /** Copy the file under the next free `(N)` name and open the copy — `App.tsx`'s
   * `cloneActiveFile`. */
  onClone: () => void;
  /** Overrides the Download button's tooltip, for a kind whose download isn't simply the bytes
   * that were loaded (a `.zpcr` also writes its `zpcrweb.json`). */
  downloadTitle?: string;
  /** Open the "Filename" row for editing as soon as the panel appears — how a just-cloned file
   * arrives, with its name selected and ready to be typed over. */
  autoEditName?: boolean;
  /** Called once {@link autoEditName} has been acted on, so it fires once per clone. */
  onAutoEditHandled?: () => void;
  /** The kind's own info rows, appended after the three shared ones. */
  rows?: readonly InfoRow[];
  /** Above the info table — a run's editable experiment-name headline. */
  header?: ReactNode;
  /** Between the header and the info table — a run's "still going" notice. */
  banner?: ReactNode;
  /** Sections below the info table: plate chips, a password prompt, a "nothing decoded" note. */
  children?: ReactNode;
}

export function OverviewPanel({
  file,
  fileNameDisplay,
  onRenameFile,
  onDownload,
  onClone,
  downloadTitle,
  autoEditName,
  onAutoEditHandled,
  rows,
  header,
  banner,
  children,
}: OverviewPanelProps) {
  const filename = useFilenameEditor({
    name: file.name,
    display: fileNameDisplay,
    onRename: onRenameFile,
    autoEdit: autoEditName,
    onAutoEditHandled,
  });

  const infoRows: InfoRow[] = [
    // `fileKindDescription` is the library's own wording for what the file is, rather than
    // something each panel re-phrases.
    { label: "Type", value: fileKindDescription(file.kind) },
    { label: "Filename", value: filename.field },
    { label: "Last modified", value: formatCompactDateTime(new Date(file.lastModified)) },
    ...(rows ?? []),
  ];

  return (
    <div className="overview">
      {header}
      {banner}
      <div className="overview__head">
        <dl className="overview__dl overview__infotable mono">
          {infoRows.map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
        <OverviewToolbar
          name={file.name}
          onDownload={onDownload}
          downloadTitle={downloadTitle}
          onEdit={filename.beginEdit}
          onClone={onClone}
        />
      </div>
      {children}
    </div>
  );
}

/** What {@link useFilenameEditor} hands back: the "Filename" row's value, and the Edit button's
 * action. */
interface FilenameEditor {
  /** The `<dd>` for the "Filename" info row — the name as text, or the editable input once
   * {@link beginEdit} has been called. */
  field: ReactNode;
  /** Open the field for editing, focused and selected. */
  beginEdit: () => void;
}

/**
 * The "Filename" info row, editable in place rather than through a dialog.
 *
 * Edits commit on blur or Enter and revert on Escape, the same as the experiment-name field a run
 * shows above it — a rename rewrites the file's id and its IndexedDB record
 * (`ZpcrStore.renameFile`), so committing per keystroke is not an option.
 */
function useFilenameEditor({
  name,
  display,
  onRename,
  autoEdit = false,
  onAutoEditHandled,
}: {
  name: string;
  display?: ReactNode;
  onRename: (name: string) => void;
  autoEdit?: boolean;
  onAutoEditHandled?: () => void;
}): FilenameEditor {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // Re-seed when the name changes underneath: a different file selected, or a rename arriving
  // from elsewhere.
  useEffect(() => setDraft(name), [name]);
  useEffect(() => {
    if (!autoEdit) return;
    setEditing(true);
    onAutoEditHandled?.();
  }, [autoEdit, onAutoEditHandled]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    // An emptied or unchanged field is not a rename — put the real name back and say nothing.
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    onRename(next);
  };

  return {
    beginEdit: () => setEditing(true),
    field: editing ? (
      <input
        className="overview__filename-input mono"
        value={draft}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
        aria-label="Filename"
        spellCheck={false}
      />
    ) : (
      (display ?? name)
    ),
  };
}

/**
 * The column of file buttons down the right of the info table — download, edit (the filename),
 * clone. Beside the table rather than under it, so the table keeps the full width of the panel
 * and the buttons don't move as it grows a row.
 */
function OverviewToolbar({
  name,
  onDownload,
  onEdit,
  onClone,
  downloadTitle = "Download this file as it stands in the browser, including any edits made here",
}: {
  /** The file's name — only for the buttons' accessible labels. */
  name: string;
  onDownload: () => void;
  onEdit: () => void;
  onClone: () => void;
  downloadTitle?: string;
}) {
  return (
    <div className="overview__toolbar">
      <button
        className="raw__download overview__downloadbtn"
        onClick={onDownload}
        aria-label={`Download ${name}`}
        title={downloadTitle}
      >
        <DownloadIcon />
      </button>
      <button
        className="raw__download overview__renamebtn"
        onClick={onEdit}
        aria-label={`Rename ${name}`}
        title="Rename this file"
      >
        <RenameIcon />
      </button>
      <button
        className="raw__download overview__clonebtn"
        onClick={onClone}
        aria-label={`Clone ${name}`}
        title="Make a copy of this file, kept alongside your other files, and open it to be renamed"
      >
        <CloneIcon />
      </button>
    </div>
  );
}
