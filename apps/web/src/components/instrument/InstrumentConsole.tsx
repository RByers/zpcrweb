/**
 * The raw USB traffic console — every framed message in both directions, as decoded by
 * `CfxDevice`'s traffic callback.
 *
 * Shows *logical messages*, not USB packets: the reassembler upstream has already joined the
 * 64-byte transfers into whole messages, which is the level at which the protocol is legible (see
 * `packages/core/src/usb/frame.ts`). Channel is shown on every line because a reply that arrives
 * on channel 2 rather than 1 is precisely the thing that would otherwise be invisible.
 *
 * **Watching, recording and saving are three things.** What scrolls past here is a capped,
 * poll-filtered window. The *recording* behind it is unconditional and complete — core's
 * `UsbTrafficRecorder` (`usb-traffic.md`), which is what the download button writes out, as the
 * same `usb-traffic.bin` a run's file carries — so a problem noticed after the fact is still
 * recoverable, with every byte of every transfer. The only choice on offer is "save
 * log": whether a finished run's `.zpcr` carries that record, since that copy is the one that
 * outlives the session (see `useCfxDevice`'s `setSaveLog`).
 *
 * **Read-only, deliberately.** This panel used to carry a prompt that sent whatever was typed
 * into it. It doesn't any more, and `CfxDevice` no longer offers a way to build one: the command
 * vocabulary is reverse-engineered (`usb.md` §3), the instrument on the other end heats a block
 * and moves a lid, and a mistyped line there is indistinguishable from an intended one. What the
 * app can ask the instrument to *do* is the fixed set of buttons in `InstrumentRail`, each
 * backed by
 * an entry in `CFX_COMMANDS`. Watching the traffic keeps all of the debugging value the prompt
 * had; typing into it was the part with the sharp edge.
 *
 * **A file's saved log, in the same panel.** Given `saved`, this renders a selected `.zpcr`'s own
 * archived traffic log instead of the live connection's — the case where the selected file is not
 * the run on the block, so live traffic would be about some other run. Same component and markup
 * rather than a sibling, so the two cannot drift apart; what differs is only what a saved log has
 * no use for (the live switches, Clear) and a title that says whose log it is.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon } from "../DownloadIcon";
import { downloadBytes } from "../../lib/download";
import { USB_TRAFFIC_LOG_NAME } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";

/** A traffic log saved inside a file — what the console shows in place of live traffic. */
export interface SavedTrafficLog {
  /** The experiment it belongs to, for the title. */
  name: string;
  /** The archive entry it is stored under — `usb-traffic.bin`, or an older file's plain-text
   * `usb-traffic.log` — which is the name the download saves it as. */
  entry: string;
  /** The entry's stored bytes, verbatim: what the download button writes. */
  bytes: () => Uint8Array;
  /** Its text rendering, computed on first open: a whole run's log can be large, and a closed
   * panel has no use for it. */
  text: () => string;
}

const time = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

export function InstrumentConsole({
  instrument,
  saved,
}: {
  instrument: CfxDeviceHandle;
  /** Show this file's saved log rather than the live connection's traffic. */
  saved?: SavedTrafficLog | null;
}) {
  const [follow, setFollow] = useState(true);
  // Tracked because a closed panel has no scrollable body: without this the first thing seen on
  // opening would be the *top* of the backlog, whatever "follow" says. For a saved log it is also
  // what defers rendering the text until someone asks for it.
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const savedText = useMemo(() => (saved && open ? saved.text() : null), [saved, open]);

  // Already filtered: `useCfxDevice` decides what a hidden poll line is and keeps it out of
  // `traffic` entirely, so this panel re-renders only when something it would actually show
  // arrives. See `pushLine` for why that check lives there and not here.
  const lines = instrument.traffic;

  useEffect(() => {
    if (!open || !follow || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [instrument.traffic, follow, open]);

  // Writes the session's whole recording — not the display-only `traffic`/`lines`, since the point
  // of this button is a complete log for decoding, not a copy of whatever the console happens to
  // be showing. The stored records, not their text: the text rendering previews a long response
  // (`usbTrafficPreview`, the same cut the lines above use), so a text download could never show
  // what a `GETFILE` reply actually carried. The `.bin` is what a run's `.zpcr` holds, and loading
  // it back is how it gets read — the Raw files view renders it one line per message.
  const downloadLog = () => downloadBytes(USB_TRAFFIC_LOG_NAME, instrument.trafficLogBytes());
  // A saved log downloads the file's own entry, verbatim and under its own name.
  const downloadSaved = () => saved && downloadBytes(saved.entry, saved.bytes());

  const downloadButton = (
    <button
      className="raw__download"
      onClick={saved ? downloadSaved : downloadLog}
      // `hasTraffic`, not the recorder's own length: the recorder is a ref, so reading it
      // during render can't re-enable the button on its own — and now that hidden polls
      // cause no re-render, a session that has only ever polled would leave it stuck
      // disabled over a log that is anything but empty.
      disabled={!saved && !instrument.hasTraffic}
      aria-label={saved ? "Download this run's saved USB traffic log" : "Download USB traffic log"}
      title={
        saved
          ? "Download the USB traffic log saved in this run's file"
          : "Download the complete USB traffic log, with every byte of every transfer"
      }
    >
      <DownloadIcon />
    </button>
  );

  return (
    // Collapsed by default: the console is for watching the protocol when something is being
    // debugged, not a thing to have open while using the view.
    <details
      className={
        "instrument__panel instrument__panel--console instrument__panel--collapsible" +
        (saved ? " instrument__panel--savedlog" : "")
      }
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="instrument__panelhead">
        <h2 className="instrument__paneltitle">
          <span className="rail__chevron" aria-hidden="true">
            ▸
          </span>
          {/* Said in the title, so a saved log is never mistaken for what the instrument is
              saying now. */}
          {saved ? "USB traffic saved with this run" : "USB traffic"}
        </h2>
        {saved ? (
          <div className="instrument__consoleopts">
            <span className="devrun__hint mono">{saved.name}</span>
            {downloadButton}
          </div>
        ) : (
        /* These act on the console, not on the panel — but they need no guard: the checkboxes
            and the button are their own activation targets, so the <summary> around them never
            sees the click as a toggle. */
        <div className="instrument__consoleopts">
          {/* The only control here that changes what is *kept* — the rest change what is shown,
              and the recording itself is always running. See `setSaveLog`. */}
          <label
            className="switch"
            title="Attach the recorded USB traffic log to this run's .zpcr file"
          >
            <input
              type="checkbox"
              checked={instrument.saveLog}
              onChange={(e) => instrument.setSaveLog((e.target as HTMLInputElement).checked)}
            />
            save log
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
          {downloadButton}
        </div>
        )}
      </summary>

      <div className="instrument__consolebody mono" ref={bodyRef}>
        {saved ? (
          // Rendered only once opened (`savedText`); the format is core's text rendering, the same
          // one the Raw files view shows for this entry.
          savedText === null ? null : savedText.trim() === "" ? (
            <div className="instrument__empty">The saved log is empty.</div>
          ) : (
            <pre className="instrument__savedlog">{savedText}</pre>
          )
        ) : lines.length === 0 ? (
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
