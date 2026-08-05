/**
 * The Instrument view — a live CFX96 over WebUSB, and the one place an experiment is started.
 *
 * Unlike every other view it is not a lens on the active file — but it is not file-independent
 * either: starting a run needs a protocol, and that comes from the **one experiment file** the app
 * is currently on. There is no selection of its own to make here any more. A run used to be
 * assembled from a three-slot staging selection over every loaded file, with a `.prcl.txt` or
 * `.plt.csv` able to override half of some other run — which meant a chip in the file bar meant
 * something different on this tab than on every other one, and the run about to start existed
 * nowhere until it was started. Now an experiment is a file first (created by "New experiment" or
 * "Clone experiment", named and filled in on Overview), and this view only starts the one in front
 * of it.
 *
 * What it can do therefore depends on what that file is, and there are exactly three cases:
 *
 * | Active file | This view |
 * | ----------- | --------- |
 * | a pending experiment (no results yet) | starts it — Start is armed once it has a protocol |
 * | a run with results (in progress, or over) | won't start it; offers to clone it instead |
 * | anything else, or nothing loaded | says so, and points at where experiments come from |
 *
 * Layout reuses the Curves view's rail + content grid so it reads as the same kind of surface:
 * the rail carries connection, identity, status and the commands that actuate the instrument
 * (including Start), and the content column stacks the experiment, the file browser and the
 * traffic console.
 */
import { useCallback, useMemo } from "react";
import { planRun, type ZpcrArchive, type RunPlan, type Zpcr } from "@zpcrweb/core";
import { InstrumentRail } from "../instrument/InstrumentRail";
import { InstrumentRun } from "../instrument/InstrumentRun";
import { InstrumentFiles } from "../instrument/InstrumentFiles";
import { InstrumentConsole } from "../instrument/InstrumentConsole";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import type { RunWatchState } from "../../state/useRunWatch";

/**
 * The experiment this view would start: the active file, once it has turned out to be one at all.
 *
 * Null when the active file is a standalone plate or protocol, an unreadable run, or there is no
 * file at all — the view still renders (it is reachable with nothing loaded, which is where someone
 * with a cycler and no files starts), it just has nothing to start.
 */
export interface InstrumentExperiment {
  fileId: string;
  /** What it is called — resolved on Overview and stored in the file, never typed here. */
  name: string;
  /** True when that name was actually given rather than derived from the file name; an experiment
   * still carrying its bare-date placeholder can't be started (`lib/experiment.ts`). */
  named: boolean;
  zpcr: Zpcr;
  /** No results yet and never started — the only state Start applies to (`isPendingExperiment`). */
  pending: boolean;
}

export function InstrumentView({
  onOpenRun,
  onOpenFinishedRun,
  experiment,
  instrument,
  runWatch,
  onStartExperiment,
  onCloneExperiment,
}: {
  onOpenRun: (name: string, archive: ZpcrArchive) => Promise<void> | void;
  /** Jump to a finished run's curves — the "Run complete" banner's "Open run" button. Distinct
   * from `onOpenRun`: that one adds a *new* file (an offloaded archive dropped in from outside);
   * this one just switches to a file the watcher already put in the store. */
  onOpenFinishedRun: (fileId: string) => void;
  /** The experiment the active file is, or null when it isn't one; see the type. */
  experiment: InstrumentExperiment | null;
  /** The connection, owned by `App` so it outlives this view — see its comment there. */
  instrument: CfxDeviceHandle;
  /** The follow-the-running-run machinery, likewise owned by `App`. */
  runWatch: RunWatchState;
  /**
   * Start the experiment in front of us: `App`'s `startExperiment`, which writes the `begun`
   * marker into this very file (restamping its date to today first) and then sends the run. It
   * creates no file — the experiment already exists, which is the whole point of the pending
   * state.
   */
  onStartExperiment: (plan: RunPlan) => Promise<void> | void;
  /** Copy this run's protocol and plate into a fresh pending experiment — the way to run one
   * again, offered here because "this already has results" is where that need is discovered. */
  onCloneExperiment: () => void;
}) {
  /**
   * The experiment reduced to exactly what would be sent — commands, files, and the checks that
   * decide whether it may be sent at all (`usb/runPlan.ts`).
   *
   * Computed here, above both the panel that displays it and the rail that sends it, so the two
   * cannot disagree: the warnings shown next to the plate are the same object the Start button
   * consults. Both halves come from the one file, so there is nothing to resolve first — the plate
   * is simply whichever one the archive carries, and its absence is a `warning` rather than a
   * missing half (`runPlan.ts`), since an experiment may deliberately be run without one.
   */
  const plan = useMemo(() => {
    if (!experiment) return null;
    const { zpcr } = experiment;
    const runDefinition = zpcr.protocolText;
    if (!runDefinition) return null;
    try {
      return planRun({
        runDefinition,
        plate: zpcr.plates()[0]?.pltd.plate ?? undefined,
        // The experiment's own name, as stored in the file. Never the protocol's: a protocol is
        // run many times, so that would give every run of it the same name.
        //
        // A *pending* experiment still on its bare-date placeholder is passed the blank that makes
        // `planRun` raise its `no-experiment-name` error, which is what stops Start. A run that has
        // already happened is passed the name it actually goes by — derived from its file name if
        // nothing stored one — because it is not being started and demanding a name for it would be
        // accusing a finished run of missing something it doesn't need.
        name: experiment.pending && !experiment.named ? "" : experiment.name,
        protocolName: zpcr.protocol()?.name || undefined,
      });
    } catch {
      // A run definition this app can't parse can't be planned; the panel already renders the
      // protocol's own decode, so there is nothing useful to add here.
      return null;
    }
  }, [experiment]);

  /** "Open run" on the "Run complete" banner: switch to that run's curves (`App`'s
   * `openFinishedRun`), and dismiss the banner — it's been acted on, and staying on this view
   * afterwards would show it beside a run that's no longer the newest thing to look at. */
  const openFinished = useCallback(
    (fileId: string) => {
      onOpenFinishedRun(fileId);
      runWatch.clearFinished();
    },
    [onOpenFinishedRun, runWatch],
  );

  return (
    <div className="curves instrument">
      <InstrumentRail
        instrument={instrument}
        experiment={experiment}
        plan={plan}
        runWatch={runWatch}
        onStart={onStartExperiment}
      />
      <div className="instrument__content">
        <InstrumentRun
          experiment={experiment}
          plan={plan}
          status={instrument.status}
          pending={instrument.runPending}
          finished={runWatch.finished}
          onOpenFinishedRun={openFinished}
          onNewRun={runWatch.clearFinished}
          onCloneExperiment={onCloneExperiment}
        />
        <InstrumentFiles instrument={instrument} onOpenRun={onOpenRun} />
        <InstrumentConsole instrument={instrument} />
      </div>
    </div>
  );
}
