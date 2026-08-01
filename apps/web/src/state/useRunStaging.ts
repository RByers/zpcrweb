/**
 * Which loaded files make up the run the Device view would start.
 *
 * A run needs two things — a thermal protocol and a plate map — and the app's loaded files supply
 * them in two shapes: a whole run (`.zpcr`/`.pcrd`/Biomeme) carries both, while a `.prcl.txt` or a
 * `.pltd`/`.plt.csv` carries exactly one. So the selection is not "the active file": it is **three
 * independent slots** — a run, a protocol override, a plate override — which is what lets a
 * protocol from one place be paired with a plate from another.
 *
 * The rules:
 *
 * - Each slot holds at most one file, and selecting a file replaces whatever held its slot. Two
 *   runs would each claim both halves, so only one run at a time.
 * - Tapping a selected file releases its slot. Every slot behaves the same way, so any
 *   combination is reachable and so is "no run at all".
 * - A protocol or plate override **supersedes** that half of the run.
 *
 * A run whose halves are *both* overridden is still worth having selected, which is why it isn't
 * cleared: it carries the `.Dcal` calibration set, and that is what gives a `.plt.csv` its
 * dye→channel mapping (`lib/protocolSource.ts`). A plate CSV records dye names only, so with no
 * run to say which instrument they were read on, its channels are simply unknown. The third slot
 * therefore also means "and this is the instrument" — and the panel says so, rather than leaving a
 * chip lit for no visible reason.
 *
 * **Newly loaded files join the selection.** Loading a file makes it active (`useZpcrStore`'s
 * `addFiles`), and this hook folds an active file into its slot. That is what makes the headline
 * flow work — load a `.prcl.txt`, land on the Device view, see it staged against the run you
 * already had — without it replacing the whole selection, which is what a naive "the active file
 * is the selection" rule would do.
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
  /** A whole run: whichever halves aren't overridden, and always the calibration set. */
  runId: string | null;
  /** A `.prcl.txt` superseding the run's protocol. */
  protocolId: string | null;
  /** A `.pltd`/`.plt.csv` superseding the run's plate. */
  plateId: string | null;
}

const EMPTY: RunStagingSelection = { runId: null, protocolId: null, plateId: null };

/** The slot each role occupies, so the three cases aren't spelled out at every call site. */
const SLOT: Record<StagingRole, keyof RunStagingSelection> = {
  run: "runId",
  protocol: "protocolId",
  plate: "plateId",
};

export function useRunStaging(files: LoadedFile[], activeId: string | null) {
  const [selection, setSelection] = useState<RunStagingSelection>(EMPTY);

  // Files disappear (the chip's ✕, or a same-name replacement), and a selection pointing at one
  // that's gone would stage a run out of nothing. Resolved on read rather than by an effect, so
  // there is no window in which the two disagree.
  const live = useMemo(() => {
    const ids = new Set(files.map((f) => f.id));
    const keep = (id: string | null) => (id && ids.has(id) ? id : null);
    return {
      runId: keep(selection.runId),
      protocolId: keep(selection.protocolId),
      plateId: keep(selection.plateId),
    };
  }, [files, selection]);

  const lastActive = useRef<string | null>(null);
  const seeded = useRef(false);

  /**
   * Seed once, as soon as there are files: the first run loaded, plus the active file in its own
   * slot. Seeded into state rather than computed as a read-time fallback so that **deselecting
   * sticks** — a fallback would re-select the run the moment the user cleared it, and the click
   * would look broken.
   */
  useEffect(() => {
    if (seeded.current || files.length === 0) return;
    seeded.current = true;
    lastActive.current = activeId;
    const active = activeId ? files.find((f) => f.id === activeId) : undefined;
    const firstRun = files.find((f) => stagingRole(f.kind) === "run");
    let next: RunStagingSelection = firstRun ? { ...EMPTY, runId: firstRun.id } : EMPTY;
    if (active) next = { ...next, [SLOT[stagingRole(active.kind)]]: active.id };
    setSelection(next);
  }, [files, activeId]);

  // Fold each newly active file into its slot — a load, or a `#file=` link. Only on *change*:
  // re-running this on every render would undo a deselection the moment it happened, since the
  // file stays active.
  useEffect(() => {
    if (!seeded.current || activeId === lastActive.current) return;
    lastActive.current = activeId;
    const file = activeId ? files.find((f) => f.id === activeId) : undefined;
    if (!file) return;
    setSelection((prev) => ({ ...prev, [SLOT[stagingRole(file.kind)]]: file.id }));
  }, [activeId, files]);

  const toggle = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      if (!file) return;
      const slot = SLOT[stagingRole(file.kind)];
      setSelection((prev) => ({ ...prev, [slot]: prev[slot] === id ? null : id }));
    },
    [files],
  );

  const selectedIds = useMemo(
    () => new Set([live.runId, live.protocolId, live.plateId].filter((x): x is string => !!x)),
    [live],
  );

  return { selection: live, selectedIds, toggle };
}

export type RunStaging = ReturnType<typeof useRunStaging>;
