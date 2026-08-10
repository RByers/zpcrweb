import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  applyWellPatches,
  clearPatch,
  editWells,
  formatPlateBlock,
  parsePlateBlock,
  plateToCsv,
  setPlateFluors,
  type FileKind,
  type PlateDefinition,
  type WellPatch,
} from "@zpcrweb/core";
import { PlateViewer } from "./PlateViewer";
import { PlateEditPanel } from "./PlateEditPanel";
import { usePlateSelection } from "./usePlateSelection";
import { RenameIcon } from "../RenameIcon";

/**
 * The editor for a plate — a standalone `.plt.csv` file (`StandalonePlateView`) or the plate
 * inside a run's archive (`PlatesView`), which are the same grid and the same gestures differing
 * only in where `onChange` puts the result. The plate-side counterpart of `ProtocolEditor`, and
 * deliberately the same shape as it:
 *
 * - **It never edits text.** Every change goes through core's plate edit primitives
 *   (`plateEdit.ts`), which own what a plate is allowed to look like — a well is loaded iff it
 *   carries a dye, the plate's target/sample lists follow its wells, the vessel is stated once —
 *   and `plateToCsv` owns how it is spelled. This component owns only the interaction.
 * - **Done is not Save.** Edits are written to the file as they are made (rate-limited by
 *   `writeThrottle.ts`, shared with the protocol editor and `zpcrweb.json` settings); the
 *   Edit/Done button switches the grid between reading and editing and nothing else. Leaving the
 *   view — or the app — therefore cannot lose an edit, and the editor simply unmounts.
 * - **One grid, two modes.** The same `PlateViewer` renders both; edit mode hands it a selection
 *   (`usePlateSelection.ts`) and gains the right-hand panel (`PlateEditPanel.tsx`). There is no
 *   second plate grid to keep in sync with the first.
 *
 * **Only a `.plt.csv` is editable**, which is a fact about writers, not about permissions: this
 * app has no `.pltd` writer (`pltcsv.md`), so there would be nowhere to put an edit to one. A
 * `.pltd` still reads, and cloning it produces a `.plt.csv` that does edit — which is what the
 * clone button beside this one is for. The rule holds inside a run's archive too; `PlatesView`'s
 * `editableEntry` is where a run's extra conditions on it live.
 *
 * The clipboard is the system's (`copy`/`cut`/`paste` events, so Cmd-C/V work with no permission
 * prompt and interchange with a spreadsheet — `plateClipboard.ts` is the format). An in-app copy
 * of the last block is kept as well, for the case where a browser hands us a paste event with no
 * readable text. Both those handlers, and the keyboard ones beside them, stand aside for a focused
 * text field — so the grid takes focus when it is clicked, or the last field typed in would keep
 * swallowing every shortcut (`PlateViewer`'s `gridRef`).
 */
