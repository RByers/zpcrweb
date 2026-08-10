import { useCallback, useMemo, useState } from "react";
import { isPlateCsvName, isPltdName, type PlateDefinition, type Zpcr } from "@zpcrweb/core";
import { PlateEditor } from "../plate/PlateEditor";
import { PlateDownloadButton } from "../plate/PlateDownloadButton";
import { AttachPlateMenu } from "../plate/AttachPlateMenu";
import { PasswordPrompt } from "../PasswordPrompt";
import { usePltdPassword } from "../../state/pltdPassword";
import type { AttachSource } from "../../lib/attachSources";
import type { AddFilesOptions } from "../../state/useZpcrStore";

/**
 * Visual plate viewer for every plate file attached to the run — one per `.pltd`/`.plt.csv`
 * archive entry (a `.zpcr`) or the single embedded `plateSetup2` (a `.pcrd`); {@link Zpcr.plates}
 * covers all three uniformly. A peer of "Curves", separate from "Raw files" (which shows plate
 * data as a table instead, see `raw/PlateTable.tsx`).
 *
 * **A run's plate edits here**, in {@link PlateEditor} — the same grid, panel and gestures a
 * standalone `.plt.csv` gets, writing back into the run's archive instead of into a file of its
 * own (the store's `setRunPlateText`). What a run's plate says is a setup, not a result: the wells'
 * samples and targets are frequently what needs correcting after the fact, and until now the only
 * way to change one was to download the plate, edit it elsewhere and attach it back.
 *
 * Editing is offered for exactly the case it is safe in — {@link editableEntry}. It is the same
 * "only what this app can write" rule the standalone view follows, plus the archive's own
 * one-plate-per-run shape.
 *
 * Uses its own `.plateview` layout (flex, not `.raw`'s two-column grid) because the plate
 * list sidebar is conditional — a grid's fixed column tracks would misplace the lone
 * `.plateview__main` child when there's only one plate and no sidebar to fill the other track.
 */
