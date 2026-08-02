/**
 * What the run about to be started is called — the one name the Instrument view collects before
 * anything is sent, and what the file it produces is named after.
 *
 * The **experiment name** is the run's identity: it goes out as `RemoteRun`'s name operand
 * (`usb.md` §7.3) and as the deposited `zpcrweb.json` (`usb/runPlan.ts`), which is what makes the
 * pulled archive state its own name. Nothing supplies it — no Bio-Rad format has a field for it,
 * and the instrument's echo comes back uppercased and cut to eight characters — so it is typed,
 * and a run cannot start without one.
 *
 * The **file name** is not typed. It used to be its own field here, on the theory that the
 * instrument's composed name (`<date>_<time>_<serial>_<NAME>`) isn't addressable over USB so the
 * user should say what the local `.zpcr` is called — but the run's file is created at the click
 * from `<YYYYMMDD>-<experiment name>` (core's `runFileBaseName`) and every later snapshot has to
 * keep that exact name to supersede it, so the field only ever offered a second way to say what
 * the experiment name had already said. It is derived at the click instead, made unique against
 * the files already loaded (core's `nextFreeRunFileBase`), and **pinned** for the
 * run's duration as {@link RunNaming.active}.
 *
 * Pinning is what lets the typed field be cleared the moment the run ends without renaming the
 * run still being assembled: the watcher names its snapshots from `active`, which changes only at
 * the next start, while the field itself empties so the next run cannot silently inherit — and
 * reuse — the last one's name. While the run this app started is on the block the field is
 * **read-only** (`locked`): the name has already been sent, deposited, and used to name a file, so
 * editing it there would only make the app disagree with the instrument.
 *
 * Held above the view (in `App`) rather than inside it, because the run watcher needs the pinned
 * names too and outlives every view switch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** The names of the run currently being followed, as fixed at the click on Start run. */
export interface ActiveRunNames {
  /** What that run is called — matched against the folder's deposited name (`runFolder.ts`). */
  experimentName: string;
  /** The `.zpcr` base name, without extension. Local to this app; never sent. */
  fileName: string;
}

export interface RunNaming {
  /** What the run is called, as typed. Empty until someone types one. */
  experimentName: string;
  setExperimentName: (name: string) => void;
  /** True while the run started here is on the block: the name is settled, so the field is
   * read-only until it finishes. */
  locked: boolean;
  /** The run being followed, pinned by {@link begin}; null until one is started here. */
  active: ActiveRunNames | null;
  /** Take the run about to be started as the current one, under the file name chosen for it. */
  begin: (names: ActiveRunNames) => void;
}

export function useRunNaming(
  /** True while a run is pending or running on the instrument (`App`). Its falling edge — for a
   * run this app started — is what clears the typed name. */
  runInProgress: boolean,
): RunNaming {
  const [experimentName, setExperimentName] = useState("");
  const [active, setActive] = useState<ActiveRunNames | null>(null);

  const begin = useCallback((names: ActiveRunNames) => setActive(names), []);

  // Only a run this app started clears the field, and only once it has actually been seen on the
  // block: `runInProgress` is still false for the beat between the click and `startRun`'s pending
  // flag, and a run found already going belongs to whoever started it.
  const activeRef = useRef<ActiveRunNames | null>(null);
  activeRef.current = active;
  const sawRunning = useRef(false);
  useEffect(() => {
    if (runInProgress) {
      if (activeRef.current) sawRunning.current = true;
      return;
    }
    if (!sawRunning.current) return;
    sawRunning.current = false;
    setExperimentName("");
  }, [runInProgress]);

  return useMemo(
    () => ({
      experimentName,
      setExperimentName,
      locked: !!active && runInProgress,
      active,
      begin,
    }),
    [experimentName, active, runInProgress, begin],
  );
}
