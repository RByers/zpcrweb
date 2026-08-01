/**
 * Which loaded files make up the run the Device view would start.
 *
 * A run needs two things — a thermal protocol and a plate map — and the app's loaded files supply
 * them in two shapes: a whole run (`.zpcr`/`.pcrd`/Biomeme) carries both, while a `.prcl.txt` or a
 * `.pltd`/`.plt.csv` carries exactly one. So the selection is not "the active file": it is **one
 * optional run, plus an optional override of each half**, which is what lets a protocol from one
 * place be paired with a plate from another.
 *
 * The rules, and the reasoning behind the one that isn't obvious:
 *
 * - Selecting a run replaces any other run — two runs would each claim both halves.
 * - Selecting a protocol or plate file **overrides** that half of the run; tapping it again
 *   releases it.
 * - A run with *both* halves overridden contributes nothing, so it is deselected rather than left
 *   highlighted as if it were still part of the answer. This is the invariant the model rests on:
 *   what the chips show selected is exactly what the staged run is made of.
 * - Consequently, selecting a run while both overrides are up clears them. Without that the
 *   selection would be undone by the invariant and the click would appear to do nothing.
 *
 * **Newly loaded files join the selection.** Loading a file makes it active (`useZpcrStore`'s
 * `addFiles`), and this hook folds an active file into the selection by role. That is what makes
 * the headline flow work — load a `.prcl.txt`, land on the Device view, see it staged against the
 * run you already had — without it replacing the whole selection, which is what a naive "the
 * active file is the selection" rule would do.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileKind, LoadedFile } from "./useZpcrStore";

/** Which half of a run a file kind can supply. */
export type StagingRole = "run" | "protocol" | "plate";

export function stagingRole(kind: FileKind): StagingRole {
  if (kind === "prcl") return "protocol";
  if (kind === "pltd" || kind === "csv") return "plate";
  return "run";
}

export interface RunStagingSelection {
  /** A whole run supplying whichever halves aren't overridden. */
  runId: string | null;
  /** A `.prcl.txt` overriding the protocol. */
  protocolId: string | null;
  /** A `.pltd`/`.plt.csv` overriding the plate. */
  plateId: string | null;
}

const EMPTY: RunStagingSelection = { runId: null, protocolId: null, plateId: null };

const isEmpty = (s: RunStagingSelection) => !s.runId && !s.protocolId && !s.plateId;

/**
 * Enforce the invariant: a run whose every half is overridden isn't part of the answer. One
 * function so the rule lives in a single place rather than at each site that can break it.
 */
function settle(sel: RunStagingSelection): RunStagingSelection {
  return sel.protocolId && sel.plateId && sel.runId ? { ...sel, runId: null } : sel;
}

/** Add `file` to the selection in whichever role it can play, replacing any current holder. */
function select(sel: RunStagingSelection, id: string, role: StagingRole): RunStagingSelection {
  switch (role) {
    case "run":
      // Clearing both overrides is what keeps this selection visible; see the module comment.
      return sel.protocolId && sel.plateId
        ? { runId: id, protocolId: null, plateId: null }
        : settle({ ...sel, runId: id });
    case "protocol":
      return settle({ ...sel, protocolId: id });
    case "plate":
      return settle({ ...sel, plateId: id });
  }
}

export function useRunStaging(files: LoadedFile[], activeId: string | null) {
  const [selection, setSelection] = useState<RunStagingSelection>(EMPTY);

  // Files disappear (the chip's ✕, or a same-name replacement), and a selection pointing at one
  // that's gone would stage a run out of nothing. Resolved on read rather than by an effect, so
  // there is no window in which the two disagree.
  const live = useMemo(() => {
    const ids = new Set(files.map((f) => f.id));
    const keep = (id: string | null) => (id && ids.has(id) ? id : null);
    return settle({
      runId: keep(selection.runId),
      protocolId: keep(selection.protocolId),
      plateId: keep(selection.plateId),
    });
  }, [files, selection]);

  // Fold each newly active file in — on mount for whatever was already active, and thereafter
  // whenever a load or a `#file=` link changes it. Only on *change*: re-running this on every
  // render would undo a deselection the moment it happened, since the file stays active.
  const lastActive = useRef<string | null>(null);
  useEffect(() => {
    if (activeId === lastActive.current) return;
    lastActive.current = activeId;
    const file = activeId ? files.find((f) => f.id === activeId) : undefined;
    if (!file) return;
    setSelection((prev) => select(prev, file.id, stagingRole(file.kind)));
  }, [activeId, files]);

  /**
   * With nothing selected at all, fall back to the first run loaded. Arriving at the Device view
   * with files loaded and an empty panel reads as broken, and a run is the one file kind that can
   * fill the panel on its own.
   */
  const effective = useMemo(() => {
    if (!isEmpty(live)) return live;
    const firstRun = files.find((f) => stagingRole(f.kind) === "run");
    return firstRun ? { ...EMPTY, runId: firstRun.id } : EMPTY;
  }, [live, files]);

  const toggle = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (!file) return;
      const role = stagingRole(file.kind);
      setSelection(() => {
        // Build on what's on screen, not on raw state: until the first tap the panel is showing
        // `effective`, and a tap has to act on what the user can see.
        const base = effective;
        // Only the overrides toggle off. A run is the base a staged run is built on, so tapping
        // the selected one again would empty the panel for no stated reason.
        if (role === "protocol" && base.protocolId === id) return { ...base, protocolId: null };
        if (role === "plate" && base.plateId === id) return { ...base, plateId: null };
        return select(base, id, role);
      });
    },
    [files, effective],
  );

  const selectedIds = useMemo(
    () =>
      new Set(
        [effective.runId, effective.protocolId, effective.plateId].filter((x): x is string => !!x),
      ),
    [effective],
  );

  return { selection: effective, selectedIds, toggle };
}

export type RunStaging = ReturnType<typeof useRunStaging>;
