/**
 * The Instrument view — a live CFX96 over WebUSB, and the one place an experiment is started.
 *
 * **Not a lens on the selected file, and its tab is not in that group** (see `ViewBar`). What it
 * shows is the machine: the connection, its status, its filesystem, the traffic, and the run it is
 * driving — all of which go on existing while the selection moves around them. It renders with
 * nothing selected and with nothing loaded at all, which is where someone with a cycler and no
 * files starts.
 *
 * **The rail is the instrument; the panel is the selected file.** The rail (`InstrumentRail`)
 * carries the connection, every button that actuates the machine, what it is holding for this
 * browser, its identity, status and last run — and nothing that depends on the selection, so
 * clicking a chip changes nothing there. The main panel (`InstrumentRun`) is the experiment the
 * selection is, with the Start button that starts it.
 *
 * It does still need **an experiment** to start, since a protocol comes from a file and the
 * instrument has no library of its own (`usb.md` §5.1). That experiment is the app's ordinary
 * selection: the selected file when it is a decoded run, otherwise none, and the panel says so
 * rather than showing a different run than the one lit in the bar. **While a run is on the block,
 * the selection is that run** — `App` keeps the selection on the follower's `runningFile` while
 * this view is showing and locks the file bar's other chips, so this view always shows what the
 * instrument is doing. Other files are still a click away on any other tab.
 *
 * **Nothing selected is a perfectly good state here**: connecting, status and every instrument
 * button live in the rail, which needs no file at all. Someone can plug in a cycler, open the lid
 * and read its status with an empty browser.
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
 * | a standalone `.prcl.txt` with no `PLATEREAD` | starts it directly — no experiment file at all |
 * | a run in progress | won't start it; says it is running, and offers a clone for the next one |
 * | a run that is over | won't start it; offers to clone it instead |
 * | anything else, or nothing loaded | says so, and points at where experiments come from |
 *
 * The second row is the exception the rest of the rule is worth stating around. A thermal-only
 * protocol — an incubation, a reverse transcription — makes the instrument no run folder and so
 * leaves no `.zpcr` (`RunPlan.producesRunFile`), which means wrapping it in an experiment file
 * would be inventing a container for results that are never coming. So such a protocol is started
 * as itself, and what comes back is the instrument's own run report (`useRunWatch`).
 *
 * Layout reuses the Curves view's rail + content grid so it reads as the same kind of surface:
 * the rail carries the instrument, and the content column stacks the experiment, then — for the
 * running file, or for any file while nothing is running — the instrument's file browser and the
 * live traffic console. A file that is *not* the run on the block gets neither, since both would be
 * about some other run; in the console's place it gets its own saved traffic log, if it has one.
 */
