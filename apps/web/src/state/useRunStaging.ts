/**
 * Which loaded files make up the run the Instrument view would start.
 *
 * A run needs two things — a thermal protocol and a plate map — and the app's loaded files supply
 * them in two shapes: a whole run (`.zpcr`/`.pcrd`/Biomeme) carries both, while a `.prcl.txt` or a
 * `.pltd`/`.plt.csv` carries exactly one. So the selection is **three slots** — a run, a protocol
 * override, a plate override — which is what lets a protocol from one place be paired with a plate
 * from another.
 *
 * The three are not peers, and that asymmetry is the model:
 *
 * - **The run slot is the app's primary selection** — `activeId`, the file every other view is
 *   looking at, highlighted in the usual cyan. It is not a toggle: the app always has one file
 *   selected, and when that file is a run, that is the run this view would start. Selecting a
 *   different run therefore *switches* the primary selection rather than adding to a set, and
 *   there is no "no run at all" state to get stuck in. (A plate file can be primary too — a
 *   standalone `.pltd` has views of its own — so the last run to hold the slot is remembered
 *   rather than dropped while you look at one.)
 * - **The overrides are auxiliary** — magenta, toggled on and off, each holding at most one file,
 *   and each superseding that half of the run. Tapping a selected one releases its slot.
 *
 * An earlier version made all three symmetric toggles, so the run could be deselected too. That
 * read as three equal switches when only two of them are, and it made an empty selection
 * reachable — from which, in the Instrument view, nothing named the file the rest of the app was
 * still pointed at.
 *
 * A run whose halves are *both* overridden is still the one selected, and that matters rather
 * than being a leftover: it carries the `.Dcal` calibration set, and that is what gives a
 * `.plt.csv` its dye→channel mapping (`lib/protocolSource.ts`). A plate CSV records dye names
 * only, so with no run to say which instrument they were read on, its channels are simply
 * unknown. The run slot therefore also means "and this is the instrument" — and the panel says
 * so, rather than leaving a chip lit for no visible reason.
 *
 * **Newly loaded override files join the selection.** Loading a `.prcl.txt` or a plate file folds
 * it into its slot, which is what makes the headline flow work — load a `.prcl.txt`, read it on
 * its Overview, then switch to Instrument and find it already staged against the run you had.
 *
 * **The run can still be released, deliberately, via `deselectRun`.** Clicking the chip that is
 * *already* the primary run (`App`'s `selectFile`) doesn't leave the bar with nothing named — it
 * promotes whichever override is staged (protocol first, else plate) to primary instead, so the
 * bar always has something to point at. With neither override staged there is nothing to promote
 * to, so `deselectRun` is a no-op rather than reaching the empty selection the module comment
 * above warns against.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fileCategory, type FileCategory, type FileKind } from "@zpcrweb/core";
import type { LoadedFile } from "./useZpcrStore";

/** Which half of a run a file kind can supply — which is exactly what the file *is*
 * (`core/fileKind.ts`), since a plate file supplies the plate and a protocol the protocol. */
export type StagingRole = FileCategory;

export function stagingRole(kind: FileKind): StagingRole {
  return fileCategory(kind);
}

export interface RunStagingSelection {
  /** A whole run: whichever halves aren't overridden, and always the calibration set. */
  runId: string | null;
  /** A `.prcl.txt` superseding the run's protocol. */
  protocolId: string | null;
  /** A `.pltd`/`.plt.csv` superseding the run's plate. */
  plateId: string | null;
}

interface Overrides {
  protocolId: string | null;
  plateId: string | null;
}

const NO_OVERRIDES: Overrides = { protocolId: null, plateId: null };

/** The override slot each auxiliary role occupies. `run` is absent on purpose — it is the primary
 * selection, not an override, and nothing here may write it. */
const SLOT: Partial<Record<StagingRole, keyof Overrides>> = {
  protocol: "protocolId",
  plate: "plateId",
};

