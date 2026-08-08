/**
 * The ✕ that closes a file — the only way a file leaves the app, and so the only thing standing
 * between someone and work they can't get back.
 *
 * Closing a file drops its bytes from memory *and* its records from IndexedDB, in one act (see
 * `useZpcrStore`'s `closeFile`). For almost every file that costs nothing: it was uploaded from
 * disk, or it lives in a folder on disk and its edits have already been written back there, so
 * closing it is closing a document, not discarding one. The exception is a file carrying edits that
 * exist nowhere but this browser — a run pulled off the instrument, an uploaded file whose
 * thresholds have been moved — and for those, and only those, the first click **arms** (a red waste
 * bin) and the second one does it.
 *
 * Two places show this control — a file's chip on the bar, and its row in the Files table — and
 * they are the same control, one component with a caller-supplied class and an optional slot for
 * whatever else belongs in the button (the chip puts its "unsaved" dot there). The two used to
 * disagree: the chip released without asking while the table always asked twice, which meant the
 * same file answered "is this safe?" differently depending on where you clicked.
 */
import { useState } from "react";
import { TrashIcon } from "./TrashIcon";

export function CloseFileButton({
  name,
  modified,
  onClose,
  className,
  children,
}: {
  /** What to call the file in the button's label and tooltip — its experiment name, not its
   * filename, since that is what the chip and the row both lead with. */
  name: string;
  /** Whether this file has edits no copy on disk has (`ZpcrStore.modifiedIds`) — the whole of what
   * decides between one click and two. */
  modified: boolean;
  onClose: () => void;
  /** The caller's own class for the button box; `is-armed` is appended while armed. */
  className: string;
  /** Anything else inside the button — the chip's modified dot. */
  children?: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const arming = modified && !armed;
  return (
    <button
      className={className + (armed ? " is-armed" : "")}
      aria-label={
        arming
          ? `Close ${name} — it has changes that aren't on disk`
          : armed
            ? `Confirm closing ${name}, losing its unsaved changes`
            : `Close ${name}`
      }
      title={
        arming
          ? "Close. This file has changes that aren't on disk — download it first to keep them."
          : armed
            ? "Click again to close and lose those changes"
            : "Close"
      }
      // Moving away disarms: an armed button left sitting under the pointer is a trap for the next
      // click that lands near it.
      onMouseLeave={() => setArmed(false)}
      onClick={(e) => {
        // Both call sites are inside something clickable of their own — a chip that selects, a
        // table row that opens the file.
        e.stopPropagation();
        if (armed || !modified) onClose();
        else setArmed(true);
      }}
    >
      {armed ? <TrashIcon /> : <span className="closefile__glyph">✕</span>}
      {children}
    </button>
  );
}
