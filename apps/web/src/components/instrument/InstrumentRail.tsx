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
import type { StagedRun } from "../../lib/protocolSource";
import { useLiveThermalHistory } from "../../state/useLiveThermalHistory";
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
function duration(seconds: number | null | undefined): string {
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
  staged,
  plan,
  runWatch,
  onStart,
  onNeedName,
}: {
  instrument: CfxDeviceHandle;
  staged: StagedRun;
  /** The staged run as it would be sent, or null when a half is missing (`InstrumentView`). */
  plan: RunPlan | null;
  runWatch: RunWatchState;
  /** Called the instant Start run is clicked, before anything goes out on the wire: the view
   * writes the run's `.zpcr` from what is staged (see `InstrumentView`'s `seedRunFile`). */
  onStart: () => void;
  /** Put the cursor in the Experiment name field — what a click on Start run does when the only
   * thing missing is that name (see `promptForName` below). */
  onNeedName: () => void;
}) {
  const { connection, info, status, rtStatus, busy, lastAction, runProgress, runPending } = instrument;
  const connected = connection === "connected";
  const liveThermal = useLiveThermalHistory(status);
  // What the last start did — kept so the deposit phase can report itself. A run whose files
  // didn't copy is still a run (`usb.md` §7.4), so this is a note, never a failure.
  const [startNote, setStartNote] = useState<string[] | null>(null);
  // What a run still needs, in the order it reads: the button says the *first* missing thing
  // rather than a generic "can't start", so the fix is always the next click.
  const blockers = plan?.checks.filter((c) => c.severity === "error") ?? [];
  // What is missing before the plan is even consulted — the run's two halves, and something to
  // send them to. None of these is fixed in this rail, or by clicking anything in it.
  const unstaged = !staged.protocol.value
    ? "Select a protocol in the file bar first."
    : !staged.plate.value
      ? "Select a plate in the file bar first."
      : !connected
        ? "Connect to the instrument first."
        : null;
  const missing =
    unstaged ??
    (blockers.length > 0
      ? blockers[0]!.message
      : runPending
        ? "The run has been started; waiting for the instrument to report it."
        : status?.running
          ? "The instrument is already running something."
          : null);
  // An unnamed run is the one blocker whose fix is a single field a few pixels away, and a button
  // that is merely dim doesn't say which field. So this one stays clickable and the click *is*
  // the explanation: it puts the cursor in Experiment name (`InstrumentView`'s `focusName`). It
  // still looks and reports as unstartable — `aria-disabled`, the dimmed class, and a title that
  // names the requirement — so nothing about it invites a click expecting a run to begin.
  const promptForName = !unstaged && blockers.some((c) => c.code === "no-experiment-name");
  const canStart =
    !!plan && plan.startable && connected && !busy && !runPending && !status?.running;
  // The USB command channel carries one request at a time, so Start run has to become
  // *un-clickable* the instant any other command is in flight — but a lid or indicator command
  // round-trips fast enough that dimming the button for that whole window reads as a flash
  // rather than a state change. Delay only the dimmed *look* by a beat; `canStart` above (and so
  // the real `disabled` attribute) never waits, so the race this guards against still can't happen.
  // A pending run is the exception — that dims immediately, because there the change of state *is*
  // the feedback for the click, and it will not be over in a beat.
  const [busyLingering, setBusyLingering] = useState(false);
  useEffect(() => {
    if (!busy) {
      setBusyLingering(false);
      return;
    }
    const t = window.setTimeout(() => setBusyLingering(true), 150);
    return () => window.clearTimeout(t);
  }, [busy]);
  const startLooksArmed =
    !!plan &&
    plan.startable &&
    connected &&
    !status?.running &&
    !runPending &&
    !!busy &&
    !busyLingering;

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
    // Belt and braces: the button is clickable while `promptForName`, and nothing but its own
    // `onClick` routing keeps that click away from here.
    if (!plan || !canStart) return;
    // The file first, and unconditionally: the run is about to exist whether or not every upload
    // lands, and the seed is what gives it somewhere to be seen for the minutes before the first
    // plate read (`core/runSeed.ts`).
    onStart();
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
              {status.running && <LiveThermalChart samples={liveThermal} />}
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
          {/* Start run leads the actions because it is the one that runs the experiment, and
              sits with them rather than beside the staged run because it *actuates the
              instrument* — that is what this group is. It is the only control in the app that
              heats a block, so it stays disabled with a reason attached until every half of the
              run is present and every check passes. */}
          <button
            className={
              "btn btn--primary instrument__start" +
              (startLooksArmed ? " instrument__start--armed" : "") +
              (promptForName ? " is-disabled" : "")
            }
            disabled={!canStart && !promptForName}
            aria-disabled={!canStart}
            title={
              promptForName
                ? "Experiment name required to run"
                : (missing ??
                  `Author ${plan?.commands.length ?? 0} protocol commands, start the run and ` +
                    `upload ${plan?.uploads.length ?? 0} files to the instrument.`)
            }
            onClick={promptForName ? onNeedName : () => void start()}
          >
            {runPending ? "Run pending…" : "Start run"}
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
                className="btn instrument__stop"
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
                className="btn"
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