import { useCallback, useMemo } from "react";
import {
  formatUsbTrafficBytes,
  isUsbTrafficName,
  planRun,
  type ZpcrArchive,
  type RunPlan,
  type Zpcr,
} from "@zpcrweb/core";
import { InstrumentRail } from "../instrument/InstrumentRail";
import { InstrumentRun } from "../instrument/InstrumentRun";
import { InstrumentFiles } from "../instrument/InstrumentFiles";
import { InstrumentConsole, type SavedTrafficLog } from "../instrument/InstrumentConsole";
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
  /**
   * The decoded run, or **null for a standalone `.prcl.txt`** — a thermal-only protocol, which is
   * startable on its own (see `App`'s `instrumentExperiment`). Everything this view needs of a
   * protocol-only experiment is {@link protocolText}; there is no archive behind it, and there
   * will be no run file after it either.
   */
  zpcr: Zpcr | null;
  /** The ASCII run definition that would be sent — the run's own, or the `.prcl.txt`'s text. */
  protocolText: string | null;
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
  onOpenReport,
  onOpenFinishedRun,
  experiment,
  onNewExperiment,
  instrument,
  runWatch,
  runningFile,
  onStartExperiment,
  onCloneExperiment,
}: {
  onOpenRun: (name: string, archive: ZpcrArchive) => Promise<void> | void;
  /** Put the instrument's own run report in the file bar — the rail's Last run section's "Open report".
   * The same callback the run watcher files a thermal-only run's report through, so a report
   * collected by hand and one collected automatically become the same kind of file. */
  onOpenReport: (name: string, bytes: Uint8Array) => Promise<string | null>;
  /** Jump to a finished run's curves — the "Run complete" banner's "Open run" button. Distinct
   * from `onOpenRun`: that one adds a *new* file (an offloaded archive dropped in from outside);
   * this one just switches to a file the watcher already put in the store. */
  onOpenFinishedRun: (fileName: string) => void;
  /** The selected experiment, or null when the selection isn't one; see the type. Built by `App`
   * from the running file when a run is on the block, else from the active file — the two agree
   * whenever this view is showing (see `instrumentExperiment` there). */
  experiment: InstrumentExperiment | null;
  /** Make a new pending experiment and stay here — the way out of "nothing to start" when the
   * browser is holding nothing to point at. */
  onNewExperiment: () => void;
  /** The connection, owned by `App` so it outlives this view — see its comment there. */
  instrument: CfxDeviceHandle;
  /** The follow-the-running-run machinery, likewise owned by `App`. */
  runWatch: RunWatchState;
  /** The open file whose run is on the block right now — the follower's `runningFile`, resolved
   * by `App` to null when that file has since been closed. */
  runningFile: string | null;
  /**
   * Start the experiment in front of us: `App`'s `startExperiment`, which writes the `begun`
   * marker into this very file (restamping its date to today first) and then sends the run. It
   * creates no file — the experiment already exists, which is the whole point of the pending
   * state.
   */
  onStartExperiment: (plan: RunPlan, fileName: string) => Promise<void> | void;
  /** Copy this run's protocol and plate into a fresh pending experiment — the way to run one
   * again, offered here because "this already has results" is where that need is discovered. The
   * file is named explicitly: it is this view's target, not necessarily the app's selection. */
  onCloneExperiment: (fileName: string) => void;
}) {
  /**
   * The experiment reduced to exactly what would be sent — commands, files, and the checks that
   * decide whether it may be sent at all (`usb/runPlan.ts`).
   *
   * Computed once, here, so the panel's two uses of it cannot disagree: the warnings shown next to
   * the plate are the same object the Start button consults. Both halves come from the one file, so there is nothing to resolve first — the plate
   * is simply whichever one the archive carries, and its absence is a `warning` rather than a
   * missing half (`runPlan.ts`), since an experiment may deliberately be run without one.
   */
  const plan = useMemo(() => {
    if (!experiment) return null;
    const { zpcr } = experiment;
    const runDefinition = experiment.protocolText;
    if (!runDefinition) return null;
    try {
      return planRun({
        runDefinition,
        plate: zpcr?.plates()[0]?.pltd.plate ?? undefined,
        // The experiment's own name, as stored in the file. Never the protocol's: a protocol is
        // run many times, so that would give every run of it the same name.
        //
        // A *pending* experiment still on its bare-date placeholder is passed the blank that makes
        // `planRun` raise its `no-experiment-name` error, which is what stops Start. A run that has
        // already happened is passed the name it actually goes by — derived from its file name if
        // nothing stored one — because it is not being started and demanding a name for it would be
        // accusing a finished run of missing something it doesn't need.
        name: experiment.pending && !experiment.named ? "" : experiment.name,
        // A protocol-only experiment has no archive to hold a protocol name, so its file name is
        // the protocol's name — which is also the run's, since the two are the same object there.
        protocolName: zpcr?.protocol()?.name || experiment.name || undefined,
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

  const isRunningFile = !!experiment && experiment.fileName === runningFile;
  // The instrument's storage and its live traffic are about the run on the block, so they show for
  // that file — or for any file while nothing is running, when there is no other run for them to
  // be about.
  const showLive =
    instrument.connection === "connected" && (runningFile === null || isRunningFile);

  /**
   * The selected run's own saved USB traffic log, shown in the console's slot when the live one
   * isn't — live traffic there would belong to some other run. Either name a log is stored under
   * (`usb-traffic.bin`, or an older file's plain-text `usb-traffic.log`): shown in the text form
   * the Raw files view renders it in, downloaded as the entry itself.
   */
  const savedLog = useMemo((): SavedTrafficLog | null => {
    if (showLive || !experiment?.zpcr) return null;
    const { zpcr, name } = experiment;
    const entry = zpcr.archive.entries.find(isUsbTrafficName);
    if (!entry) return null;
    return {
      name,
      entry,
      bytes: () => zpcr.archive.bytes(entry),
      text: () => {
        try {
          return /\.log$/i.test(entry)
            ? zpcr.archive.text(entry)
            : formatUsbTrafficBytes(zpcr.archive.bytes(entry));
        } catch (e) {
          return `This log could not be read: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  }, [experiment, showLive]);

  return (
    <div className="curves instrument">
      <InstrumentRail instrument={instrument} runWatch={runWatch} onOpenReport={onOpenReport} />
      <div className="instrument__content">
        <InstrumentRun
          experiment={experiment}
          onNewExperiment={onNewExperiment}
          plan={plan}
          instrument={instrument}
          runWatch={runWatch}
          isRunningFile={isRunningFile}
          onStart={onStartExperiment}
          onOpenFinishedRun={openFinished}
          onNewRun={runWatch.clearFinished}
          onCloneExperiment={onCloneExperiment}
        />
        {showLive && <InstrumentFiles instrument={instrument} onOpenRun={onOpenRun} />}
        {showLive ? (
          <InstrumentConsole instrument={instrument} />
        ) : (
          savedLog && <InstrumentConsole instrument={instrument} saved={savedLog} />
        )}
      </div>
    </div>
  );
}