export function PlateEditor({
  plate,
  kind,
  sourceHint,
  tools,
  onChange,
}: {
  plate: PlateDefinition;
  kind?: FileKind;
  sourceHint?: string;
  /** The view's own attach/download/clone buttons, so they share this block's heading line —
   * the same slot `PlateViewer` takes them through when there is no editor. */
  tools?: ReactNode;
  /** Persist an edited plate — the store's `setPlateText`, throttled on its own. Absent for a
   * plate that can't be written back, which is what makes the Edit button disappear. */
  onChange?: (plate: PlateDefinition) => void;
}) {
  const [editing, setEditing] = useState(false);
  const { current, commit, undo, redo, canUndo, canRedo } = usePlateHistory(plate, onChange);
  const selection = usePlateSelection(current);
  const { indices, clearSelection } = selection;
  /** The last block this editor copied — the fallback when a paste event carries no text of its
   * own (a browser that hands us an empty `clipboardData`). */
  const lastCopied = useRef("");

  const editable = !!onChange;
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  // Leaving edit mode leaves nothing selected, so re-entering it starts clean rather than acting
  // on wells chosen before the last change.
  useEffect(() => {
    if (!editing) clearSelection();
  }, [editing, clearSelection]);

  const patchSelection = useCallback(
    (patch: WellPatch) => commit(editWells(current, indices, patch)),
    [commit, current, indices],
  );
  const clearSelected = useCallback(
    () => commit(editWells(current, indices, clearPatch(current))),
    [commit, current, indices],
  );

  const paste = useCallback(
    (text: string) => {
      const block = parsePlateBlock(text, current);
      if (!block || indices.length === 0) return;
      const patches = new Map<number, WellPatch>();
      if (block.rows.length === 1 && block.rows[0]!.length === 1) {
        // A single well pasted onto a selection fills all of it — the spreadsheet behaviour, and
        // the quickest way to stamp one setup across a block.
        for (const i of indices) patches.set(i, block.rows[0]![0]!);
      } else {
        // Otherwise the block lands with its top-left corner on the selection's, and anything
        // that would fall off the plate is dropped.
        const top = Math.min(...indices.map((i) => Math.floor(i / current.columns)));
        const left = Math.min(...indices.map((i) => i % current.columns));
        block.rows.forEach((cells, r) =>
          cells.forEach((patch, c) => {
            const row = top + r;
            const col = left + c;
            if (row < current.rows && col < current.columns) patches.set(row * current.columns + col, patch);
          }),
        );
      }
      commit(applyWellPatches(current, patches));
    },
    [commit, current, indices],
  );

  /**
   * Everything the window listeners below act on, mirrored into a ref on every render.
   *
   * The listeners must never see a stale selection: they are registered once per edit-mode entry,
   * while the selection changes on every click, and a `copy` arriving between a click and the
   * effect that re-registers would copy the *previous* block. (Not a theoretical race — it is what
   * a scripted click-then-copy reproduces every time.) Reading through the ref makes the
   * registration irrelevant to correctness.
   */
  const live = useRef({ current, indices, paste, clearSelected, clearSelection, selection, undo, redo });
  live.current = { current, indices, paste, clearSelected, clearSelection, selection, undo, redo };

  // Keyboard and clipboard, both live only while editing and both step aside for a field that has
  // focus — where the keystroke belongs to the text being typed, not to the plate.
  useEffect(() => {
    if (!editing) return;
    const inField = (target: EventTarget | null) => {
      const tag = (target as HTMLElement | null)?.tagName;
      return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    };

    const onKey = (e: KeyboardEvent) => {
      if (inField(e.target)) return;
      const { indices, selection, clearSelection, clearSelected, undo, redo } = live.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "a") {
          e.preventDefault();
          selection.selectAll();
        } else if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if (key === "y" || (key === "z" && e.shiftKey)) {
          e.preventDefault();
          redo();
        }
        return;
      }
      if (e.key === "Escape") {
        clearSelection();
      } else if ((e.key === "Delete" || e.key === "Backspace") && indices.length) {
        e.preventDefault();
        clearSelected();
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step: Record<string, [number, number]> = {
          ArrowUp: [-1, 0],
          ArrowDown: [1, 0],
          ArrowLeft: [0, -1],
          ArrowRight: [0, 1],
        };
        const [dRow, dCol] = step[e.key] ?? [0, 0];
        selection.moveAnchor(dRow, dCol, e.shiftKey);
      }
    };

    const onCopy = (e: ClipboardEvent) => {
      const { current, indices, clearSelected } = live.current;
      if (inField(e.target) || indices.length === 0) return;
      const text = formatPlateBlock(current, indices);
      if (!text) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
      lastCopied.current = text;
      if (e.type === "cut") clearSelected();
    };

    const onPaste = (e: ClipboardEvent) => {
      const { indices, paste } = live.current;
      if (inField(e.target) || indices.length === 0) return;
      const text = e.clipboardData?.getData("text/plain") || lastCopied.current;
      if (!text) return;
      e.preventDefault();
      paste(text);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCopy);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCopy);
      window.removeEventListener("paste", onPaste);
    };
    // Registered once per edit-mode entry: everything that varies is read through `live` above.
  }, [editing]);

  const toolbar = (
    <>
      {tools}
      {editing && (
        <>
          <button type="button" className="btn btn--sm" onClick={undo} disabled={!canUndo} title="Undo (Ctrl-Z)">
            ↶ Undo
          </button>
          <button type="button" className="btn btn--sm" onClick={redo} disabled={!canRedo} title="Redo (Ctrl-Y)">
            ↷ Redo
          </button>
        </>
      )}
      {editable && (
        // The pencil, matching the protocol editor's and Overview's rename buttons — the same
        // "turn this into something I can change" affordance. It becomes a labelled Done button
        // while editing, because an icon would not say how to get out.
        <button
          type="button"
          className={editing ? "btn btn--sm btn--primary" : "raw__download"}
          onClick={() => setEditing((v) => !v)}
          aria-label={editing ? "Finish editing this plate" : "Edit this plate"}
          title={
            editing
              ? "Finish editing. Changes are already saved — this only puts the grid back to reading."
              : "Edit this plate: samples, targets, sample and vessel types"
          }
        >
          {editing ? "Done" : <RenameIcon />}
        </button>
      )}
    </>
  );

  return (
    <div className={"plateedit" + (editing ? " is-editing" : "")}>
      <div className="plateedit__grid">
        <PlateViewer
          plate={current}
          kind={kind}
          sourceHint={sourceHint}
          toolbar={<div className="plateview__toolbar">{toolbar}</div>}
          selection={editing ? selection : undefined}
        />
      </div>
      {editing && (
        <PlateEditPanel
          plate={current}
          selection={selection}
          onPatch={patchSelection}
          onClear={clearSelected}
          onFluors={(fluors) => commit(setPlateFluors(current, fluors))}
        />
      )}
    </div>
  );
}

