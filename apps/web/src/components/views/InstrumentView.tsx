/**
 * The Instrument view — a live CFX96 over WebUSB, and the one place an experiment is started.
 *
 * **Not a lens on the selected file, and its tab is not in that group** (see `ViewBar`). What it
 * shows is the machine: the connection, its status, its filesystem, the traffic, and the run it is
 * driving — all of which go on existing while the selection moves around them. It renders with
 * nothing selected and with nothing loaded at all, which is where someone with a cycler and no
 * files starts.
 *
 * It does still need **an experiment** to start, since a protocol comes from a file and the
 * instrument has no library of its own (`usb.md` §5.1). That experiment is the app's ordinary
 * selection and nothing else: the selected file when it is a decoded run, otherwise none, and the
 * panel says so rather than showing a different run than the one lit in the bar. The file bar is
 * the app's one file picker and stays the only one.
 *
 * **Nothing selected is a perfectly good state here**, and the reason this tab can afford so plain
 * a rule: connecting, status, the instrument's own files, the traffic and every action but Start
 * live in the rail, which needs no file at all. Someone can plug in a cycler, open the lid and
 * read its status with an empty browser.
 *
 * Older still, and worth not re-proposing: a run assembled from a **three-slot staging selection**
 * over every loaded file, where a `.prcl.txt` or `.plt.csv` could override half of some other run,
 * a chip meant something different on this tab than on any other, and the run about to start
 * existed nowhere until it was started. An experiment is a file first now — created by "New
 * experiment" or "Clone experiment", named and filled in on Overview.
 *
 * What this view can do depends on what that file is, and there are exactly three cases:
 *
 * | The experiment | This view |
 * | ----------- | --------- |
 * | a pending experiment (no results yet) | starts it — Start is armed once it has a protocol |
 * | a run in progress | won't start it; says it is running, and offers a clone for the next one |
 * | a run that is over | won't start it; offers to clone it instead |
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
 * The experiment this view would start: the selected file, once it has turned out to be a decoded
 * run at all.
 *
 * Null when it hasn't — a standalone plate or protocol, a run behind the password prompt, or
 * nothing selected. The view still renders and the instrument is still fully usable; there is
 * simply nothing to start, and the panel says where experiments come from.
 */
export interface InstrumentExperiment {
  fileName: string;
  /** What it is called — resolved on Overview and stored in the file, never typed here. */
  name: string;
  /** True when that name was actually given rather than derived from the file name; an experiment
   * still carrying its bare-date placeholder can't be started (`lib/experiment.ts`). */
  named: boolean;
  zpcr: Zpcr;
  /** No results yet and never started — the only state Start applies to (`isPendingExperiment`). */
  pending: boolean;
  /**
   * Started and not yet finished, read from the file's own markers (`runFolder.ts`'s
   * `runProgressFromNames`). Neither startable nor over: a run in progress is why the view has to
   * say more than "pending or done", since telling someone watching their run that it "has already
   * been run" is simply false while the block is still cycling.
   */
  inProgress: boolean;
}

export function InstrumentView({
  onOpenRun,
  onOpenFinishedRun,
  experiment,
  onNewExperiment,
  instrument,
  runWatch,
  onStartExperiment,
  onStarted,
  onCloneExperiment,
}: {
  onOpenRun: (name: string, archive: ZpcrArchive) => Promise<void> | void;
  /** Jump to a finished run's curves — the "Run complete" banner's "Open run" button. Distinct
   * from `onOpenRun`: that one adds a *new* file (an offloaded archive dropped in from outside);
   * this one just switches to a file the watcher already put in the store. */
  onOpenFinishedRun: (fileName: string) => void;
  /** The selected experiment, or null when the selection isn't one; see the type. Built by `App`
   * from the active file — see `instrumentExperiment` there. */
  experiment: InstrumentExperiment | null;
  /** Make a new pending experiment and stay here — the way out of "nothing to start" when the
   * browser is holding nothing to point at. */
  onNewExperiment: () => void;
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
  onStartExperiment: (plan: RunPlan, fileName: string) => Promise<void> | void;
  /**
   * The run has been sent: leave this view for the started experiment's Overview.
   *
   * Starting is the one thing this tab is *for*, and once it is done the interesting object is the
   * file rather than the machine — the Overview is where the "still going" banner and the results
   * arriving into it are. The rail decides *when* (after the send, and not at all when the deposit
   * had a problem to report); this is only the going.
   */
  onStarted: () => void;
  /** Copy this run's protocol and plate into a fresh pending experiment — the way to run one
   * again, offered here because "this already has results" is where that need is discovered. The
   * file is named explicitly: it is this view's target, not necessarily the app's selection. */
  onCloneExperiment: (fileName: string) => void;
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
    (fileName: string) => {
      onOpenFinishedRun(fileName);
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
        onStarted={onStarted}
      />
      <div className="instrument__content">
        <InstrumentRun
          experiment={experiment}
          onNewExperiment={onNewExperiment}
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
