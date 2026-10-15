/**
 * The experiment that would be started: its thermal protocol and its plate map, side by side,
 * under the name of the file they come from — and the Start button that starts it.
 *
 * **It is named here, not chosen here.** Which experiment this view is about is the file bar's
 * one selection like everywhere else in the app (see {@link InstrumentView}); a picker of its own
 * would be a second control saying the same thing, free to disagree with the chips. When the
 * selection is not a run, this panel shows nothing rather than some other run — the rail carries
 * on regardless, since it is about the instrument and needs no file.
 *
 * Both halves come from that one file — this panel renders a file it does not own. It used to
 * render a three-slot staging selection instead, where each half could be overridden by some
 * other loaded file; there are no overrides any more, so a half is either in the experiment or it
 * isn't, and there is no source to name beyond the file itself.
 *
 * What is shown for the protocol is the **ASCII run definition**, not a decoded step table,
 * because that text is the artifact that would actually be sent (`prcl.md` §3). Reviewing anything
 * other than the bytes that would leave the machine would be reviewing the wrong object. It is
 * listed *without* the per-directive gloss (`annotated={false}`): the protocol shares this panel's
 * width with a plate map, and what the language means is a question the Protocol tab answers —
 * here the question is what would be sent.
 *
 * The experiment's **name is not collected here** any more. It is a property of the file, typed
 * once on Overview when the experiment is created (see `OverviewView`'s experiment header) and
 * stored in the archive — so by the time anyone is on this tab it is already settled, and shown
 * read-only.
 *
 * **Start is here**, in the panel's header, beside the file it starts. It used to lead the rail's
 * instrument buttons, on the argument that it actuates the machine — true, but it is also the one
 * control whose meaning depends on the selected file, and putting it in the rail made the rail
 * change with every chip clicked. The rail is now only the instrument; this panel is the selected
 * file and what can be done with it.
 *
 * **"Running" means the run on the block is this file**, and nothing weaker: the badge, the
 * executing-step highlight and the follower's state are shown only when the file in front of us is
 * the follower's `runningFile`. A finished or pending file looked at while some other run cycles
 * shows no badge — that the instrument is busy is the rail's to say.
 */
import { useState } from "react";
import type { RunPlan } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { PlateViewer } from "../plate/PlateViewer";
import { duration } from "./InstrumentRail";
import { Stat, useBusyBriefly } from "./instrumentParts";
import type { InstrumentExperiment } from "../views/InstrumentView";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import type { RunWatchState } from "../../state/useRunWatch";

/**
 * A run this session watched finish, shown until "Open run" or "New run" dismisses it.
 *
 * Sits above the experiment rather than replacing it: the run that just finished and the
 * experiment that could be started next are two different things, and nothing waits on this banner
 * being dismissed.
 */
function RunComplete({
  finished,
  onOpen,
  onNew,
}: {
  finished: { name: string; totalS: number; fileName: string };
  onOpen: () => void;
  onNew: () => void;
}) {
  return (
    <section className="instrument__panel instrument__complete">
      <div className="instrument__panelhead">
        <h2 className="instrument__paneltitle">
          Run complete
          <span className="instrument__runbadge instrument__runbadge--done">{duration(finished.totalS)}</span>
        </h2>
        <span className="devrun__hint mono">{finished.name}</span>
      </div>
      <div className="instrument__completeactions">
        <button className="btn btn--primary" onClick={onOpen}>
          Open run
        </button>
        <button className="btn" onClick={onNew}>
          Dismiss
        </button>
      </div>
    </section>
  );
}

/** A half's heading. Just what it is: with no overrides left there is no second source to name,
 * and the file the two halves come from is the one the whole app is pointed at. */
function PartHead({ title, note }: { title: string; note?: string | null }) {
  return (
    <div className="devrun__parthead">
      <span className="devrun__parttitle">{title}</span>
      {note && (
        <span className="devrun__source mono" title={note}>
          {note}
        </span>
      )}
    </div>
  );
}

/**
 * What the plate and the protocol say about each other (`usb/runPlan.ts`).
 *
 * Sits between the two halves it is about, not beside the button: the fix for "channel 3 is never
 * read" is to change one of these two halves, and the message is only actionable next to them. An
 * `error` blocks the start; a `warning` — which is what a missing plate is — is worth reading and
 * doesn't.
 */