export function useRunStaging(files: LoadedFile[], activeId: string | null) {
  const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);

  // The run the primary selection implies. Read from `activeId` rather than stored, so the run
  // this view would start and the file the rest of the app is showing can never disagree.
  const lastRunId = useRef<string | null>(null);
  // Set by `deselectRun` below, and only by it: a deliberate release of the run slot, which must
  // survive the primary selection moving to some non-run file (that is the whole point of it) —
  // so it can't be read off `activeId` the way everything else here is. Cleared the moment a run
  // becomes primary again, by any route, which is what lets a later run selection un-stick it.
  const [released, setReleased] = useState(false);
  const runId = useMemo(() => {
    const active = files.find((f) => f.id === activeId);
    if (active && stagingRole(active.kind) === "run") return active.id;
    if (released) return null;
    // Looking at a standalone plate doesn't retract the run — fall back to the last one that was
    // primary, and failing that to the first run loaded, so the view opens on something.
    if (files.some((f) => f.id === lastRunId.current)) return lastRunId.current;
    return files.find((f) => stagingRole(f.kind) === "run")?.id ?? null;
  }, [files, activeId, released]);
  useEffect(() => {
    if (runId) {
      lastRunId.current = runId;
      setReleased(false);
    }
  }, [runId]);

  // Overrides pointing at a file that's gone (the chip's ✕, or a same-name replacement) would
  // stage a run out of nothing. Resolved on read rather than by an effect, so there is no window
  // in which the two disagree.
  const selection = useMemo<RunStagingSelection>(() => {
    const ids = new Set(files.map((f) => f.id));
    const keep = (id: string | null) => (id && ids.has(id) ? id : null);
    return {
      runId: keep(runId),
      protocolId: keep(overrides.protocolId),
      plateId: keep(overrides.plateId),
    };
  }, [files, runId, overrides]);

  // Fold each newly *loaded* override file into its slot. Keyed off the file list rather than off
  // the active file: every entry point (a drop, the header button, `#load=`) adds files the same
  // way, so all of them stage alike, and staging no longer rides on which file the load happened
  // to leave active. Only files that weren't there before, so a deselection isn't undone by the
  // next unrelated render.
  const knownIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (files.length === 0) return;
    const ids = new Set(files.map((f) => f.id));
    const first = knownIds.current === null;
    const fresh = first ? [] : files.filter((f) => !knownIds.current!.has(f.id));
    knownIds.current = ids;
    // The first list we ever see is IndexedDB hydration, not a load: nothing there was "just
    // added", so the only thing to stage is the file the session was left on.
    const stage = first ? files.filter((f) => f.id === activeId) : fresh;
    if (stage.length === 0) return;
    setOverrides((prev) => {
      let next = prev;
      for (const f of stage) {
        const slot = SLOT[stagingRole(f.kind)];
        if (slot) next = { ...next, [slot]: f.id };
      }
      return next;
    });
  }, [files, activeId]);

  /**
   * Toggle an override on or off. A run is not an override — selecting one is a change of
   * primary selection, which `App` routes to the store instead — so this ignores it.
   *
   * With the run slot released (`deselectRun`), one of the two overrides is standing in as the
   * primary selection (`App`'s `stagingActiveId`) — so turning off the *last* one left would reach
   * the empty selection this hook otherwise refuses. Guarded here rather than left to `App`,
   * since this is the same invariant `deselectRun` enforces and belongs with it.
   */
  const toggle = useCallback(
    (id: string) => {
      const file = files.find((f) => f.id === id);
      const slot = file && SLOT[stagingRole(file.kind)];
      if (!slot) return;
      setOverrides((prev) => {
        const turningOff = prev[slot] === id;
        const next = { ...prev, [slot]: turningOff ? null : id };
        if (!runId && turningOff && !next.protocolId && !next.plateId) return prev;
        return next;
      });
    },
    [files, runId],
  );

  /** The auxiliary files currently staged — what the file bar draws in magenta. The run isn't
   * here: it is the primary selection, and already carries the app's ordinary cyan highlight. */
  const stagedIds = useMemo(
    () =>
      new Set([selection.protocolId, selection.plateId].filter((x): x is string => !!x)),
    [selection],
  );

  /**
   * Release the run slot, for a click on the chip that already holds it (`App`'s `selectFile`).
   *
   * Returns the file that should become the new primary selection — the staged protocol, else the
   * staged plate — or `null` when there is neither, in which case nothing changes: the module
   * comment's rejected "all three deselectable" design is exactly the empty-selection state this
   * refusal exists to avoid. The caller is what actually moves `activeId` (`useZpcrStore.setActive`
   * lives outside this hook); this only clears the run and hands back where to point next.
   */
  const deselectRun = useCallback(() => {
    if (!selection.runId) return null;
    const fallback = selection.protocolId ?? selection.plateId;
    if (!fallback) return null;
    setReleased(true);
    return fallback;
  }, [selection]);

  return { selection, stagedIds, toggle, deselectRun };
}

export type RunStaging = ReturnType<typeof useRunStaging>;
