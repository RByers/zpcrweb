/**
 * The Instrument view's left rail: **the instrument and nothing else** — the connection and every
 * button that actuates the machine, what it is holding for this browser, its identity, its live
 * status, and the report of the last run it performed.
 *
 * Nothing here depends on which file is selected, and that is the rule this rail is built to: a
 * change of selection changes nothing on it. Start used to sit at the head of its buttons, which
 * made the rail answer two questions at once (what is the machine doing, and is *this file*
 * startable) and changed half of it with every chip clicked. Start now lives on the experiment
 * panel (`InstrumentRun`) beside the file it starts, and what the follower says about the run on
 * the block is shown there too, against the file it belongs to.
 *
 * Same `.rail__*` vocabulary the Curves view's rail uses, so the two read as the same kind of
 * surface — but this one is about an instrument rather than a file, which is the whole reason the
 * view sits apart in the tab strip.
 */
import { useEffect, useState } from "react";
import { CFX_COMMANDS, isPaused, type CfxCommandName, type CfxStatusFlags } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import { MOCK_SPEEDS, mockSpeedLabel, useMockSpeed } from "../../state/mockInstrument";
import type { RunWatchState } from "../../state/useRunWatch";
import { LiveThermalChart } from "./LiveThermalChart";
import { InstrumentLastRun } from "./InstrumentLastRun";
import { Stat, useBusyBriefly } from "./instrumentParts";