function RunChecks({ plan }: { plan: RunPlan }) {
  if (plan.checks.length === 0) return null;
  return (
    <ul className="devrun__checks">
      {plan.checks.map((check, i) => (
        <li key={i} className={`devrun__check devrun__check--${check.severity}`}>
          <span className="devrun__checkicon" aria-hidden="true">
            {check.severity === "error" ? "✕" : "!"}
          </span>
          <span>{check.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Start, and why not yet — this panel's primary action.
 *
 * Disabled until the experiment is startable at all, the instrument is connected and idle, and
 * every check passes; while disabled it names the **first** missing piece rather than a generic
 * refusal, so the tooltip and the footnote are always the next thing to do.
 */
function useStart({
  experiment,
  plan,
  instrument,
  onStart,
}: {
  experiment: InstrumentExperiment | null;
  plan: RunPlan | null;
  instrument: CfxDeviceHandle;
  onStart: (plan: RunPlan, fileName: string) => Promise<void> | void;
}) {
  const { connection, status, busy, runPending } = instrument;
  const connected = connection === "connected";
  // What the last start did — kept so the deposit phase can report itself. A run whose files
  // didn't copy is still a run (`usb.md` §7.4), so this is a note, never a failure.
  const [startNote, setStartNote] = useState<string[] | null>(null);
  // What a run still needs, in the order it reads: the button says the *first* missing thing
  // rather than a generic "can't start", so the fix is always the next click.
  const blockers = plan?.checks.filter((c) => c.severity === "error") ?? [];
  /**
   * What is missing before the plan is even consulted — an experiment to start, in a state where
   * starting it means anything, and something to send it to. Each names where it *is* fixed.
   *
   * A run that already has results is the one case that isn't a missing piece but a wrong object:
   * re-running it would either overwrite what it holds or contradict it, so the fix is a new
   * experiment, and this panel offers the clone that makes one. A run still going gets its own line
   * ahead of that one — it is equally unstartable, but "already been run" is untrue while the block
   * is still cycling, and the honest answer is also the more useful one. (Start renders only for a
   * pending experiment, so the first three are belt and braces rather than text anyone sees.)
   */
  const unstartable = !experiment
    ? "Select or create an experiment first."
    : experiment.inProgress
      ? "This experiment is running right now — its results are still arriving."
      : !experiment.pending
        ? "This experiment has already been run — clone it to run the same protocol again."
        : !experiment.named
          ? "Name this experiment on its Overview tab first."
          : !experiment.protocolText
            ? "This experiment has no protocol yet — write one on the Protocol tab."
            : !connected
              ? "Connect to the instrument first."
              : null;
  const missing =
    unstartable ??
    // A protocol that is present but unparseable plans to nothing (`InstrumentView`), which is
    // neither a missing piece nor a failed check — so it needs saying here, or the footnote below
    // would have no plan to report on.
    (!plan
      ? "This experiment's protocol can't be read, so there is nothing to send."
      : blockers.length > 0
        ? blockers[0]!.message
        : runPending
          ? "The run has been started; waiting for the instrument to report it."
          : status?.running
            ? "The instrument is already running something."
            : null);
  const canStart =
    !unstartable && !!plan && plan.startable && connected && !busy && !runPending && !status?.running;
  // Start queues behind the one USB command channel like Stop and Pause do, so its dimmed look
  // waits a beat too (`useBusyBriefly`). A pending run is the exception — that dims immediately,
  // because there the change of state *is* the feedback for the click, and it will not be over in
  // a beat.
  const busyBriefly = useBusyBriefly(busy);
  const looksArmed =
    !unstartable && !!plan && plan.startable && connected && !status?.running && !runPending && busyBriefly;

  const start = async () => {
    if (!plan || !canStart || !experiment) return;
    // Marking the file begun and sending the run are one action, in that order — the same order the
    // seeding this replaced used, and for the same reason: the run is about to exist whether or not
    // every upload lands, so the file has to say so first (`App`'s `startExperiment`). That call
    // also adopts the file as the follower's `runningFile`, synchronously, before `startRun` sets
    // `runPending` — so the click's "pending" badge already has its running file to belong to.
    await onStart(plan, experiment.fileName);
    const result = await instrument.startRun(plan);
    setStartNote(result ? result.uploadErrors : null);
    // Stay on this tab. The run is under way and this view is where it is watched from, and
    // anything the deposit had to say (`startNote`) is here.
  };

  return { missing, canStart, looksArmed, startNote, start };
}

export function InstrumentRun({
  experiment,
  onNewExperiment,
  plan,
  instrument,
  runWatch,
  isRunningFile,
  onStart,
  onOpenFinishedRun,
  onNewRun,
  onCloneExperiment,
}: {
  /** The experiment this view is pointed at, or null when there is nothing to point at
   * ({@link InstrumentExperiment}). */
  experiment: InstrumentExperiment | null;
  /** Make a new pending experiment, for when there is nothing worth pointing at. */
  onNewExperiment: () => void;
  /** The experiment as it would be sent, or null when it has no protocol yet. */
  plan: RunPlan | null;
  /** The connection (`App`'s) — what Start sends through, and the live status the executing step
   * and the run's state are read from. */
  instrument: CfxDeviceHandle;
  /** The run follower (`App`'s): its `note`, and the finished-run banner. */
  runWatch: RunWatchState;
  /** True when {@link experiment} is the run on the block right now — the follower's
   * `runningFile` (`InstrumentView`). Everything here that says "this file is running" keys on it. */
  isRunningFile: boolean;
  /**
   * Start the experiment: writes the `begun` marker into its own file and then sends the run
   * (`App`'s `startExperiment`). It creates no file — the experiment already exists. The file is
   * named explicitly rather than taken from the app's selection.
   */
  onStart: (plan: RunPlan, fileName: string) => Promise<void> | void;
  /** "Open run": jump to that run's curves. */
  onOpenFinishedRun: (fileName: string) => void;
  /** Dismiss the "Run complete" banner. */
  onNewRun: () => void;
  /** Clone this run into a fresh pending experiment — offered when it already has results. */
  onCloneExperiment: (fileName: string) => void;
}) {
  const { status, runPending, runProgress } = instrument;
  const finished = runWatch.finished;
  const { missing, canStart, looksArmed, startNote, start } = useStart({
    experiment,
    plan,
    instrument,
    onStart,
  });
  const zpcr = experiment?.zpcr ?? null;
  const protocolText = experiment?.protocolText || null;
  const plate = zpcr?.plates()[0]?.pltd.plate ?? null;
  // A run that will leave nothing behind is worth saying *before* it is started rather than after
  // — someone who ran an incubation and then went looking for its file is the person this whole
  // path exists for. `planRun` decides it, from the protocol (`RunPlan.producesRunFile`).
  const thermalOnly = !!plan && !plan.producesRunFile;
  // A run with results is not startable, and this is where that is discovered — so the panel says
  // why and offers the fix. A run still going is in that same not-startable state but is not
  // *over*, so it says something else: its results are arriving, and a clone is for the *next* run
  // rather than a repeat of one that finished.
  const hasResults = !!experiment && !experiment.pending;
  const running = !!experiment?.inProgress;
  // Only the run on the block gets the badge and the executing-step highlight. `runPending` is the
  // click on Start, which `adopt` has already tied to this file by the time it is set — so it too
  // shows only here, never on some other file selected afterwards.
  const showPending = runPending && isRunningFile;
  const showRunning = isRunningFile && !!status?.running;
  // What the follower makes of the run on the block. `STATUS?`'s `running` flag is live and free
  // (the rail's Status is polling it), so it settles "in progress" the instant a run starts,
  // without waiting on the run folder to be listed — that only happens on `usb.md`'s own §7.5/§7.6
  // edges. Ahead of even that is a locally pending start, which nothing on the wire knows yet.
  const runState = runPending
    ? "run pending"
    : status?.running || runProgress?.inProgress
      ? "in progress"
      : runProgress?.ended
        ? "finished"
        : "no run";
  const showNotes = !!experiment?.pending || (!!startNote && startNote.length > 0) || isRunningFile;

  return (
    <>
    {finished && (
      <RunComplete
        finished={finished}
        onOpen={() => onOpenFinishedRun(finished.fileName)}
        onNew={onNewRun}
      />
    )}
    <section className="instrument__panel instrument__experiment">
      <div className="instrument__panelhead">
        <h2 className="instrument__paneltitle">
          {hasResults ? "Run" : "Experiment to start"}
          {showPending ? (
            <span className="instrument__runbadge">pending</span>
          ) : (
            showRunning && <span className="instrument__runbadge">running</span>
          )}
        </h2>
        {/* What it is, read-only. Changing it is the file bar's job — this view takes the selected
            experiment (see {@link InstrumentView}), and a second picker here would be a second way
            to say the same thing, disagreeing with the chips whenever the two drifted apart. */}
        {experiment && (
          <span className="devrun__hint mono instrument__panelname" title={experiment.fileName}>
            {experiment.name}
          </span>
        )}
        {/* The run's state, for the running file only: the rail's Status is the instrument's side
            of the run, and this is the file's — what the follower has made of it so far. */}
        {isRunningFile && (
          <div className="instrument__runstate">
            <Stat
              label="State"
              value={runState}
              tone={runPending || status?.running || runProgress?.inProgress ? "warn" : "good"}
            />
            {runProgress && <Stat label="Plate reads" value={String(runProgress.plateReads)} />}
          </div>
        )}
        {/* Start, for a pending experiment only: a started or finished file has nothing to start,
            and its state (or the clone below) says what it is instead. It is the only control in
            the app that heats a block, so it stays disabled with a reason attached until the
            experiment is startable and every check passes. */}
        {experiment?.pending && (
          <button
            className={
              "btn btn--primary instrument__start" + (looksArmed ? " instrument__start--armed" : "")
            }
            disabled={!canStart}
            aria-disabled={!canStart}
            title={
              missing ??
              `Author ${plan?.commands.length ?? 0} protocol commands, start the run and ` +
                `upload ${plan?.uploads.length ?? 0} files to the instrument.`
            }
            onClick={() => void start()}
          >
            {/* The button's own label answers the click whichever file it was, unlike the badge:
                a thermal-only start has no running file (it leaves no run file to be one), and
                the button is disabled through the pending window either way. */}
            {runPending ? "Run pending…" : "Start experiment"}
          </button>
        )}
      </div>

      {showNotes && (
        <div className="instrument__panelnotes">
          {experiment?.pending && (
            <div className="rail__note instrument__footnote instrument__startreason">
              {missing ??
                `Ready: ${plan!.program.steps.length} steps. The run starts the moment this is ` +
                  "clicked — there is no second confirmation. Close the lid first."}
            </div>
          )}
          {/* The deposit phase's report (`usb.md` §7.4). Only shown when it had something to say:
              the files are provenance, so a problem here means the archive may open without its
              plate map — worth knowing, and not worth an error banner over a running run. */}
          {startNote && startNote.length > 0 && (
            <div className="rail__note instrument__footnote">
              The run started. Its files, though:
              <ul className="instrument__startnote">
                {startNote.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {/* What the follower is doing for this run. It lists the run folder as each plate read
              ends, and once more when the run finishes — not on a timer. */}
          {isRunningFile && (
            <div className="rail__note instrument__footnote instrument__follownote">
              {runWatch.note ??
                "The run folder is listed as each plate read finishes; whatever is new is pulled " +
                  "into this file as it arrives."}
            </div>
          )}
        </div>
      )}

      {!experiment ? (
        <div className="instrument__empty mono">
          <p>
            No experiment selected. An experiment is a file — it holds the protocol to run and the
            plate map to record it against — so select one in the bar above, clone an existing run
            from its Overview, or make a new one. Everything else here works without one.
          </p>
          <button className="btn" onClick={onNewExperiment}>
            New experiment
          </button>
        </div>
      ) : (
        <>
        {hasResults && (
          <div className="instrument__completeactions">
            <span className="devrun__hint">
              {running
                ? "This experiment is running — its results are being written into this file as they arrive. Clone it to set up the same protocol and plate for another run."
                : "This experiment has already been run — its results are part of the file now. Clone it to run the same protocol and plate again."}
            </span>
            <button className="btn" onClick={() => onCloneExperiment(experiment.fileName)}>
              Clone experiment
            </button>
          </div>
        )}
        {plan && <RunChecks plan={plan} />}
        <div className="devrun">
          <div className="devrun__part">
            <PartHead title="Protocol" note={zpcr?.protocol()?.name || null} />
            {protocolText ? (
              <ProtocolDecoded
                text={protocolText}
                annotated={false}
                activeStepNumber={showRunning ? status!.stepNumber : null}
              />
            ) : (
              <div className="instrument__empty mono">
                No protocol yet — write one on the Protocol tab, or attach one from Overview.
              </div>
            )}
          </div>

          <div className="devrun__part">
            <PartHead title="Plate" note={plate ? null : "none"} />
            {plate ? (
              <PlateViewer plate={plate} compact />
            ) : thermalOnly ? (
              // Not a missing piece here: a protocol that never reads the plate has nothing to map
              // wells onto, so asking for one would be asking for a file that would go unused.
              <div className="instrument__empty mono">
                No plate needed — this protocol never reads one. The instrument keeps no run folder
                for such a run, so it produces a run report rather than a run file, and that report
                is what lands in the file bar when it finishes.
              </div>
            ) : (
              <div className="instrument__empty mono">
                No plate attached. This run will record no well, target or sample mapping — attach
                one from Overview to get that.
              </div>
            )}
          </div>
        </div>
        </>
      )}
    </section>
    </>
  );
}
