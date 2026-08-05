/**
 * The experiment that would be started: its thermal protocol and its plate map, side by side.
 *
 * Both halves come from the **one experiment file** the app is on — this panel renders a file it
 * does not own (see {@link InstrumentView} for how that file is chosen, and what the three cases
 * are). It used to render a three-slot staging selection instead, where each half could be
 * overridden by some other loaded file; there are no overrides any more, so a half is either in
 * the experiment or it isn't, and there is no source to name beyond the file itself.
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
 * read-only. It used to be a required field on this panel, which meant the run being staged had a
 * name that lived nowhere until it was started; a file that exists can simply be asked what it is
 * called.
 *
 * There is no "start" button here: it lives in the rail with the other commands that actuate the
 * instrument (see `InstrumentRail`), because that is what it is.
 */
import type { CfxStatus, RunPlan } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { PlateViewer } from "../plate/PlateViewer";
import { duration } from "./InstrumentRail";
import type { InstrumentExperiment } from "../views/InstrumentView";

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
 * Sits between the two halves it is about, not in the rail beside the button: the fix for
 * "channel 3 is never read" is to change one of these two halves, and the message is only
 * actionable next to them. An `error` blocks the start; a `warning` — which is what a missing
 * plate is — is worth reading and doesn't.
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

export function InstrumentRun({
  experiment,
  plan,
  status,
  pending,
  finished,
  onOpenFinishedRun,
  onNewRun,
  onCloneExperiment,
}: {
  /** The experiment the active file is, or null when it isn't one ({@link InstrumentExperiment}). */
  experiment: InstrumentExperiment | null;
  /** The experiment as it would be sent, or null when it has no protocol yet. */
  plan: RunPlan | null;
  /** The instrument's live status (`InstrumentView`), or null when disconnected. Used only to
   * mark which protocol line is executing right now — this panel shows the *active file*, not
   * necessarily what's running, so the highlight is a bonus for the common case (they are the same
   * run) rather than something this panel asserts as fact. */
  status: CfxStatus | null;
  /** True from the click on Start until the instrument's first status answers it — the badge has to
   * say something in that window, since the run is neither un-started nor yet running. */
  pending: boolean;
  /** A run this session watched finish, or null (`state/useRunWatch.ts`). */
  finished: { name: string; totalS: number; fileName: string } | null;
  /** "Open run": jump to that run's curves. */
  onOpenFinishedRun: (fileName: string) => void;
  /** Dismiss the "Run complete" banner. */
  onNewRun: () => void;
  /** Clone this run into a fresh pending experiment — offered when it already has results. */
  onCloneExperiment: () => void;
}) {
  const zpcr = experiment?.zpcr ?? null;
  const protocolText = zpcr?.protocolText || null;
  const plate = zpcr?.plates()[0]?.pltd.plate ?? null;
  // A run with results is not startable, and this is where that is discovered — so the panel says
  // why and offers the fix, rather than leaving a disabled button in the rail to explain itself.
  const hasResults = !!experiment && !experiment.pending;

  return (
    <>
    {finished && (
      <RunComplete
        finished={finished}
        onOpen={() => onOpenFinishedRun(finished.fileName)}
        onNew={onNewRun}
      />
    )}
    <section className="instrument__panel">
      <div className="instrument__panelhead">
        <h2 className="instrument__paneltitle">
          {hasResults ? "Run" : "Experiment to start"}
          {pending ? (
            <span className="instrument__runbadge">pending</span>
          ) : (
            status?.running && <span className="instrument__runbadge">running</span>
          )}
        </h2>
        {experiment && <span className="devrun__hint mono">{experiment.name}</span>}
      </div>

      {!experiment ? (
        <div className="instrument__empty mono">
          No experiment selected. Create one from the About page, clone an existing run from its
          Overview, or select an experiment in the bar above.
        </div>
      ) : (
        <>
        {hasResults && (
          <div className="instrument__completeactions">
            <span className="devrun__hint">
              This experiment has already been run — its results are part of the file now. Clone it
              to run the same protocol and plate again.
            </span>
            <button className="btn" onClick={onCloneExperiment}>
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
                activeStepNumber={status?.running ? status.stepNumber : null}
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