export function PlatesView({
  zpcr,
  fileName,
  attachPlate,
  setRunPlateText,
  plateSources,
  addFiles,
}: {
  zpcr: Zpcr;
  fileName: string;
  attachPlate: (fileName: string, file: File) => Promise<void>;
  /** Persist an edit to the run's own plate entry — the store's `setRunPlateText`. */
  setRunPlateText: (fileName: string, entryName: string, plate: PlateDefinition) => void;
  /** Every plate the browser is holding that isn't this run's own — standalone files and plates
   * inside other loaded runs alike (`lib/attachSources.ts`), so "replace plate" can offer any of
   * them instead of only a fresh upload. */
  plateSources: AttachSource[];
  /** Adds a cloned `.plt.csv` to the file list — see `PlateDownloadButton`'s `onClone`. */
  addFiles: (files: FileList | File[], options?: AddFilesOptions) => Promise<string | null>;
}) {
  const [password, setPassword] = usePltdPassword();
  // Asked as a capability, not as a format: attaching a plate means writing an entry into the
  // run's archive, and downloading one means reading the `.pltd` bytes back out — both need an
  // archive to exist. A `.pcrd` has none (`EMPTY_ARCHIVE`), and so would any future format
  // without inner files. Phrasing it this way keeps the format-independence rule intact — see
  // `apps/web/ARCHITECTURE.md`, "Format independence".
  const hasArchive = zpcr.archive.entries.length > 0;
  const entries = useMemo(() => zpcr.plates(password || undefined), [zpcr, password]);
  const [selected, setSelected] = useState(0);

  // Both of these sit above the no-plates return below, where a hook has to be.
  const editable = useMemo(
    () => editableEntry(entries.map((e) => e.name), hasArchive),
    [entries, hasArchive],
  );
  const onChangePlate = useCallback(
    (plate: PlateDefinition) => {
      if (editable) setRunPlateText(fileName, editable, plate);
    },
    [editable, fileName, setRunPlateText],
  );

  const attachControl = (
    <AttachPlateMenu
      sources={plateSources}
      onAttach={(file) => void attachPlate(fileName, file)}
      compactLabel={entries.length === 0 ? "attach plate" : "replace plate"}
      // Icon-only where it sits in the toolbar beside download and clone, so all three read as one
      // row of controls. The empty state below has no such row — the control stands alone under a
      // "no plate files" line, where a bare icon would be the only thing on screen to find — so
      // there it keeps its label.
      iconOnly={entries.length > 0}
      confirmReplace={entries.length > 0}
      disabled={!hasArchive}
      disabledTitle="This run has no file archive to attach a plate to"
    />
  );

  if (entries.length === 0) {
    return (
      <div className="plateview plateview--empty">
        <div className="decoded__na mono">No plate files in this run.</div>
        {attachControl}
      </div>
    );
  }

  const entry = entries[Math.min(selected, entries.length - 1)]!;
  const { pltd } = entry;
  const pltdBytes =
    hasArchive && isPltdName(entry.name)
      ? { name: entry.name, bytes: zpcr.archive.bytes(entry.name) }
      : undefined;
  // The controls themselves, and the row they sit in. `PlateEditor` draws its own row (it has its
  // own Edit/Undo/Redo buttons to put in it), so it takes the bare controls; the no-plate branches
  // below have no heading line to share and render the row themselves.
  const tools = (
    <>
      {attachControl}
      <PlateDownloadButton plate={pltd.plate} pltd={pltdBytes} onClone={(file) => void addFiles([file])} />
    </>
  );
  const toolbar = <div className="plateview__toolbar">{tools}</div>;
  const showsViewer = !pltd.error && !pltd.needsPassword && !!pltd.plate;

  return (
    <div className="plateview">
      {entries.length > 1 && (
        <aside className="plateview__list raw__list">
          <div className="raw__group">
            <div className="raw__grouphead">Plates</div>
            {entries.map((e, i) => (
              <button
                key={e.name}
                className={"raw__item mono" + (i === selected ? " is-active" : "")}
                onClick={() => setSelected(i)}
                title={e.name}
              >
                {e.name}
              </button>
            ))}
          </div>
        </aside>
      )}

      <section className="plateview__main">
        {/* Handed to `PlateViewer` so it lands on the plate's heading line; the no-plate branches
            below have no heading to share, so they render it above their own content. */}
        {showsViewer ? null : toolbar}
        {pltd.container.encrypted && (pltd.needsPassword || pltd.error) ? (
          <div className="decoded">
            <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
          </div>
        ) : pltd.error ? (
          <div className="decoded__na mono">{pltd.error}</div>
        ) : !pltd.plate ? (
          <div className="decoded__na mono">No plate for {entry.name}.</div>
        ) : (
          <PlateEditor
            plate={pltd.plate}
            sourceHint={entry.name}
            tools={tools}
            // The pencil appears only for the entry `editableEntry` picked out — with several
            // plates in the archive, or a `.pltd` this app cannot write, the grid stays read-only
            // exactly as it was.
            onChange={editable === entry.name ? onChangePlate : undefined}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Which of a run's plate entries the editor may write to, or `null` for none — three conditions,
 * each about what is actually possible rather than about permission:
 *
 * 1. **There is an archive to write into.** A `.pcrd` has none (`EMPTY_ARCHIVE`), so its embedded
 *    plate has nowhere to be saved. Asked as a capability, like `hasArchive` above.
 * 2. **The entry is a `.plt.csv`.** This app has no `.pltd` writer (`pltcsv.md`) — the same reason
 *    a standalone `.pltd` gets no pencil. Cloning one produces a `.plt.csv` that does edit.
 * 3. **It is the run's only plate.** Saving goes through core's `attachPlate`, whose contract is
 *    that a run ends up with one plate entry; running it on an archive holding two would drop the
 *    other. A run with two plates is unusual enough that read-only is the honest answer, rather
 *    than a second write path that exists for it alone.
 */
function editableEntry(names: string[], hasArchive: boolean): string | null {
  if (!hasArchive || names.length !== 1) return null;
  const only = names[0]!;
  return isPlateCsvName(only) ? only : null;
}