/** One entry of the undo stack: the plate, and its serialization — which is both what gets
 * written to the file and the only cheap way to compare two plates for equality. */
interface Snapshot {
  plate: PlateDefinition;
  csv: string;
}

/**
 * Undo/redo over the whole plate, as a stack of snapshots — the same design as the protocol
 * editor's `useProtocolHistory`, for the same reasons, and with the same subtlety: the history
 * lives in a ref mirrored into state, and `current` — not the `plate` prop — is what the editor
 * edits. The two are the same value in the steady state and differ only for the moment between an
 * edit being made and the store's re-parsed plate coming back down as a prop. Editing the prop in
 * that window means editing the *previous* plate, which is the bug that only shows up when two
 * edits land in quick succession.
 *
 * A plate that changed underneath us — a different file selected, the bytes re-read — restarts the
 * history rather than leaving undo pointing at another file's wells. "Underneath us" is judged
 * against the whole stack (by serialization, since the store hands back a re-parsed object that is
 * never identical to the one we emitted), not against the last value emitted: several edits can
 * land before the first effect runs, so this routinely sees a value of ours that simply isn't the
 * newest.
 */
function usePlateHistory(plate: PlateDefinition, onChange?: (plate: PlateDefinition) => void) {
  const snapshot = useCallback((p: PlateDefinition): Snapshot => ({ plate: p, csv: plateToCsv(p) }), []);
  const [history, setHistory] = useState<{ stack: Snapshot[]; pos: number }>(() => ({
    stack: [snapshot(plate)],
    pos: 0,
  }));
  const ref = useRef(history);
  const apply = useCallback((next: { stack: Snapshot[]; pos: number }) => {
    ref.current = next;
    setHistory(next);
  }, []);

  useEffect(() => {
    const csv = plateToCsv(plate);
    if (ref.current.stack.some((s) => s.csv === csv)) return;
    apply({ stack: [{ plate, csv }], pos: 0 });
  }, [plate, apply]);

  const commit = useCallback(
    (next: PlateDefinition) => {
      const entry = snapshot(next);
      const { stack, pos } = ref.current;
      if (entry.csv === stack[pos]?.csv) return;
      const nextStack = [...stack.slice(0, pos + 1), entry];
      apply({ stack: nextStack, pos: nextStack.length - 1 });
      onChange?.(next);
    },
    [apply, onChange, snapshot],
  );

  const step = useCallback(
    (delta: number) => {
      const { stack, pos } = ref.current;
      const to = pos + delta;
      if (to < 0 || to >= stack.length) return;
      apply({ stack, pos: to });
      onChange?.(stack[to]!.plate);
    },
    [apply, onChange],
  );

  return {
    /** The plate as this editor last left it — see the note above on why not the prop. */
    current: useMemo(() => history.stack[history.pos]!.plate, [history]),
    commit,
    undo: useCallback(() => step(-1), [step]),
    redo: useCallback(() => step(1), [step]),
    canUndo: history.pos > 0,
    canRedo: history.pos < history.stack.length - 1,
  };
}
