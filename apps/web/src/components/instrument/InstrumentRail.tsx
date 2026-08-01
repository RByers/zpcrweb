/**
 * The Instrument view's left rail: connection, identity, live status, and the action buttons.
 *
 * Same `.rail__*` vocabulary the Curves view's rail uses, so the two read as the same kind of
 * surface — but this one is about an instrument rather than a file, which is the whole reason the
 * view sits apart in the tab strip.
 */
import { useState } from "react";
import { CFX_COMMANDS, type CfxCommandName, type RunPlan } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import type { RunWatchState } from "../../state/useRunWatch";
import type { StagedRun } from "../../lib/protocolSource";

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "good" }) {
  return (
    <div className="devstat">
      <span className="devstat__label">{label}</span>
      <span className={"devstat__value" + (tone ? ` devstat__value--${tone}` : "")}>{value}</span>
    </div>
  );
}

const temp = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${v.toFixed(digits)} °C`;

export function InstrumentRail({
  instrument,
  staged,
  plan,
  runWatch,
}: {
  instrument: CfxDeviceHandle;
  staged: StagedRun;
  /** The staged run as it would be sent, or null when a half is missing (`InstrumentView`). */
  plan: RunPlan | null;
  runWatch: RunWatchState;
}) {
  const { connection, info, status, busy, lastAction, runProgress } = instrument;
  const connected = connection === "connected";
  // What the last start did — kept so the deposit phase can report itself. A run whose files
  // didn't copy is still a run (`usb.md` §7.4), so this is a note, never a failure.
  const [startNote, setStartNote] = useState<string[] | null>(null);
  // What a run still needs, in the order it reads: the button says the *first* missing thing
  // rather than a generic "can't start", so the fix is always the next click.
  const blockers = plan?.checks.filter((c) => c.severity === "error") ?? [];
  const missing = !staged.protocol.value
    ? "Select a protocol in the file bar first."
    : !staged.plate.value
      ? "Select a plate in the file bar first."
      : !connected
        ? "Connect to the instrument first."
        : blockers.length > 0
          ? blockers[0]!.message
          : status?.running
            ? "The instrument is already running something."
            : null;
  const canStart = !!plan && plan.startable && connected && !busy && !status?.running;

  const start = async () => {
    if (!plan) return;
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
        <div className="rail__section">
          <div className="rail__title">Identity</div>
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
        </div>
      )}

      {connected && (
        <div className="rail__section">
          <div className="rail__title">
            Status
            <label className="switch instrument__pollswitch">
              <input
                type="checkbox"
                checked={instrument.polling}
                onChange={(e) => instrument.setPolling((e.target as HTMLInputElement).checked)}
              />
              poll
            </label>
          </div>
          {status ? (
            <>
              <Stat
                label="State"
                value={status.running ? status.stepText : "Idle"}
                tone={status.running ? "warn" : "good"}
              />
              <Stat label="Block" value={temp(status.blockTempC, 2)} />
              <Stat label="Sample*" value={temp(status.sampleTempC, 2)} />
              <Stat label="Lid heater" value={temp(status.lidTempC)} />
              <Stat label="Lid" value={status.lid} />
              <Stat
                label="Cycle / step"
                value={`${status.cycle ?? "—"} / ${status.step ?? "—"}`}
              />
              <Stat label="Run" value={status.runName || "(none)"} />
              <div className="rail__note instrument__footnote">
                * The sample temperature is inferred: it tracks the block and lags it on a ramp,
                but nothing in the protocol names this field.
              </div>
            </>
          ) : (
            <div className="rail__stat">—</div>
          )}
        </div>
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
            className="btn btn--primary instrument__start"
            disabled={!canStart}
            title={
              missing ??
              `Author ${plan?.commands.length ?? 0} protocol commands, start the run and ` +
                `upload ${plan?.uploads.length ?? 0} files to the instrument.`
            }
            onClick={() => void start()}
          >
            Start run
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
                  title={spec.note}
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
          {runProgress ? (
            <>
              <Stat
                label="State"
                value={
                  runProgress.inProgress
                    ? "in progress"
                    : runProgress.ended
                      ? "finished"
                      : "no run"
                }
                tone={runProgress.inProgress ? "warn" : "good"}
              />
              <Stat label="Plate reads" value={String(runProgress.plateReads)} />
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

      {busy && <div className="rail__note mono instrument__busy">{busy}…</div>}
    </aside>
  );
}
