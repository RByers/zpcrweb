/**
 * The Device view's left rail: connection, identity, live status, and the action buttons.
 *
 * Same `.rail__*` vocabulary the Curves view's rail uses, so the two read as the same kind of
 * surface — but this one is about an instrument rather than a file, which is the whole reason the
 * view sits apart in the tab strip.
 */
import { CFX_COMMANDS, type CfxCommandName } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
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

export function DeviceRail({ device, staged }: { device: CfxDeviceHandle; staged: StagedRun }) {
  const { connection, info, status, busy, lastAction } = device;
  const connected = connection === "connected";
  // What a run still needs, in the order it reads: the button says the *first* missing thing
  // rather than a generic "can't start", so the fix is always the next click.
  const missing = !staged.protocol.value
    ? "Select a protocol in the file bar first."
    : !staged.plate.value
      ? "Select a plate in the file bar first."
      : null;

  return (
    <aside className="curves__rail device__rail">
      <div className="rail__section">
        <div className="rail__title">Instrument</div>
        {connection === "unsupported" ? (
          <div className="rail__note mono">
            This browser has no WebUSB. Chrome, Edge or another Chromium browser on a secure
            origin (https, or localhost) can talk to the instrument directly; Firefox and Safari
            cannot.
          </div>
        ) : (
          <div className="device__connect">
            <button
              className="btn"
              onClick={connected ? device.disconnect : device.connect}
              disabled={connection === "connecting"}
            >
              {connected ? "Disconnect" : connection === "connecting" ? "Connecting…" : "Connect over USB"}
            </button>
            <span className={"device__dot" + (connected ? " is-on" : "")} aria-hidden="true" />
          </div>
        )}
        {device.error && <div className="rail__note mono">{device.error}</div>}
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
            <label className="switch device__pollswitch">
              <input
                type="checkbox"
                checked={device.polling}
                onChange={(e) => device.setPolling((e.target as HTMLInputElement).checked)}
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
              <div className="rail__note device__footnote">
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
              instrument* — that is what this group is. Permanently disabled for now: the library
              has no RemoteRun/PROCEED (`usb.md` §10), and this is the one control in the app that
              would heat a block, so it says what it is waiting for rather than looking armed. */}
          <button
            className="btn btn--primary device__start"
            disabled
            title={
              missing ??
              "Not implemented yet: starting a run needs RemoteRun and PROCEED (usb.md §3), " +
                "which this library doesn't have."
            }
          >
            Start run
          </button>
          <div className="rail__note device__footnote">
            {missing ?? "Staged and ready — but this client has no run-control commands yet."}
          </div>
          <div className="device__actions">
            {(Object.keys(CFX_COMMANDS) as CfxCommandName[]).map((name) => {
              const spec = CFX_COMMANDS[name];
              const unverified = spec.confidence === "unverified";
              return (
                <button
                  key={name}
                  className={"btn device__action" + (unverified ? " device__action--unverified" : "")}
                  disabled={!!busy}
                  title={spec.note}
                  onClick={() => void device.runAction(name, spec)}
                >
                  {spec.label}
                  {unverified && <span className="device__badge">?</span>}
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
            <div className="rail__note device__footnote">
              Buttons marked <span className="device__badge">?</span> send a command name this
              protocol was never observed using — the instrument may reject them. The result code
              is reported below and in the console.
            </div>
          )}
          {lastAction && (
            <div className={"device__result" + (lastAction.ok ? " is-ok" : " is-bad")}>
              <span className="mono">{lastAction.command}</span> → {lastAction.code}
              {lastAction.ok ? " (accepted)" : " (rejected)"}
            </div>
          )}
        </div>
      )}

      {busy && <div className="rail__note mono device__busy">{busy}…</div>}
    </aside>
  );
}
