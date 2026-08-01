/**
 * The raw USB traffic console — every framed message in both directions, as decoded by
 * `CfxDevice`'s traffic callback.
 *
 * Shows *logical messages*, not USB packets: the reassembler upstream has already joined the
 * 64-byte transfers into whole messages, which is the level at which the protocol is legible (see
 * `packages/core/src/usb/frame.ts`). Channel is shown on every line because a reply that arrives
 * on channel 2 rather than 1 is precisely the thing that would otherwise be invisible.
 *
 * **Read-only, deliberately.** This panel used to carry a prompt that sent whatever was typed
 * into it. It doesn't any more, and `CfxDevice` no longer offers a way to build one: the command
 * vocabulary is reverse-engineered (`usb.md` §3), the instrument on the other end heats a block
 * and moves a lid, and a mistyped line there is indistinguishable from an intended one. What the
 * app can ask the instrument to *do* is the fixed set of buttons in `DeviceRail`, each backed by
 * an entry in `CFX_COMMANDS`. Watching the traffic keeps all of the debugging value the prompt
 * had; typing into it was the part with the sharp edge.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CfxDeviceHandle, TrafficLine } from "../../state/useCfxDevice";

const time = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

/** The three status queries the poll repeats forever. Filtering them out is what makes the
 * console usable for watching anything else. */
const POLL_COMMANDS = /^(STATUS\?|RTSTATUS\?|ERRORLIST A)/;

function isPollLine(line: TrafficLine, prevOut: string | null): boolean {
  if (line.direction === "out") return line.text !== null && POLL_COMMANDS.test(line.text);
  return prevOut !== null && POLL_COMMANDS.test(prevOut);
}

export function DeviceConsole({ device }: { device: CfxDeviceHandle }) {
  const [hidePolls, setHidePolls] = useState(true);
  const [follow, setFollow] = useState(true);
  // Tracked because a closed panel has no scrollable body: without this the first thing seen on
  // opening would be the *top* of the backlog, whatever "follow" says.
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // A response carries no copy of the request, so "is this a poll reply?" is answered by the
  // request it followed — tracked here in one pass rather than guessed at per line.
  const lines = useMemo(() => {
    let prevOut: string | null = null;
    return device.traffic.filter((line) => {
      const poll = isPollLine(line, prevOut);
      if (line.direction === "out") prevOut = line.text;
      return !(hidePolls && poll);
    });
  }, [device.traffic, hidePolls]);

  useEffect(() => {
    if (!open || !follow || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines, follow, open]);

  return (
    // Collapsed by default: the console is for watching the protocol when something is being
    // debugged, not a thing to have open while using the view.
    <details
      className="device__panel device__panel--console device__panel--collapsible"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="device__panelhead">
        <h2 className="device__paneltitle">
          <span className="rail__chevron" aria-hidden="true">
            ▸
          </span>
          USB traffic
        </h2>
        {/* These act on the console, not on the panel — but they need no guard: the checkboxes
            and the button are their own activation targets, so the <summary> around them never
            sees the click as a toggle. */}
        <div className="device__consoleopts">
          <label className="switch">
            <input
              type="checkbox"
              checked={hidePolls}
              onChange={(e) => setHidePolls((e.target as HTMLInputElement).checked)}
            />
            hide polling
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow((e.target as HTMLInputElement).checked)}
            />
            follow
          </label>
          <button className="btn btn--sm" onClick={device.clearTraffic}>
            Clear
          </button>
        </div>
      </summary>

      <div className="device__consolebody mono" ref={bodyRef}>
        {lines.length === 0 ? (
          <div className="device__empty">
            {device.connection === "connected"
              ? "No traffic yet."
              : "Connect to watch the protocol."}
          </div>
        ) : (
          lines.map((l) => (
            <div
              key={l.id}
              className={
                "device__line" +
                (l.direction === "out" ? " is-out" : " is-in") +
                (l.unsolicited ? " is-unsolicited" : "")
              }
            >
              <span className="device__linetime">{time(l.at)}</span>
              <span className="device__linedir">{l.direction === "out" ? "→" : "←"}</span>
              <span className="device__linechan" title={`channel ${l.channel}`}>
                ch{l.channel}
              </span>
              <span className="device__linebody">
                {l.text !== null ? l.text : l.hex}
                {l.text === null && <span className="device__linebytes"> ({l.bytes} B)</span>}
              </span>
            </div>
          ))
        )}
      </div>
    </details>
  );
}
