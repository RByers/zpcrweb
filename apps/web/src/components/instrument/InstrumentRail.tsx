/**
 * The Instrument view's left rail: connection, identity, live status, and the action buttons.
 *
 * Same `.rail__*` vocabulary the Curves view's rail uses, so the two read as the same kind of
 * surface — but this one is about an instrument rather than a file, which is the whole reason the
 * view sits apart in the tab strip.
 */
import { useEffect, useState } from "react";
import { CFX_COMMANDS, isPaused, type CfxCommandName, type CfxStatusFlags, type RunPlan } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import type { RunWatchState } from "../../state/useRunWatch";
import type { InstrumentExperiment } from "../views/InstrumentView";
import { LiveThermalChart } from "./LiveThermalChart";

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "warn" | "good";
  title?: string;
}) {
  return (
    <div className="devstat" title={title}>
      <span className="devstat__label">{label}</span>
      <span className={"devstat__value" + (tone ? ` devstat__value--${tone}` : "")}>{value}</span>
    </div>
  );
}

const temp = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${v.toFixed(digits)} °C`;

/** `mm:ss`, or `h:mm:ss` past an hour — deliberately not sub-second, since none of `STATUS?`'s
 * clocks warrant that precision (`usb.md` §3.2). */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const REMAINING_TITLE =
  "The instrument's own estimate, not a precise countdown: it doesn't count time spent on a " +
  "plate read or on the initial lid heat, so it tends to run a bit optimistic as a run goes on.";

const STATUS_FLAG_LABELS: [key: keyof CfxStatusFlags, label: string][] = [
  ["lidPreheating", "Preheating lid"],
  ["incubating", "Incubating"],
  ["atTarget", "At target"],
  ["paused", "Paused"],
  ["cancelled", "Cancelled"],
];

export function InstrumentRail({
  instrument,
  experiment,
  plan,
  runWatch,
  onStart,
}: {
  instrument: CfxDeviceHandle;
  /** The experiment the active file is, or null when it isn't one (`InstrumentView`). */
  experiment: InstrumentExperiment | null;
  /** The experiment as it would be sent, or null when it has no protocol yet (`InstrumentView`). */
  plan: RunPlan | null;
  runWatch: RunWatchState;
  /**
   * Start the experiment: writes the `begun` marker into its own file and then sends the run
   * (`App`'s `startExperiment`). Unlike the seeding it replaced, this creates no file — the
   * experiment already exists, so there is nothing to write first and nothing to name.
   */
  onStart: (plan: RunPlan) => Promise<void> | void;
}) {
  const { connection, info, status, rtStatus, busy, lastAction, runProgress, runPending } = instrument;
  const connected = connection === "connected";
  // What the last start did — kept so the deposit phase can report itself. A run whose files
  // didn't copy is still a run (`usb.md` §7.4), so this is a note, never a failure.
  const [startNote, setStartNote] = useState<string[] | null>(null);
  // What a run still needs, in the order it reads: the button says the *first* missing thing
  // rather than a generic "can't start", so the fix is always the next click.
  const blockers = plan?.checks.filter((c) => c.severity === "error") ?? [];
  /**
   * What is missing before the plan is even consulted — an experiment to start, in a state where
   * starting it means anything, and something to send it to. None of these is fixed in this rail,
   * or by clicking anything in it; each names where it *is* fixed instead.
   *
   * A run that already has results is the one case that isn't a missing piece but a wrong object:
   * re-running it would either overwrite what it holds or contradict it, so the fix is a new
   * experiment, and `InstrumentRun` offers the clone that makes one. A run still going gets its
   * own line ahead of that one — it is equally unstartable, but "already been run" is untrue while
   * the block is still cycling, and the honest answer is also the more useful one.
   */
  const unstartable = !experiment
    ? "Select or create an experiment first."
    : experiment.inProgress
      ? "This experiment is running right now — its results are still arriving."
      : !experiment.pending
        ? "This experiment has already been run — clone it to run the same protocol again."
        : !experiment.named
          ? "Name this experiment on its Overview tab first."
          : !experiment.zpcr.protocolText
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
  // The USB command channel carries one request at a time, so every button that only *this* rail
  // can queue behind (Start, Stop, Pause/Resume) has to become *un-clickable* the instant any
  // other command is in flight — but a lid or indicator command round-trips fast enough that
  // dimming a button for that whole window reads as a flash rather than a state change, and that
  // was as true of clicking Pause/Resume itself (which is exactly such a round trip) as of Start.
  // Delay only the dimmed *look* by a beat; each button's real `disabled` attribute never waits,
  // so the race this guards against still can't happen. A pending run is the exception for Start —
  // that dims immediately, because there the change of state *is* the feedback for the click, and
  // it will not be over in a beat.
  const [busyLingering, setBusyLingering] = useState(false);
  useEffect(() => {
    if (!busy) {
      setBusyLingering(false);
      return;
    }
    const t = window.setTimeout(() => setBusyLingering(true), 150);
    return () => window.clearTimeout(t);
  }, [busy]);
  // True for the brief, purely-transient window where `busy` is set but hasn't lasted long enough
  // to be worth showing as disabled — see the comment above.
  const busyBriefly = !!busy && !busyLingering;
  const startLooksArmed =
    !unstartable && !!plan && plan.startable && connected && !status?.running && !runPending && busyBriefly;

  // A run is *this rail's business* whenever the instrument is doing one or is about to — which
  // is not the same as `status.running`. The start window (`usb.md` §7.3) is precisely the gap
  // where a run exists and `STATUS?` still says idle, and it is where a cancel is most often
  // wanted and least likely to work, so `runPending` counts. So does §7.6's finished-but-held
  // state, where Stop is what releases the instrument.
  const paused = !!status && isPaused(status);
  const runUnderway = !!status?.running || runPending;
  const showRunControls = connected && (runUnderway || !!status?.runName);
  // What the last stop reported, so a cancel that had to wait for a plate read, resume a pause or
  // take two attempts says so rather than just appearing to have taken a long time.
  const [stopNote, setStopNote] = useState<string[] | null>(null);

  const stop = async () => {
    setStopNote(null);
    const res = await instrument.cancelRun();
    if (!res) return;
    const notes = [...res.notes];
    if (res.attempts > 1) {
      notes.push(
        `It took ${res.attempts} attempts — the first was accepted and ignored, which is what ` +
          "happens to a cancel sent before the run has really begun.",
      );
    }
    if (res.timedOut) notes.push("The instrument is still reporting a running protocol.");
    else if (res.stopped && res.sawCancelledFlag) {
      notes.push("The instrument confirmed the abort (status register bit 7).");
    }
    if (res.errors.length > 0) notes.push(`Instrument errors: ${res.errors.join(", ")}`);
    setStopNote(notes.length > 0 ? notes : null);
  };

  const start = async () => {
    if (!plan || !canStart) return;
    // Marking the file begun and sending the run are one action, in that order — the same order the
    // seeding this replaced used, and for the same reason: the run is about to exist whether or not
    // every upload lands, so the file has to say so first (`App`'s `startExperiment`).
    await onStart(plan);
    const result = await instrument.startRun(plan);
    setStartNote(result ? result.uploadErrors : null);
  };

  return (
    <aside className="curves__rail instrument__rail">
      <div className="rail__section">
        <div className="rail__title">Instrument</div>
        {connection === "unsupported" ? (
          <div className="rail__note mono">
            This browser has no WebUSB. Chrome, Edge or another Chromium browser on a secure
            origin (https, or localhost) can talk to the instrument directly; Firefox and Safari
            cannot.
          </div>
        ) : (
          <div className="instrument__connect">
            <button
              className="btn"
              onClick={connected ? instrument.disconnect : instrument.connect}
              disabled={connection === "connecting"}
            >
              {connected ? "Disconnect" : connection === "connecting" ? "Connecting…" : "Connect over USB"}
            </button>
            <span className={"instrument__dot" + (connected ? " is-on" : "")} aria-hidden="true" />
          </div>
        )}
        {instrument.error && <div className="rail__note mono">{instrument.error}</div>}
      </div>

      {connected && info && (
        // Collapsed by default: these fields don't change once connected, so they're worth a
        // confirming glance rather than permanent space that pushes the more useful Status down.
        <details className="rail__section rail__details">
          <summary className="rail__title">
            <span>
              <span className="rail__chevron" aria-hidden="true">
                ▸
              </span>
              Identity
            </span>
          </summary>
          <Stat label="Model" value={`${info.manufacturer.replace(/ LABORATORIES$/, "")} ${info.model}`} />
          <Stat label="Serial" value={info.serial || "—"} />
          <Stat label="Firmware" value={info.firmware || "—"} />
          {info.frontEndSoftware && <Stat label="Front end" value={info.frontEndSoftware} />}
          <Stat
            label="Block"
            value={`${info.blockDescription ?? "?"}${info.alphaId ? ` (id ${info.alphaId})` : ""}`}
          />
          {info.alphaSerial && <Stat label="Head serial" value={info.alphaSerial} />}
          {info.freeSpaceBytes != null && (
            <Stat label="Free storage" value={`${(info.freeSpaceBytes / 1e9).toFixed(2)} GB`} />
          )}
          {info.errorCount != null && (
            <Stat
              label="Errors"
              value={String(info.errorCount)}
              tone={info.errorCount > 0 ? "warn" : "good"}
            />
          )}
        </details>
      )}

      {connected && (
        // Open by default, unlike Identity above: this is what's actually changing while
        // connected, so it should be visible without an extra click.
        <details className="rail__section rail__details" open>
          <summary className="rail__title">
            <span>
              <span className="rail__chevron" aria-hidden="true">
                ▸
              </span>
              Status
            </span>
            <label className="switch instrument__pollswitch">
              <input
                type="checkbox"
                checked={instrument.polling}
                onChange={(e) => instrument.setPolling((e.target as HTMLInputElement).checked)}
              />
              poll
            </label>
          </summary>
          {status ? (
            <>
              <Stat
                label="State"
                // Pending outranks what the instrument last said: between the click and the
                // instrument's first answer, "Idle" is stale rather than wrong, and this is the
                // one moment where what the app knows is ahead of what STATUS? reports.
                value={runPending ? "Run pending" : status.running ? status.stepText : "Idle"}
                tone={runPending || status.running ? "warn" : "good"}
              />
              {/* Elapsed/remaining lead the section, ahead of temperatures — they're what an
                  operator glances at during a run. Remaining is an estimate (usb.md §3.2's field
                  10 doesn't count plate-read or lid-preheat time), never corrected for that here,
                  just labelled so via the tooltip. */}
              {status.running && (
                <div className="instrument__timers">
                  <div className="instrument__timer">
                    <span className="instrument__timer__label">Elapsed</span>
                    <span className="instrument__timer__value">{duration(status.elapsedS)}</span>
                  </div>
                  <div className="instrument__timer" title={REMAINING_TITLE}>
                    <span className="instrument__timer__label">Remaining (est.)</span>
                    <span className="instrument__timer__value">{duration(status.remainingS)}</span>
                  </div>
                </div>
              )}
              {status.running && <LiveThermalChart samples={instrument.liveThermal} />}
              {/* Reserved row, always mounted so its height doesn't come and go with the flags
                  themselves — otherwise everything below (temperatures, Actions' Stop/Pause/Start
                  buttons) shifts up and down as status bits flip. */}
              <div className="instrument__flags">
                {STATUS_FLAG_LABELS.filter(([key]) => status.flags[key]).map(([key, label]) => (
                  <span key={key} className="instrument__flag">
                    {label}
                  </span>
                ))}
              </div>
              <Stat label="Block" value={temp(status.blockTempC, 2)} />
              <Stat label="Sample*" value={temp(status.sampleTempC, 2)} />
              <Stat label="Lid heater" value={temp(status.lidTempC)} />
              <Stat label="Lid" value={status.lid} />
              <Stat
                label="Cycle"
                value={`${status.cycle ?? "—"}${status.cycleCount != null && status.cycleCount !== status.cycle ? ` / ${status.cycleCount}` : ""}`}
              />
              <Stat
                label="Step"
                value={`${status.stepNumber ?? "—"} / ${status.stepCount ?? "—"}`}
              />
              {status.running && (
                <>
                  <Stat label="Step elapsed" value={duration(status.stepElapsedS)} />
                  <Stat label="Ramp elapsed" value={duration(status.rampElapsedS)} />
                  <Stat label="Hold elapsed" value={duration(status.holdElapsedS)} />
                </>
              )}
              <Stat label="Run" value={status.runName || "(none)"} />
              {status.errors.length > 0 && (
                <Stat label="Errors" value={status.errors.join(", ")} tone="warn" />
              )}
              {rtStatus && (
                <>
                  <Stat label="Shuttle" value={temp(rtStatus.shuttleTempC, 2)} />
                  <Stat label="Ambient" value={temp(rtStatus.ambientTempC, 0)} />
                  {rtStatus.faults.length > 0 && (
                    <Stat
                      label="Optical faults"
                      value={rtStatus.faults.map((f) => f.code + (f.extra ? `,${f.extra}` : "")).join(" ")}
                      tone="warn"
                    />
                  )}
                </>
              )}
              <div className="rail__note instrument__footnote">
                * The sample temperature is inferred: it tracks the block and lags it on a ramp,
                but nothing in the protocol names this field.
              </div>
            </>
          ) : (
            <div className="rail__stat">—</div>
          )}
        </details>
      )}

      {connected && (
        <div className="rail__section">
          <div className="rail__title">Actions</div>
          {/* Start leads the actions because it is the one that runs the experiment, and sits with
              them rather than beside the experiment panel because it *actuates the instrument* —
              that is what this group is. It is the only control in the app that heats a block, so
              it stays disabled with a reason attached until the experiment is startable and every
              check passes. Each reason names where it is fixed (see `unstartable`), since none of
              them is fixed here. */}
          <button
            className={
              "btn btn--primary instrument__start" +
              (startLooksArmed ? " instrument__start--armed" : "")
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
            {runPending ? "Run pending…" : "Start experiment"}
          </button>
          <div className="rail__note instrument__footnote">
            {missing ??
              `Ready: ${plan!.program.steps.length} steps. The run starts the moment this is ` +
                "clicked — there is no second confirmation. Close the lid first."}
          </div>
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
          {/* Stop and Pause are not in the generic action grid below, and that is the point.
              Both are stateful operations rather than one word on the wire (`usb/commands.ts`
              says why): Stop drives `usb.md` §7.8's whole sequence and Pause is one half of a
              state read back from the status register, so each needs its own label, its own
              enabled rule and its own report. They appear only while there is a run to act on. */}
          {showRunControls && (
            <div className="instrument__runcontrols">
              <button
                className={
                  "btn instrument__stop" + (busyBriefly ? " instrument__stop--armed" : "")
                }
                disabled={!!busy}
                title={
                  "Stop the run in progress. Waits for a plate read in flight to finish, so the " +
                  "cycle already under way isn't thrown away (usb.md §7.8)."
                }
                onClick={() => void stop()}
              >
                {busy === "Stopping the run" ? "Stopping…" : "Stop run"}
              </button>
              <button
                className={
                  "btn instrument__pause" + (busyBriefly ? " instrument__pause--armed" : "")
                }
                disabled={!!busy || !status?.running}
                title={
                  status?.running
                    ? paused
                      ? "Continue the suspended protocol (RESUME)."
                      : "Suspend the running protocol (PAUSE). The block holds where it is."
                    : "There is no running protocol to pause."
                }
                onClick={() => void instrument.setRunPaused(!paused)}
              >
                {paused ? "Resume run" : "Pause run"}
              </button>
            </div>
          )}
          {showRunControls && paused && (
            <div className="rail__note instrument__footnote">
              This run is paused — the block is holding its current temperature. A run armed to
              start from the instrument's own touchscreen reports itself paused in the same way
              (<code>usb.md</code> §7.9), so if this run has not begun yet, press Start there.
            </div>
          )}
          {stopNote && stopNote.length > 0 && (
            <div className="rail__note instrument__footnote">
              <ul className="instrument__startnote">
                {stopNote.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {/* No tooltips here: each spec's `note` is provenance written for whoever maintains the
              command table — it cites `usb.md` sections, which mean nothing to an operator — and
              the labels already say what the buttons do. */}
          <div className="instrument__actions">
            {(Object.keys(CFX_COMMANDS) as CfxCommandName[]).map((name) => {
              const spec = CFX_COMMANDS[name];
              const unverified = spec.confidence === "unverified";
              return (
                <button
                  key={name}
                  className={
                    "btn instrument__action" +
                    (unverified ? " instrument__action--unverified" : "")
                  }
                  disabled={!!busy}
                  onClick={() => void instrument.runAction(name, spec)}
                >
                  {spec.label}
                  {unverified && <span className="instrument__badge">?</span>}
                </button>
              );
            })}
          </div>
          {/* Only shown when something actually is a guess. Every action is currently `observed`,
              so this normally renders nothing — but the note has to appear on its own the moment
              an unverified command is added, rather than being remembered about separately. */}
          {(Object.keys(CFX_COMMANDS) as CfxCommandName[]).some(
            (n) => CFX_COMMANDS[n].confidence === "unverified",
          ) && (
            <div className="rail__note instrument__footnote">
              Buttons marked <span className="instrument__badge">?</span> send a command name this
              protocol was never observed using — the instrument may reject them. The result code
              is reported below and in the console.
            </div>
          )}
          {lastAction && (
            <div className={"instrument__result" + (lastAction.ok ? " is-ok" : " is-bad")}>
              <span className="mono">{lastAction.command}</span> → {lastAction.code}
              {lastAction.ok ? " (accepted)" : " (rejected)"}
            </div>
          )}
        </div>
      )}

      {/* What the run watcher is doing. Its own section rather than a line in Status, because it
          is about *this app's* file list rather than about the instrument — the run keeps going
          whether or not anything here is following it. */}
      {connected && (
        <div className="rail__section">
          <div className="rail__title">
            Current run
            <label className="switch instrument__pollswitch">
              <input
                type="checkbox"
                checked={runWatch.watching}
                onChange={(e) => runWatch.setWatching((e.target as HTMLInputElement).checked)}
              />
              follow
            </label>
          </div>
          {/* A pending start shows here even before the folder has ever been listed: the whole
              point of it is to answer the click, and "—" would not. */}
          {runProgress || runPending ? (
            <>
              <Stat
                label="State"
                value={
                  // `STATUS?`'s `running` flag is live and free — it's already being polled for
                  // the Status section above — so it settles "in progress" the instant a run
                  // starts, without waiting on the run folder to be listed (that only happens on
                  // usb.md's own §7.5/§7.6 edges, not on a run merely starting). Ahead of even
                  // that is a locally pending start, which nothing on the wire knows about yet.
                  runPending
                    ? "run pending"
                    : status?.running || runProgress?.inProgress
                      ? "in progress"
                      : runProgress?.ended
                        ? "finished"
                        : "no run"
                }
                tone={runPending || status?.running || runProgress?.inProgress ? "warn" : "good"}
              />
              {runProgress && <Stat label="Plate reads" value={String(runProgress.plateReads)} />}
            </>
          ) : (
            <div className="rail__stat">—</div>
          )}
          <div className="rail__note instrument__footnote">
            {runWatch.note ??
              "The run folder is listed every few seconds; when it changes, the run is pulled " +
                "and kept in the file bar as a .zpcr."}
          </div>
        </div>
      )}

      {/* Boxed rather than a plain note: this fires for every command, including the near-instant
          ones (lid open/close), so it needs to read as a live status readout — not an error or a
          glitch — even when it only lives on screen for a beat. */}
      {busy && (
        <div className="instrument__busybox mono">
          <span className="instrument__busydot" aria-hidden="true" />
          {busy}…
        </div>
      )}
    </aside>
  );
}
