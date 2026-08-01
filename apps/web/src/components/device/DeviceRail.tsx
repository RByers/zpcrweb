/**
 * The Device view's left rail: connection, identity, live status, and the action buttons.
 *
 * Same `.rail__*` vocabulary the Curves view's rail uses, so the two read as the same kind of
 * surface — but this one is about an instrument rather than a file, which is the whole reason the
 * view sits apart in the tab strip.
 */
import { CFX_COMMANDS, type CfxCommandName } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";

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

export function DeviceRail({ device }: { device: CfxDeviceHandle }) {
  const { connection, info, status, busy, lastAction } = device;
  const connected = connection === "connected";

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
          <div className="rail__note device__footnote">
            Buttons marked <span className="device__badge">?</span> send a command name this
            protocol was never observed using — the instrument is expected to reject them. The
            result code is reported below and in the console.
          </div>
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
