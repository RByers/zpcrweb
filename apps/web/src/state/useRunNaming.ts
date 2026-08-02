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
 *
 * ## Why a phase rather than "is a run in progress"
 *
 * "The run ended" cannot be read off a single idle status, because a run asked for here does not
 * appear in `STATUS?` immediately: the start sequence resolves once the instrument has taken the
 * commands, and the block then takes seconds to report anything but `IDLE` (`usb.md` §7.3
 * measured ~6 s; core's `cancelRun` allows 20 s for it). Clearing on the first not-running status
 * therefore emptied the field moments *after* the click — the field then re-locked as `running`
 * showed up, leaving a run on the block with a blank, complaining name box.
 *
 * So this tracks where in a run's life the app is, and only a **running → stopped** transition
 * clears anything:
 *
 * | phase      | means                                            | field                  |
 * | ---------- | ------------------------------------------------ | ---------------------- |
 * | `idle`     | nothing started here is on the block              | editable               |
 * | `starting` | started here, not yet seen in `STATUS?`           | read-only, kept        |
 * | `running`  | the instrument is reporting this run              | read-only, kept        |
 *
 * A start that never takes leaves `starting` after {@link START_WINDOW_MS} and the name is kept,
 * not cleared: a run that never ran never stopped, and whoever retries wants what they typed. An
 * unknown status (no instrument, or one that went away mid-run) decides nothing at all, so
 * unplugging during a run doesn't rename what the watcher is still assembling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * How long a run asked for here may take to show up in `STATUS?` before the app stops waiting for
 * it. Matches core's `CfxCancelOptions.startWindowMs` default, which covers the same window from
 * the other side (`usb.md` §7.3).
 */
const START_WINDOW_MS = 20_000;

/** Where in a run's life the app is — see the phase table above. */
export type RunNamingPhase = "idle" | "starting" | "running";

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
  /** True while the run started here is starting or on the block: the name is settled, so the
   * field is read-only until it finishes. */
  locked: boolean;
  /** Where in a run's life this app is — what {@link locked} is derived from, and what the
   * panel's badge says. */
  phase: RunNamingPhase;
  /** The run being followed, pinned by {@link begin}; null until one is started here. */
  active: ActiveRunNames | null;
  /** Take the run about to be started as the current one, under the file name chosen for it. */
  begin: (names: ActiveRunNames) => void;
}

export function useRunNaming(
  /** What the instrument last said about the block: `true` running, `false` stopped, `null` when
   * nothing is known — no instrument, or a status that hasn't arrived. Only a `true` → `false`
   * transition, for a run started here, clears the typed name. */
  running: boolean | null,
): RunNaming {
  const [experimentName, setExperimentName] = useState("");
  const [active, setActive] = useState<ActiveRunNames | null>(null);
  const [phase, setPhase] = useState<RunNamingPhase>("idle");

  const begin = useCallback((names: ActiveRunNames) => {
    setActive(names);
    setPhase("starting");
  }, []);

  // Read rather than depended upon: the transition that matters is the instrument's, and a status
  // that only repeats what the phase already says must not re-run anything.
  const phaseRef = useRef<RunNamingPhase>("idle");
  phaseRef.current = phase;
  useEffect(() => {
    if (running === null) return;
    // `starting` is set only by `begin`, which is what keeps this to runs this app started — one
    // found already going belongs to whoever started it, and never gets past `idle`.
    if (running) {
      if (phaseRef.current === "starting") setPhase("running");
      return;
    }
    if (phaseRef.current !== "running") return;
    setPhase("idle");
    // Empty the field so the next run cannot silently inherit — and reuse — this one's name. The
    // run still being assembled keeps the name it was seeded with, from the pinned `active`.
    setExperimentName("");
  }, [running]);

  // Stop waiting for a start that never appeared, which releases the field for another attempt.
  // The name stays: nothing ran, so nothing ended.
  useEffect(() => {
    if (phase !== "starting") return;
    const timer = setTimeout(() => {
      if (phaseRef.current === "starting") setPhase("idle");
    }, START_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  return useMemo(
    () => ({
      experimentName,
      setExperimentName,
      locked: !!active && phase !== "idle",
      phase,
      active,
      begin,
    }),
    [experimentName, active, phase, begin],
  );
}