const temp = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${v.toFixed(digits)} °C`;

/**
 * A button that asks twice — the first click arms it, the second does the thing.
 *
 * The app's existing idiom for a destructive click (`FilesTableView`'s delete), reused here for
 * everything that would disturb a run that is *cycling*: stopping it, pausing it, skipping the
 * step it is on, lifting the lid off the plate. Those are minutes-to-hours of thermal cycling and
 * a plate of consumed reagent, and the rail's buttons sit a few pixels from ones that are
 * harmless — Flash indicator, Close lid — so a misclick has to be recoverable by not clicking
 * again.
 *
 * `confirm` is what makes that conditional: the same Open lid button asks nothing when the block
 * is idle, because then there is no run to disturb. Moving the pointer away cancels the question,
 * so a waiting button never sits there to be triggered by a click meant for something else.
 *
 * The class is `is-confirming`, not `is-armed`: this rail already spells `--armed` for something
 * else entirely — a button that *keeps* its enabled look through a brief busy window
 * (`.instrument__stop--armed`) — and two meanings of "armed" a few lines apart would be a trap.
 */
function ActionButton({
  className,
  disabled,
  title,
  confirm,
  confirmLabel,
  onAct,
  children,
}: {
  className: string;
  disabled?: boolean;
  title?: string;
  /** Ask for a second click. False for the same action when nothing is at stake. */
  confirm: boolean;
  /** What the button says once it has asked — a question naming what the next click does. */
  confirmLabel: string;
  onAct: () => void;
  children: React.ReactNode;
}) {
  const [asked, setAsked] = useState(false);
  // A run that ends while the question is on screen takes the question with it.
  useEffect(() => {
    if (!confirm) setAsked(false);
  }, [confirm]);
  const asking = asked && confirm;
  return (
    <button
      className={className + (asking ? " is-confirming" : "")}
      disabled={disabled}
      title={asking ? `${confirmLabel} Click again, or move away to cancel.` : title}
      onMouseLeave={() => setAsked(false)}
      onClick={() => {
        if (!confirm || asked) {
          setAsked(false);
          onAct();
        } else setAsked(true);
      }}
    >
      {asking ? confirmLabel : children}
    </button>
  );
}

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
  runWatch,
  onOpenReport,
}: {
  instrument: CfxDeviceHandle;
  runWatch: RunWatchState;
  /** Put the instrument's last run report in the file bar — the "Last run" section's "Open report"
   * (`App`'s `openReport`). */
  onOpenReport: (name: string, bytes: Uint8Array) => Promise<string | null>;
}) {
  const { connection, info, status, rtStatus, busy, lastAction, runPending, mock, fakeOffered } = instrument;
  const connected = connection === "connected";
  /** Connected, or on the way there or back — the states the connect button ends rather than starts. */
  const linked = connected || connection === "connecting" || connection === "reconnecting";
  /** Once a real connect has come to nothing (or there is no WebUSB to try one with), the simulated
   * instrument is offered beside it — never before, so a bench with an instrument on it isn't
   * offered a pretend one. */
  const fakeButton = fakeOffered && !linked && (
    <button
      className="btn"
      onClick={instrument.connectFake}
      title="Connect to a simulated CFX96 running in this browser — no hardware needed"
    >
      Fake device
    </button>
  );
  const [mockSpeed, setMockSpeed] = useMockSpeed();
  // Stop and Pause/Resume queue behind the one USB command channel, and clicking Pause/Resume is
  // itself exactly such a fast round trip — so their dimmed look waits a beat (`useBusyBriefly`).
  const busyBriefly = useBusyBriefly(busy);

  // A run is *this rail's business* whenever the instrument is doing one or is about to — which
  // is not the same as `status.running`. The start window (`usb.md` §7.3) is precisely the gap
  // where a run exists and `STATUS?` still says idle, and it is where a cancel is most often
  // wanted and least likely to work, so `runPending` counts.
  //
  // §7.6's finished-but-held state deliberately does *not*. Stop used to show there, on the
  // reasoning that it is what releases the instrument — but `CfxDevice.cancelRun` stops at exactly
  // that state and hands the release to the §7.6 acknowledgement rather than sending anything, so
  // the button was lit, enabled and inert on an idle instrument reporting a finished run. What
  // actually collects that run is the offer below ("Collect run"), which acknowledges as part of
  // asking for it.
  const paused = !!status && isPaused(status);
  const runUnderway = !!status?.running || runPending;
  const showRunControls = connected && runUnderway;
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

  return (
    <aside className="curves__rail instrument__rail">
      <div className="rail__section">
        <div className="rail__title">Instrument</div>
        {connection === "unsupported" ? (
          <>
            <div className="rail__note mono">
              This browser has no WebUSB. Chrome, Edge or another Chromium browser on a secure
              origin (https, or localhost) can talk to the instrument directly; Firefox and Safari
              cannot.
            </div>
            {fakeButton && <div className="instrument__connect">{fakeButton}</div>}
          </>
        ) : (
          <div className="instrument__connect">
            <button
              className="btn"
              // Reconnecting is a connection the user still has, so the button still ends it —
              // that is what stops an automatic retry loop the user no longer wants.
              onClick={
                connected || connection === "reconnecting"
                  ? instrument.disconnect
                  : instrument.connect
              }
              disabled={connection === "connecting"}
            >
              {connected || connection === "reconnecting"
                ? "Disconnect"
                : connection === "connecting"
                  ? "Connecting…"
                  : "Connect over USB"}
            </button>
            {fakeButton}
            <span
              className={
                "instrument__dot" +
                (connected ? " is-on" : connection === "reconnecting" ? " is-warn" : "")
              }
              aria-hidden="true"
            />
          </div>
        )}
        {mock && linked && (
          // Said plainly: a simulated instrument answers exactly as the real one does — that is
          // the point of it — so nothing else on this rail would ever give it away.
          <div className="rail__note mono instrument__mock">
            Simulated instrument — there is no hardware here. The status, the files and the
            readings are all produced in this browser, with a recorded run standing in for what
            the optics would have measured.
          </div>
        )}
        {mock && connected && (
          <div className="instrument__speed">
            <div className="rail__title">Simulated speed</div>
            <div className="segmented segmented--sm" role="group" aria-label="Simulated speed">
              {MOCK_SPEEDS.map((s) => (
                <button
                  key={String(s)}
                  className={"segmented__item" + (s === mockSpeed ? " is-active" : "")}
                  aria-pressed={s === mockSpeed}
                  onClick={() => setMockSpeed(s)}
                >
                  {mockSpeedLabel(s)}
                </button>
              ))}
            </div>
            <div className="rail__note instrument__footnote">
              How fast simulated time runs. 1× is an instrument's own pace, 60× an hour of
              protocol a minute. Max has no clock at all: the run moves on one step each time the
              app asks for status, so it takes as many polls as it has steps rather than any
              amount of time. Changing this applies from that moment on — a run already under way
              carries on from where it had got to, and never jumps.
            </div>
          </div>
        )}
        {connection === "reconnecting" && (
          // The instrument goes on running with or without us, so this says what is and isn't
          // affected — otherwise a dropped cable mid-run reads as a lost run.
          <div className="rail__note mono">
            Connection lost — retrying. A run in progress is unaffected; the instrument keeps
            going, and this reconnects on its own when the link is back.
          </div>
        )}
        {instrument.error && <div className="rail__note mono">{instrument.error}</div>}
        {connected && (
          // Every button that actuates the machine, directly under the one that connects to it.
          // There is no separate "Actions" section any more: these *are* the instrument block —
          // what the machine can be told to do, beside whether it is there to be told.
          <div className="instrument__buttons">
            {/* Stop and Pause are not in the generic action grid below, and that is the point.
                Both are stateful operations rather than one word on the wire (`usb/commands.ts`
                says why): Stop drives `usb.md` §7.8's whole sequence and Pause is one half of a
                state read back from the status register, so each needs its own label, its own
                enabled rule and its own report. They appear only while there is a run to act on. */}
            {/* Both ask twice while a run is actually cycling (see `ActionButton`). Stopping is
                unrecoverable and pausing holds a plate at whatever temperature it reached, so
                neither should be one misclick away from a harmless button. Resuming a paused run asks nothing: it
                puts the run back the way it was. */}
            {showRunControls && (
              <div className="instrument__runcontrols">
                <ActionButton
                  className={
                    "btn instrument__stop" + (busyBriefly ? " instrument__stop--armed" : "")
                  }
                  disabled={!!busy}
                  // No file citation in the copy — the reader has a thermocycler, not this
                  // repository. The sequence this drives is `usb.md` §7.8.
                  title={
                    "Stop the run in progress. Waits for a plate read in flight to finish, so the " +
                    "cycle already under way isn't thrown away."
                  }
                  confirm={runUnderway}
                  confirmLabel="Stop the run?"
                  onAct={() => void stop()}
                >
                  {busy === "Stopping the run" ? "Stopping…" : "Stop run"}
                </ActionButton>
                <ActionButton
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
                  confirm={runUnderway && !paused}
                  confirmLabel="Pause the run?"
                  onAct={() => void instrument.setRunPaused(!paused)}
                >
                  {paused ? "Resume run" : "Pause run"}
                </ActionButton>
              </div>
            )}
            {showRunControls && paused && (
              /* The touchscreen case is `usb.md` §7.9 — kept in this comment rather than in the
                 copy, since the reader has a thermocycler and not this repository. */
              <div className="rail__note instrument__footnote">
                This run is paused — the block is holding its current temperature. A run armed to
                start from the instrument's own touchscreen reports itself paused in the same way,
                so if this run has not begun yet, press Start there.
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
                the labels already say what the buttons do.

                Which of these would disturb a cycling run is the command table's own answer
                (`disruptsRun`), not a list kept here: Skip step advances the protocol, Open lid
                takes the seal off a plate mid-cycle, and both are one click from Flash indicator in
                the same grid. While a run is underway those ask twice; idle, they don't. */}
            <div className="instrument__actions">
              {(Object.keys(CFX_COMMANDS) as CfxCommandName[]).map((name) => {
                const spec = CFX_COMMANDS[name];
                const unverified = spec.confidence === "unverified";
                return (
                  <ActionButton
                    key={name}
                    className={
                      "btn instrument__action" +
                      (unverified ? " instrument__action--unverified" : "")
                    }
                    disabled={!!busy}
                    confirm={runUnderway && spec.disruptsRun === true}
                    confirmLabel={`${spec.label}?`}
                    onAct={() => void instrument.runAction(name, spec)}
                  >
                    {spec.label}
                    {unverified && <span className="instrument__badge">?</span>}
                  </ActionButton>
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
        {/* The run the instrument is holding that this browser hasn't got — the answer to
            connecting after a run has finished, which is otherwise a dead end: a finished run is
            never pulled on sight (`useRunWatch`), so without this the instrument would sit there
            holding a run the user has no way of knowing they could have. It is a fact about what
            the machine is holding, so it lives in the instrument block, under its buttons. Offered rather than taken: the transfer is ~400 KB over a slow channel and
            lands a file in the bar, which is a thing to be asked for. */}
        {connected && runWatch.available && (
          <div className="instrument__offer">
            <div className="instrument__offertext">
              {/* Three claims, not two. A run whose own file is already open — the pending
                  experiment it was started from, which holds none of the run yet — is not a run
                  "you don't have", and saying so about a file sitting in the bar reads as a
                  mistake. What is missing there is the data, and the offer names where it goes
                  (`useRunWatch`'s `available.into`). */}
              {runWatch.available.into
                ? runWatch.available.inProgress
                  ? "A run is in progress here. Collect it into your file for it:"
                  : "The instrument is holding a finished run. Collect it into your file for it:"
                : runWatch.available.inProgress
                  ? "A run is in progress here and isn't in your files yet."
                  : "The instrument is holding a finished run you don't have."}
              <span className="instrument__offername mono">
                {runWatch.available.into ?? runWatch.available.name}
              </span>
              <span className="instrument__offerreads">
                {runWatch.available.plateReads} plate read
                {runWatch.available.plateReads === 1 ? "" : "s"}
              </span>
            </div>
            <button
              className="btn btn--primary btn--sm"
              disabled={!!busy}
              title={
                runWatch.available.into
                  ? "Retrieve every file of this run from the instrument and add it to the " +
                    "file it was started from."
                  : "Retrieve every file of this run from the instrument and open it as a .zpcr."
              }
              onClick={() => void runWatch.downloadAvailable()}
            >
              {runWatch.available.into ? "Collect run" : "Download run"}
            </button>
          </div>
        )}
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
              {status.running && <LiveThermalChart history={instrument.liveThermal} />}
              {/* Reserved row, always mounted so its height doesn't come and go with the flags
                  themselves — otherwise everything below (temperatures, and the sections under
                  Status) shifts up and down as status bits flip. */}
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

      {/* What the machine last ran, read off it on connect. Collapsed: it describes the run
          before this browser got here — worth a glance, not permanent space in the rail. */}
      <InstrumentLastRun instrument={instrument} onOpenReport={onOpenReport} />

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