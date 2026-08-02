/**
 * The raw USB traffic console — every framed message in both directions, as decoded by
 * `CfxDevice`'s traffic callback.
 *
 * Shows *logical messages*, not USB packets: the reassembler upstream has already joined the
 * 64-byte transfers into whole messages, which is the level at which the protocol is legible (see
 * `packages/core/src/usb/frame.ts`). Channel is shown on every line because a reply that arrives
 * on channel 2 rather than 1 is precisely the thing that would otherwise be invisible.
 *
 * **Watching and recording are separate.** What scrolls past here is a capped, poll-filtered
 * window that costs nothing to leave open. Keeping it — the uncapped transcript that the download
 * button writes and that a run's `.zpcr` carries as `usb-traffic.log` — happens only while
 * "record" is switched on, and it is off by default (see `useCfxDevice`'s `setRecording`).
 *
 * **Read-only, deliberately.** This panel used to carry a prompt that sent whatever was typed
 * into it. It doesn't any more, and `CfxDevice` no longer offers a way to build one: the command
 * vocabulary is reverse-engineered (`usb.md` §3), the instrument on the other end heats a block
 * and moves a lid, and a mistyped line there is indistinguishable from an intended one. What the
 * app can ask the instrument to *do* is the fixed set of buttons in `InstrumentRail`, each
 * backed by
 * an entry in `CFX_COMMANDS`. Watching the traffic keeps all of the debugging value the prompt
 * had; typing into it was the part with the sharp edge.
 */
import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "../DownloadIcon";
import { downloadText } from "../../lib/download";
import { formatTrafficLog, USB_TRAFFIC_LOG_NAME } from "../../lib/usbTrafficLog";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";

const time = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

export function InstrumentConsole({ instrument }: { instrument: CfxDeviceHandle }) {
  const [follow, setFollow] = useState(true);
  // Tracked because a closed panel has no scrollable body: without this the first thing seen on
  // opening would be the *top* of the backlog, whatever "follow" says.
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Already filtered: `useCfxDevice` decides what a hidden poll line is and keeps it out of
  // `traffic` entirely, so this panel re-renders only when something it would actually show
  // arrives. See `pushLine` for why that check lives there and not here.
  const lines = instrument.traffic;

  useEffect(() => {
    if (!open || !follow || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [instrument.traffic, follow, open]);

  // Reads `recordedTraffic` — the uncapped, un-`clearTraffic`-affected record — not the
  // display-only `traffic`/`lines`, since the point of this button is a complete log for decoding,
  // not a copy of whatever the console happens to be showing. Nothing is there until "record" has
  // been switched on, which is what disables the button below.
  const downloadLog = () =>
    downloadText(USB_TRAFFIC_LOG_NAME, formatTrafficLog(instrument.recordedTraffic.current));

  return (
    // Collapsed by default: the console is for watching the protocol when something is being
    // debugged, not a thing to have open while using the view.
    <details
      className="instrument__panel instrument__panel--console instrument__panel--collapsible"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="instrument__panelhead">
        <h2 className="instrument__paneltitle">
          <span className="rail__chevron" aria-hidden="true">
            ▸
          </span>
          USB traffic
        </h2>
        {/* These act on the console, not on the panel — but they need no guard: the checkboxes
            and the button are their own activation targets, so the <summary> around them never
            sees the click as a toggle. */}
        <div className="instrument__consoleopts">
          {/* Off by default, and deliberately the only control here that changes what is *kept*:
              the two beside it only change what is shown. See `setRecording`. */}
          <label className="switch" title="Capture every message into a log, saved with the run">
            <input
              type="checkbox"
              checked={instrument.recording}
              onChange={(e) => instrument.setRecording((e.target as HTMLInputElement).checked)}
            />
            record
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={instrument.hidePolls}
              onChange={(e) => instrument.setHidePolls((e.target as HTMLInputElement).checked)}
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
          <button className="btn btn--sm" onClick={instrument.clearTraffic}>
            Clear
          </button>
          <button
            className="raw__download"
            onClick={downloadLog}
            // `hasRecording`, not `recordedTraffic.current.length`: the log is a ref, so reading
            // its length during render can't re-enable the button on its own — and now that hidden
            // polls cause no re-render, a recorded session that has only ever polled would leave
            // it stuck disabled over a log that is anything but empty.
            disabled={!instrument.hasRecording}
            aria-label="Download USB traffic log"
            title={
              instrument.hasRecording
                ? "Download the recorded USB traffic log"
                : "Nothing recorded — switch on “record” to capture the traffic"
            }
          >
            <DownloadIcon />
          </button>
        </div>
      </summary>

      <div className="instrument__consolebody mono" ref={bodyRef}>
        {lines.length === 0 ? (
          <div className="instrument__empty">
            {instrument.connection === "connected"
              ? "No traffic yet."
              : "Connect to watch the protocol."}
          </div>
        ) : (
          lines.map((l) =>
            l.kind === "error" ? (
              <div
                key={l.id}
                className={"instrument__line is-error" + (l.fatal ? " is-fatal" : "")}
              >
                <span className="instrument__linetime">{time(l.at)}</span>
                <span className="instrument__linedir">{l.direction === "out" ? "→" : "←"}</span>
                <span className="instrument__linechan">!!</span>
                <span className="instrument__linebody">
                  transfer error (attempt {l.attempt}
                  {l.fatal ? ", giving up" : ", retrying"}): {l.message}
                </span>
              </div>
            ) : (
              <div
                key={l.id}
                className={
                  "instrument__line" +
                  (l.direction === "out" ? " is-out" : " is-in") +
                  (l.unsolicited ? " is-unsolicited" : "")
                }
              >
                <span className="instrument__linetime">{time(l.at)}</span>
                <span className="instrument__linedir">{l.direction === "out" ? "→" : "←"}</span>
                <span className="instrument__linechan" title={`channel ${l.channel}`}>
                  ch{l.channel}
                </span>
                <span className="instrument__linebody">
                  {l.text !== null ? l.text : l.hex}
                  {l.text === null && <span className="instrument__linebytes"> ({l.bytes} B)</span>}
                </span>
              </div>
            ),
          )
        )}
      </div>
    </details>
  );
}
