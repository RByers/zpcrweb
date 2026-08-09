import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { PlateDefinition, WellDefinition } from "@zpcrweb/core";
import type { PlateGridSelection } from "./PlateViewer";

/**
 * Which wells the plate editor is pointed at, and the spreadsheet gestures that change that.
 *
 * Selection is a set of well indices plus an **anchor** — the well a range extends from, which is
 * the cell the last plain click or arrow key landed on. Every rule below is a spreadsheet's:
 *
 * | gesture | meaning |
 * |---|---|
 * | click | select this well alone, and anchor here |
 * | Cmd/Ctrl-click | add this well to (or remove it from) the selection |
 * | Shift-click | select the rectangle from the anchor to here |
 * | drag | sweep a rectangle out from where the drag started |
 * | row letter / column number / corner | that whole row, column, or the plate |
 * | arrows / Shift-arrows | move the anchor / extend the rectangle from it |
 * | Cmd/Ctrl-A, Escape | select everything, select nothing |
 *
 * Modifier-click on a header composes the same way: Cmd/Ctrl adds the row or column to what is
 * already selected, Shift takes every row or column between the anchor's and this one.
 *
 * **The selection is state about the grid, not about the plate**, so it lives here and not in the
 * file: it survives an edit (edit a column's sample, the column stays selected, which is what
 * makes a run of edits to one group of wells bearable) and dies with edit mode. What it does *not*
 * do is outlive the plate's shape — a plate that grows or shrinks under it drops the wells that no
 * longer exist, so a stale index can never be handed to an edit.
 */
export interface PlateSelection extends PlateGridSelection {
  /** The well a range extends from, or `null` when nothing is selected. */
  anchor: number | null;
  /** Selected wells, in plate order — what an edit or a copy applies to. */
  indices: number[];
  /** Selected wells themselves, saving every caller the same lookup. */
  wells: WellDefinition[];
  selectAll: () => void;
  clearSelection: () => void;
  /** Arrow-key movement: one well in a direction, optionally extending the rectangle. */
  moveAnchor: (dRow: number, dCol: number, extend: boolean) => void;
  /** Replace the selection outright — the "select every well like this one" affordances. */
  setSelection: (indices: Iterable<number>) => void;
}

/** Every well index in the rectangle whose opposite corners are the two given wells. */
function rect(plate: PlateDefinition, a: number, b: number): number[] {
  const [r1, c1] = [Math.floor(a / plate.columns), a % plate.columns];
  const [r2, c2] = [Math.floor(b / plate.columns), b % plate.columns];
  const out: number[] = [];
  for (let row = Math.min(r1, r2); row <= Math.max(r1, r2); row++) {
    for (let col = Math.min(c1, c2); col <= Math.max(c1, c2); col++) {
      out.push(row * plate.columns + col);
    }
  }
  return out;
}

function rowIndices(plate: PlateDefinition, row: number): number[] {
  return Array.from({ length: plate.columns }, (_, c) => row * plate.columns + c);
}

function columnIndices(plate: PlateDefinition, col: number): number[] {
  return Array.from({ length: plate.rows }, (_, r) => r * plate.columns + col);
}

