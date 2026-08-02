import { useEffect, useState, type ReactNode } from "react";
import { DownloadIcon } from "./DownloadIcon";
import { RenameIcon } from "./RenameIcon";
import { CloneIcon } from "./CloneIcon";

/**
 * The file-level tools every Overview tab carries, shared by all three of them
 * ({@link OverviewView}, {@link StandalonePlateOverviewView}, {@link StandaloneProtocolOverview}).
 *
 * They act on the *file* — download it, rename it, copy it — which is the one thing every kind
 * has in common, so the three panels offer the identical column of buttons rather than each
 * format getting whichever subset happened to be wired up. The editable "Filename" row the Edit
 * button opens lives here too ({@link useFilenameEditor}): it is the other half of the same
 * control, and having each panel keep its own copy of the commit-on-blur/Escape-reverts logic was
 * how they drifted apart in the first place.
 */

/** What {@link useFilenameEditor} hands back to a panel: the "Filename" row's value, and the
 * Edit button's action. */
export interface FilenameEditor {
  /** The `<dd>` for the "Filename" info row — the name as text, or the editable input once
   * {@link beginEdit} has been called. */
  field: ReactNode;
  /** Open the field for editing, focused and selected. The toolbar's Edit button. */
  beginEdit: () => void;
}

/**
 * The "Filename" info row, editable in place rather than through a dialog.
 *
 * Edits commit on blur or Enter and revert on Escape, the same as the experiment-name field
 * above it — a rename rewrites the file's id and its IndexedDB record (`ZpcrStore.renameFile`),
 * so committing per keystroke is not an option.
 */
export function useFilenameEditor({
  name,
  display,
  onRename,
  autoEdit = false,
  onAutoEditHandled,
}: {
  /** The file's current name — what the field is seeded with and reverts to. */
  name: string;
  /** What to show when not editing, if that differs from `name` (a run shows its resolved
   * `ExperimentIdentity.fileName`). Defaults to `name`. */
  display?: ReactNode;
  onRename: (name: string) => void;
  /** Open the editor as soon as this turns true — how a freshly cloned file lands with its name
   * ready to be typed over (see `App.tsx`'s `cloneActiveFile`). */
  autoEdit?: boolean;
  /** Called once `autoEdit` has been acted on, so the request isn't re-applied on every render. */
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
 * The column of file buttons down the right of an Overview panel — download, edit (the filename),
 * clone. Beside the info table rather than under it, so the table keeps the full width of the
 * panel and the buttons don't move as the table grows a row.
 */
export function OverviewToolbar({
  name,
  onDownload,
  onEdit,
  onClone,
  downloadTitle = "Download this file as it stands in the browser, including any edits made here",
}: {
  /** The file's name — only for the buttons' accessible labels. */
  name: string;
  onDownload: () => void;
  /** Open the "Filename" row for editing — {@link FilenameEditor.beginEdit}. */
  onEdit: () => void;
  /** Copy the file under a `(N)` name and open the copy, ready to be renamed — see
   * `App.tsx`'s `cloneActiveFile`. */
  onClone: () => void;
  /** A `.zpcr` says more, since its download is not the bytes that were loaded. */
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