export function usePlateSelection(plate: PlateDefinition): PlateSelection {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  /** Set while the mouse is down over the grid: the anchor the sweep extends from, and the
   * selection to union each step with (empty unless the drag began additively). */
  const drag = useRef<{ from: number; base: ReadonlySet<number> } | null>(null);

  const wellCount = plate.rows * plate.columns;
  // A plate that changed shape under the selection — a different file, a pasted block that grew
  // it — must not leave indices behind that no longer name a well.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((i) => i < wellCount));
      return next.size === prev.size ? prev : next;
    });
    setAnchor((prev) => (prev !== null && prev >= wellCount ? null : prev));
  }, [wellCount]);

  // A drag ends wherever the mouse is released, including outside the grid or the window.
  useEffect(() => {
    const end = () => {
      drag.current = null;
    };
    window.addEventListener("mouseup", end);
    return () => window.removeEventListener("mouseup", end);
  }, []);

  const setSelection = useCallback((indices: Iterable<number>) => {
    setSelected(new Set(indices));
  }, []);

  /** The one place the modifier rules are written down — see the table in {@link PlateSelection}.
   * `next` is what the gesture points at; how it combines with what is already selected is the
   * modifiers' business. */
  const apply = useCallback(
    (next: number[], e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
      const additive = e.metaKey || e.ctrlKey;
      setSelected((prev) => {
        if (!additive) return new Set(next);
        const union = new Set(prev);
        // Cmd-clicking a single well that is already in the selection removes it, the way a
        // spreadsheet deselects one cell of a block; Cmd-clicking a whole row or column only ever
        // adds, since "toggle each of twelve wells" has no useful meaning.
        if (next.length === 1 && union.has(next[0]!) && !e.shiftKey) union.delete(next[0]!);
        else for (const i of next) union.add(i);
        return union;
      });
    },
    [],
  );

  const onWellDown = useCallback(
    (well: WellDefinition, e: MouseEvent) => {
      // Without this a drag across cells selects the text in them instead of the wells.
      e.preventDefault();
      if (e.shiftKey && anchor !== null) {
        apply(rect(plate, anchor, well.index), e);
        drag.current = { from: anchor, base: e.metaKey || e.ctrlKey ? selected : new Set() };
        return;
      }
      apply([well.index], e);
      setAnchor(well.index);
      drag.current = { from: well.index, base: e.metaKey || e.ctrlKey ? selected : new Set() };
    },
    [anchor, apply, plate, selected],
  );

  const onWellEnter = useCallback(
    (well: WellDefinition) => {
      const d = drag.current;
      if (!d) return;
      setSelected(new Set([...d.base, ...rect(plate, d.from, well.index)]));
    },
    [plate],
  );

  const onRowHead = useCallback(
    (row: number, e: MouseEvent) => {
      e.preventDefault();
      const anchorRow = anchor === null ? row : Math.floor(anchor / plate.columns);
      const rows =
        e.shiftKey && anchor !== null
          ? rangeBetween(anchorRow, row)
          : [row];
      apply(rows.flatMap((r) => rowIndices(plate, r)), e);
      if (!e.shiftKey) setAnchor(row * plate.columns);
    },
    [anchor, apply, plate],
  );

  const onColumnHead = useCallback(
    (col: number, e: MouseEvent) => {
      e.preventDefault();
      const anchorCol = anchor === null ? col : anchor % plate.columns;
      const cols = e.shiftKey && anchor !== null ? rangeBetween(anchorCol, col) : [col];
      apply(cols.flatMap((c) => columnIndices(plate, c)), e);
      if (!e.shiftKey) setAnchor(col);
    },
    [anchor, apply, plate],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(plate.wells.map((w) => w.index)));
    setAnchor((prev) => prev ?? 0);
  }, [plate]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAnchor(null);
  }, []);

  const onAllHead = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      selectAll();
    },
    [selectAll],
  );

  const moveAnchor = useCallback(
    (dRow: number, dCol: number, extend: boolean) => {
      const from = anchor ?? 0;
      // Extending measures from the *edge* of what is selected, so Shift-↓↓ grows a range two
      // wells instead of redrawing the same one; a plain move walks from the anchor itself.
      const reach = extend ? furthestFrom(plate, selected, from, dRow, dCol) : from;
      const row = Math.min(plate.rows - 1, Math.max(0, Math.floor(reach / plate.columns) + dRow));
      const col = Math.min(plate.columns - 1, Math.max(0, (reach % plate.columns) + dCol));
      const to = row * plate.columns + col;
      if (extend) {
        // The anchor stays put — that is what makes the rectangle grow from one end.
        setSelected(new Set(rect(plate, from, to)));
        return;
      }
      setSelected(new Set([to]));
      setAnchor(to);
    },
    [anchor, plate, selected],
  );

  const indices = useMemo(() => [...selected].sort((a, b) => a - b), [selected]);
  const wells = useMemo(
    () => indices.map((i) => plate.wells[i]).filter((w): w is WellDefinition => !!w),
    [indices, plate],
  );

  return {
    selected,
    anchor,
    indices,
    wells,
    onWellDown,
    onWellEnter,
    onRowHead,
    onColumnHead,
    onAllHead,
    selectAll,
    clearSelection,
    moveAnchor,
    setSelection,
  };
}

/**
 * The selected well furthest from the anchor in the direction being extended — the corner a
 * Shift-arrow grows from. Falls back to the anchor when the selection says nothing about that
 * direction (nothing selected, or a selection that doesn't reach past the anchor).
 */
function furthestFrom(
  plate: PlateDefinition,
  selected: ReadonlySet<number>,
  anchor: number,
  dRow: number,
  dCol: number,
): number {
  let best = anchor;
  let bestScore = 0;
  const aRow = Math.floor(anchor / plate.columns);
  const aCol = anchor % plate.columns;
  for (const i of selected) {
    const score = (Math.floor(i / plate.columns) - aRow) * dRow + ((i % plate.columns) - aCol) * dCol;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function rangeBetween(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}
