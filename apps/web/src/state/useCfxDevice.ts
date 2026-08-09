/**
 * Connection state for a CFX96 attached over WebUSB.
 *
 * All the protocol lives in `@zpcrweb/core`'s `CfxDevice` (see `packages/core/src/usb/`), per the
 * app's standing rule that logic belongs in the library — this hook owns only what a *browser
 * session* adds on top: obtaining the device through `navigator.usb`, a poll timer, a bounded
 * traffic log for the debug console, and the React state the view renders.
 *
 * **Everything accumulated from the poll lives here, not in the view.** The traffic recording
 * below and {@link useCfxDevice.liveThermal} are both histories built one status at a time, and a
 * history is only worth having if it spans the whole run — so both belong to the hook, which App
 * mounts once for the session, rather than to a component that unmounts the moment someone opens
 * Curves or picks another file. The block-temperature chart used to buffer inside the Instrument
 * rail and so restarted empty every time the view was left, which is precisely the thing a live
 * chart must not do.
 *
 * The traffic log is kept in two forms, and the difference matters. The **recording** is core's
 * `UsbTrafficRecorder` (`usb-traffic.md`) — every message and transfer error of the session, as
 * compact binary records, always on, and what the console downloads or a run's `.zpcr` carries.
 * `traffic` is the **display window** — capped, cleared by `clearTraffic`, and with poll chatter
 * withheld while `hidePolls` is set, so an idle instrument produces no React updates at all (see
 * {@link pushLine}).
 *
 * Recording is unconditional because the records are cheap: an hour of the status poll is ~237 KB
 * of them, against 1.3 MB of the text the same hour renders to. What is a *choice* is whether the
 * log is attached to the run's file — {@link useCfxDevice.setSaveLog} — since that is the copy
 * that outlives the session and takes up disk.
 *
 * Everything it exposes is a *named* operation — status, listings, file fetches, and `runAction`
 * over the fixed `CFX_COMMANDS` table. There is no "send this line" call, here or in the library
 * beneath it (see `CfxDevice`'s design point 3).
 *
 * The `CfxDevice` itself lives in a ref rather than in state. It is a long-lived object with a
 * background read loop; putting it in `useState` would invite a re-render to be interpreted as a
 * new connection, and re-running `open()` on a claimed interface fails.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CFX_CURRENT_RUN_DIR,
  UsbTrafficRecorder,
  formatUsbTrafficBytes,
  usbTrafficPreview,
  CFX_DIRECTORIES,
  CFX_USB_FILTER,
  CfxDevice,
  parseAlf,
  runProgressFromNames,
  type AlfReport,
  type CfxCommandName,
  type CfxDeviceInfo,
  type CfxDirectory,
  type CfxRtStatus,
  type CfxStatus,
  type CfxTrafficEvent,
  type CfxTransferErrorEvent,
  type RunPlan,
  type RunProgress,
  type UsbDeviceLike,
} from "@zpcrweb/core";
import { useLiveThermalHistory } from "./useLiveThermalHistory";

/** How many messages the debug console keeps. A 1.5 s poll writes six lines a minute; this is
 * roughly an hour of idle polling, and bounds memory on a session left open overnight. */
const TRAFFIC_LIMIT = 400;
/** How many lines the *rebuild* buffer keeps — the record `setHidePolls` reconstructs the display
 * list from, which must include the poll lines the display itself never received. Larger than
 * {@link TRAFFIC_LIMIT} because polls dominate it: at six lines per 1.5 s poll this is around
 * fifteen minutes of idle chatter, enough that un-hiding polls recovers a display window's worth
 * of them. Unlike the recording buffer it is capped, since it is kept whether or not anyone asked
 * for a log. */
const REBUILD_LIMIT = 4000;
/** Status poll period. CFX Manager polls about once a second; this is deliberately slower, since
 * nothing here needs sub-second latency and every poll is three lines of console noise. */
const POLL_MS = 1500;
/** The three status queries the poll repeats forever. Suppressing them is what makes the debug
 * console usable for watching anything else — see {@link useCfxDevice.setHidePolls}. */
const POLL_COMMANDS = /^(STATUS\?|RTSTATUS\?|ERRORLIST A)/;

export type ConnectionState =
  | "unsupported"
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/**
 * The `.alf` the instrument is currently holding in `\Storage Card\PCRunReport` — the last run it
 * ran, whoever started it and whatever it produced (see {@link useCfxDevice.lastReport}).
 *
 * Kept as bytes as well as a decode: the bytes are what "Open report" hands to the file bar, so
 * the file the user ends up with is the instrument's, byte for byte, rather than a re-rendering of
 * our parse of it. `report` is null when those bytes don't decode as a report, which leaves the
 * panel able to say a report is there without claiming to have read it.
 */
export interface LastRunReport {
  name: string;
  bytes: Uint8Array;
  report: AlfReport | null;
}

/**
 * Backoff between reconnect attempts after the connection dropped on its own, in ms; the last
 * value repeats for as long as it takes.
 *
 * It repeats rather than giving up because the case this exists for is a *run in progress*: the
 * instrument goes on cycling whatever the host does, so the only thing a dropped pipe costs is our
 * view of it, and a run is hours long. Retrying forever is cheap and quiet — while the device is
 * unplugged `getDevices()` simply returns nothing, so an attempt is one resolved promise and no
 * error — and the `connect` event below short-circuits the wait the moment it comes back anyway.
 */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/** One decoded message, pre-formatted for display — one kind of line in the debug console. */
export interface TrafficLine {
  kind: "message";
  id: number;
  at: number;
  direction: "out" | "in";
  channel: number;
  unsolicited: boolean;
  /** The payload as text, or `null` when it is binary and must be shown as {@link hex}. */
  text: string | null;
  hex: string;
  bytes: number;
  /** Part of the status poll — see {@link POLL_COMMANDS}. Classified here, on arrival, rather
   * than by whoever renders the line: a reply carries no copy of its request, so the only place
   * the question is cheap to answer is the point where the lines stream past in wire order. */
  poll: boolean;
}

/** A `transferIn`/`transferOut` failure — the console's other kind of line, interleaved with
 * {@link TrafficLine} in wire order so a retry shows up exactly where it interrupted the
 * conversation. See `CfxTransferErrorEvent`'s doc comment for why this exists: a retry the pump
 * recovered from used to leave no trace anywhere a caller could see. */
export interface TransferErrorLine {
  kind: "error";
  id: number;
  at: number;
  direction: "out" | "in";
  message: string;
  attempt: number;
  fatal: boolean;
  /** Always false. A transfer error has no request/reply relationship to filter by, and it is
   * exactly the kind of thing "hide polling" shouldn't hide. */
  poll: false;
}

export type ConsoleLine = TrafficLine | TransferErrorLine;

/** The result of an action button, kept so the view can report what the instrument answered —
 * including a rejection, which for an `unverified` command is the expected outcome. */
export interface ActionResult {
  label: string;
  command: string;
  ok: boolean;
  code: string;
  raw: string;
  at: number;
}

/** WebUSB is Chromium-only and needs a secure context; `navigator.usb` is simply absent
 * otherwise, which is what the view checks to explain itself rather than offering a dead button. */
function usbApi(): {
  requestDevice(o: unknown): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
} | null {
  const nav = navigator as unknown as { usb?: ReturnType<typeof usbApi> };
  return nav.usb ?? null;
}

/** Set once the user has clicked through {@link connect}'s unofficial-software warning — read
 * before every connect attempt so the prompt shows exactly once per browser, not once per
 * session. */
const USB_WARNING_ACK_KEY = "zpcr:usbWarningAck";

function usbWarningAcknowledged(): boolean {
  try {
    return localStorage.getItem(USB_WARNING_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

function ackUsbWarning(): void {
  try {
    localStorage.setItem(USB_WARNING_ACK_KEY, "1");
  } catch {
    /* ignore storage failures (private mode, etc.) — the prompt just reappears next time */
  }
}

export function useCfxDevice() {
  const deviceRef = useRef<CfxDevice | null>(null);
  /** True while the user wants to be connected — set by {@link connect}, cleared by
   * {@link disconnect} and by a connect that failed. This is the whole difference between "the
   * pipe died, get it back" and "the user pressed Disconnect", both of which reach `onClose`. */
  const wantConnected = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** How many attempts the current outage has cost, indexing {@link RECONNECT_DELAYS_MS}. */
  const reconnectAttempt = useRef(0);
  /** Assigned in an effect below, once `reconnectNow` exists. The indirection breaks a genuine
   * cycle: opening a device installs an `onClose` that must schedule a reconnect, and a reconnect
   * opens a device. */
  const scheduleReconnect = useRef<() => void>(() => {});
  const trafficId = useRef(0);
  // The session's complete record, as binary items (core's `UsbTrafficRecorder`, `usb-traffic.md`)
  // rather than console lines: it is unbounded in time, so it is stored in the form that costs
  // ~16 bytes per message instead of the ~85-byte line one renders to. Unaffected by
  // `clearTraffic`, which resets the view only. This is what the console's download button writes
  // and what a run's `.zpcr` carries — both want the complete record, not the display window.
  const recorder = useRef(new UsbTrafficRecorder());
  // Whether the last outbound *message* was a poll query, which is how an inbound reply is
  // classified: it carries no copy of the request it answers.
  const lastOutWasPoll = useRef(false);
  // The lines `setHidePolls` rebuilds the display from, capped at REBUILD_LIMIT and reset by
  // `clearTraffic` — so a rebuild honours the last clear without tracking an offset into anything.
  // Kept as console lines rather than re-read from the recorder: rebuilding is a click, the window
  // it feeds is small and bounded, and decoding a session-long record to recover the last few
  // hundred lines would be work proportional to the whole session.
  const rebuildFrom = useRef<ConsoleLine[]>([]);

  const [connection, setConnection] = useState<ConnectionState>(() =>
    usbApi() ? "disconnected" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<CfxDeviceInfo | null>(null);
  const [status, setStatus] = useState<CfxStatus | null>(null);
  const [rtStatus, setRtStatus] = useState<CfxRtStatus | null>(null);
  const [traffic, setTraffic] = useState<ConsoleLine[]>([]);
  const [directories, setDirectories] = useState<Record<string, CfxDirectory>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<ActionResult | null>(null);
  const [polling, setPolling] = useState(true);
  /** Whether poll traffic is kept out of {@link traffic}. Lives here rather than in the console
   * because it decides what reaches React state at all — see {@link setHidePolls}. */
  const [hidePolls, setHidePollsState] = useState(true);
  // Read by `pushLine`, which is a stable callback wired into the device and so can't close over
  // the state; `setHidePolls` keeps the two in step.
  const hidePollsRef = useRef(true);
  /** Whether a finished run's `.zpcr` gets the recorded log attached — see {@link setSaveLog}. */
  const [saveLog, setSaveLogState] = useState(false);
  // Read by `trafficLogForRun`, which must stay a stable callback for the run watcher's sake.
  const saveLogRef = useRef(false);
  /** True once anything at all has been recorded. A plain boolean rather than a count so it
   * re-renders exactly once, ever — the console's download button needs to know the log is
   * non-empty, and the recorder is a ref that can't announce itself. */
  const [hasTraffic, setHasTraffic] = useState(false);
  /**
   * Set the instant Start run is clicked, cleared by the first `STATUS?` that comes back after the
   * start sequence has run — see {@link useCfxDevice.startRun}.
   */
  const [runPending, setRunPending] = useState(false);
  /** The last listing of `CurrentRun`, which is what the run watcher works from. */
  const [runFolder, setRunFolder] = useState<CfxDirectory | null>(null);
  /** The run report the instrument is holding — see {@link LastRunReport} and `refreshLastReport`. */
  const [lastReport, setLastReport] = useState<LastRunReport | null>(null);
  // The latest status, reachable from a callback without making that callback depend on it —
  // `acknowledgeFinishedRun` must check what the instrument is doing *now*, not what it was doing
  // when the callback was created.
  const statusRef = useRef<CfxStatus | null>(null);
  statusRef.current = status;
  // Likewise for `cancelRun`, which needs to know whether a start was asked for at the moment the
  // stop button was pressed — that is the window where `STATUS?` hasn't caught up yet.
  const runPendingRef = useRef(false);
  runPendingRef.current = runPending;

  /**
   * Append one console line to the rebuild buffer and — unless it's poll traffic being hidden — to
   * the display-capped state. Called from the same two handlers that feed the recorder, so a
   * message and a transfer error interleave in the single arrival order they actually happened in.
   *
   * The `hidePolls` check is **here**, not in the console's render, and that placement is the
   * whole point of the flag. Filtering at render time still put every poll line into React state,
   * so a 1.5 s poll re-rendered the panel and re-ran its follow-scroll six times a minute for
   * lines that were then thrown away — visible as a flash on an otherwise idle console. Hidden
   * polls now cause no state update at all, while the recorder still takes them, so the downloaded
   * log and the copy embedded in a run's `.zpcr` remain complete either way.
   */
  const pushLine = useCallback((line: ConsoleLine) => {
    setHasTraffic(true);
    rebuildFrom.current.push(line);
    if (rebuildFrom.current.length > REBUILD_LIMIT) {
      rebuildFrom.current = rebuildFrom.current.slice(rebuildFrom.current.length - REBUILD_LIMIT);
    }
    if (hidePollsRef.current && line.poll) return;
    setTraffic((prev) => {
      const next = prev.length >= TRAFFIC_LIMIT ? prev.slice(prev.length - TRAFFIC_LIMIT + 1) : prev;
      return [...next, line];
    });
  }, []);

  /** Classify one arriving message against the poll vocabulary, and remember the answer for the
   * reply that follows it. Outbound messages only update the memo — a transfer error goes past
   * without disturbing which request is still outstanding. */
  const classifyPoll = useCallback((direction: "out" | "in", text: string | null) => {
    if (direction === "in") return lastOutWasPoll.current;
    lastOutWasPoll.current = text !== null && POLL_COMMANDS.test(text);
    return lastOutWasPoll.current;
  }, []);

  const onTraffic = useCallback(
    (e: CfxTrafficEvent) => {
      // What the console *shows*: the trimmed decode and the hex, both cut to one line for a long
      // response (core's `usbTrafficPreview`, shared with the text rendering so the two agree).
      // A `GETFILE` reply is a whole file, and putting it in a console line verbatim swamped the
      // panel and parked megabytes of unreadable hex in React state; the recorder below still
      // takes every byte, so nothing is lost but the display of it.
      const shown = usbTrafficPreview(e);
      const poll = classifyPoll(e.direction, shown.text);
      // The recorder takes the event as the device reported it — `e.text` and the whole payload,
      // not the previewed pair above: what it stores is every byte, plus "did the device offer a
      // decode at all", and both the trimming and the elision are display choices re-applied at
      // format time.
      recorder.current.message({
        at: e.at,
        direction: e.direction,
        channel: e.channel,
        payload: e.payload,
        text: e.text,
        unsolicited: e.unsolicited,
        poll,
      });
      pushLine({
        kind: "message",
        id: trafficId.current++,
        at: e.at,
        direction: e.direction,
        channel: e.channel,
        unsolicited: e.unsolicited,
        text: shown.text,
        hex: shown.hex,
        bytes: e.payload.length,
        poll,
      });
    },
    [pushLine, classifyPoll],
  );

  const onTransferError = useCallback(
    (e: CfxTransferErrorEvent) => {
      recorder.current.error(e);
      pushLine({
        kind: "error",
        id: trafficId.current++,
        at: e.at,
        direction: e.direction,
        message: e.message,
        attempt: e.attempt,
        fatal: e.fatal,
        poll: false,
      });
    },
    [pushLine],
  );

  // Deliberately does not touch `traffic`: the console is the one place a disconnect's cause is
  // visible after the fact (what was in flight, what the last messages before the failure were),
  // so wiping it on the same event that most needs debugging would defeat the point.
  /** Drop any pending reconnect and reset the backoff, so the next outage starts at the short
   * delay again rather than wherever the last one left off. */
  const cancelReconnect = useCallback(() => {
    if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    reconnectAttempt.current = 0;
  }, []);

  const teardown = useCallback((next: ConnectionState = "disconnected") => {
    deviceRef.current = null;
    // No request is outstanding across a disconnect, so the next reply must not be classified by
    // whatever the last session happened to have sent.
    lastOutWasPoll.current = false;
    setConnection(next);
    setInfo(null);
    setStatus(null);
    setRtStatus(null);
    setRunPending(false);
    setDirectories({});
    setBusy(null);
    // Read from the instrument at connect and true only of the instrument that was on the other
    // end: a different unit — or the same one after someone ran something at its touchscreen —
    // must not be described by the last one's report.
    setLastReport(null);
  }, []);

  /**
   * Open a device handle and bring the session up on it. Shared by the Connect button and the
   * reconnect loop, so a recovered connection is the same connection in every respect — same
   * traffic recorder, same poll, same identity refresh — rather than a second path that drifts
   * from this one.
   */
  const openDevice = useCallback(
    async (chosen: UsbDeviceLike) => {
      // Set when this handle is abandoned below, before it is closed. Closing fires `onClose`, and
      // without this the cleanup of a *failed* attempt would report the session as disconnected —
      // racing, and usually winning against, the "reconnecting" the caller sets straight after.
      let abandoned = false;
      const device = new CfxDevice(chosen, {
        onTraffic,
        onTransferError,
        onClose: (err) => {
          if (abandoned) return;
          if (err) {
            // The library already logs the retries and the final failure; this adds the one
            // thing it can't know — what the UI is about to do about it — so the console shows
            // cause and effect together rather than an isolated stack trace.
            console.error("[useCfxDevice] device closed unexpectedly:", err);
            setError(err.message);
          }
          // An error close while the user still wants a connection is the reconnect case. An
          // ordinary one is `disconnect()`, which has already cleared the flag.
          if (err && wantConnected.current) {
            teardown("reconnecting");
            scheduleReconnect.current();
          } else {
            teardown();
          }
        },
      });
      await device.open();
      deviceRef.current = device;
      try {
        setConnection("connected");
        setInfo(await device.deviceInfo());
        setStatus(await device.status());
        try {
          setRtStatus(await device.rtStatus());
        } catch {
          /* the poll will catch up */
        }
      } catch (e) {
        // A handle that opened but failed partway through identification is no good to anyone.
        // Closing it here — rather than leaving it to whoever called — is what keeps a failed
        // reconnect attempt from stranding a claimed interface the next attempt then can't take.
        abandoned = true;
        deviceRef.current = null;
        await device.close().catch(() => undefined);
        throw e;
      }
    },
    [onTraffic, onTransferError, teardown],
  );

  /**
   * One reconnect attempt, scheduled by {@link scheduleReconnect} after the pipe died on its own.
   *
   * It never calls `requestDevice()`: a picker needs a user gesture and would throw here. What
   * makes an automatic reconnect possible at all is that permission persists — a device the user
   * has already granted comes back from `getDevices()` with no prompt and no gesture.
   */
  const reconnectNow = useCallback(async () => {
    reconnectTimer.current = null;
    if (!wantConnected.current || deviceRef.current) return;
    const api = usbApi();
    if (!api) return;
    try {
      const known = await api.getDevices();
      const chosen = known.find((d) => d.vendorId === CFX_USB_FILTER.vendorId);
      if (!chosen) {
        // Still unplugged, or not yet re-enumerated. Not an error — wait and look again.
        scheduleReconnect.current();
        return;
      }
      await openDevice(chosen);
      reconnectAttempt.current = 0;
      setError(null);
      console.info("[useCfxDevice] reconnected");
    } catch (e) {
      // Expected while the instrument is still coming back — say so quietly and try again.
      console.warn("[useCfxDevice] reconnect attempt failed:", e);
      teardown("reconnecting");
      scheduleReconnect.current();
    }
  }, [openDevice, teardown]);

  useEffect(() => {
    scheduleReconnect.current = () => {
      if (!wantConnected.current || reconnectTimer.current !== null) return;
      const i = Math.min(reconnectAttempt.current, RECONNECT_DELAYS_MS.length - 1);
      reconnectAttempt.current++;
      reconnectTimer.current = setTimeout(() => void reconnectNow(), RECONNECT_DELAYS_MS[i]);
    };
  }, [reconnectNow]);

  // A replug fires `connect` on `navigator.usb`, which is worth listening for on its own: it turns
  // "wait out the rest of the backoff" into "reconnect the moment the cable is back".
  useEffect(() => {
    const api = usbApi();
    if (!api) return;
    const onUsbConnect = () => {
      if (!wantConnected.current || deviceRef.current) return;
      cancelReconnect();
      void reconnectNow();
    };
    api.addEventListener("connect", onUsbConnect);
    return () => api.removeEventListener("connect", onUsbConnect);
  }, [reconnectNow, cancelReconnect]);

  const connect = useCallback(async () => {
    const api = usbApi();
    if (!api) return;
    if (!usbWarningAcknowledged()) {
      const ok = window.confirm(
        "This software is unofficial and likely contains bugs. Are you sure you want to " +
          "connect to your instrument?",
      );
      if (!ok) return;
      ackUsbWarning();
    }
    setError(null);
    cancelReconnect();
    wantConnected.current = true;
    setConnection("connecting");
    try {
      // A device the user has already granted comes back from getDevices() without a second
      // prompt, so reconnecting after a reload is one click rather than a picker.
      const known = await api.getDevices();
      const chosen =
        known.find((d) => d.vendorId === CFX_USB_FILTER.vendorId) ??
        (await api.requestDevice({ filters: [CFX_USB_FILTER] }));
      await openDevice(chosen);
    } catch (e) {
      // requestDevice() rejects when the user dismisses the picker — not an error worth shouting.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no device selected/i.test(msg)) {
        console.error("[useCfxDevice] connect() failed:", e);
        setError(msg);
      }
      wantConnected.current = false;
      deviceRef.current = null;
      setConnection("disconnected");
    }
  }, [openDevice, cancelReconnect]);

  const disconnect = useCallback(async () => {
    // Clear the intent first: the `close()` below fires `onClose`, and this is what tells that
    // handler the drop was asked for rather than something to undo.
    wantConnected.current = false;
    cancelReconnect();
    const d = deviceRef.current;
    // No device but a live intent is the reconnecting state — Disconnect must still end it.
    if (!d) {
      teardown();
      return;
    }
    await d.close();
    teardown();
  }, [teardown, cancelReconnect]);

  // Status poll. Skipped while another operation holds the command channel — a `GETFILE` of a
  // plate read would otherwise queue several polls behind it and replay them all at once.
  useEffect(() => {
    if (connection !== "connected" || !polling) return;
    let cancelled = false;
    const tick = async () => {
      const d = deviceRef.current;
      if (!d || cancelled || busy) return;
      try {
        const s = await d.status();
        if (!cancelled) setStatus(s);
      } catch (e) {
        // A transient failure is not worth tearing the connection down over — the read pump
        // already retries and, if it can't recover, fires `onClose` on its own — but log it so a
        // string of these leading up to a disconnect shows up in the same console as the cause.
        console.warn("[useCfxDevice] status poll failed:", e);
      }
      if (cancelled || busy) return;
      try {
        const rt = await d.rtStatus();
        if (!cancelled) setRtStatus(rt);
      } catch (e) {
        console.warn("[useCfxDevice] rtStatus poll failed:", e);
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, polling, busy]);

  // Close the interface on unmount so a view switch doesn't leave it claimed. The intent flag goes
  // with it: a pending reconnect firing after unmount would re-claim the interface nobody is
  // watching any more.
  useEffect(() => {
    return () => {
      wantConnected.current = false;
      if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      void deviceRef.current?.close();
      deviceRef.current = null;
    };
  }, []);

  /** Run `fn` with the busy flag set, so the poll and the buttons stand back. */
  const withBusy = useCallback(async <T,>(what: string, fn: (d: CfxDevice) => Promise<T>) => {
    const d = deviceRef.current;
    if (!d) return undefined;
    setBusy(what);
    setError(null);
    try {
      return await fn(d);
    } catch (e) {
      console.error(`[useCfxDevice] ${what} failed:`, e);
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshDirectory = useCallback(
    async (path: string) => {
      const dir = await withBusy(`Listing ${path}`, (d) => d.listFiles(path));
      if (dir) setDirectories((prev) => ({ ...prev, [path]: dir }));
    },
    [withBusy],
  );

  const refreshAll = useCallback(async () => {
    for (const d of CFX_DIRECTORIES) await refreshDirectory(d.path);
  }, [refreshDirectory]);

  const fetchFile = useCallback(
    async (dir: string, name: string) =>
      withBusy(`Fetching ${name}`, (d) => d.getFile(`${dir}\\${name}`)),
    [withBusy],
  );

  /**
   * Pull every named file out of one directory, as `name → bytes`. Sequential by necessity: the
   * command channel carries one request at a time (see `CfxDevice.sequence`), and a `CurrentRun`
   * is ~40 files, so the busy label counts them off rather than sitting on one opaque message.
   *
   * A file that fails is dropped rather than failing the whole set: the caller (assembling a
   * `.zpcr`) validates what it got, and one unreadable marker file shouldn't cost a run its
   * plate reads.
   */
  const fetchDirectoryFiles = useCallback(
    async (path: string, names: string[]) =>
      withBusy(`Fetching ${names.length} files`, async (d) => {
        const files: Record<string, Uint8Array> = {};
        for (const [i, name] of names.entries()) {
          setBusy(`Fetching ${name} (${i + 1}/${names.length})`);
          try {
            files[name] = await d.getFile(`${path}\\${name}`);
          } catch {
            /* keep going; the caller reports what's missing */
          }
        }
        return files;
      }),
    [withBusy],
  );

  /**
   * Start the staged run: pre-flight, author the protocol, `RemoteRun`, deposit the files
   * (`usb.md` §7).
   *
   * Everything about *what* is sent was decided by `planRun` before this is called — see
   * `usb/runPlan.ts`. This adds only the three things a browser session owns: a progress label
   * while the sequence runs, a re-read of `STATUS?` afterwards, since a run that has just
   * started changes what the rail shows and waiting a poll period for it looks like a failure,
   * and {@link runPending}.
   *
   * `runPending` is set **synchronously**, before a single byte goes out: authoring the protocol
   * is dozens of round trips, so between the click and the first status there are seconds during
   * which the instrument still answers "idle" and the rail would otherwise look untouched — long
   * enough to invite a second click on a button that heats a block. Nothing is asked of the
   * instrument to know this; it is the local fact that a start has been requested, and it lasts
   * exactly until the instrument's own answer replaces it. That answer is the `STATUS?` below,
   * which is *whatever it says*: a successful start reports `running` and the rail moves on to
   * the real running state on its own, and a start that failed reports idle and releases the
   * button rather than leaving it stuck pending forever.
   *
   * Resolves with the deposit phase's outcome, or undefined if the start itself failed (the error
   * banner then carries the reason). Note that the block does *not* start heating immediately —
   * §7.3 measures ~3 minutes of lid heating first, during which nothing appears to happen.
   */
  const startRun = useCallback(
    async (plan: RunPlan) => {
      // Whatever the last action-button command reported (e.g. a stale "CANCEL → accepted") is
      // about to be answered by a new run's own status — starting one is exactly the moment that
      // readout stops being relevant, so it shouldn't linger through it.
      setLastAction(null);
      setRunPending(true);
      // The first thing a start does is empty `PCRunReport` (`usb.md` §7.1), so the report shown
      // as "the last run" is about to stop existing. Drop it here rather than leaving the panel
      // describing a file that has been deleted; the run being started writes the next one, and
      // `refreshLastReport` picks that up when it finishes.
      setLastReport(null);
      try {
        const result = await withBusy("Starting run", (d) =>
          d.startRun(plan, (what) => setBusy(what)),
        );
        const d = deviceRef.current;
        if (d) {
          try {
            setStatus(await d.status());
          } catch {
            /* the poll will catch up */
          }
        }
        return result;
      } finally {
        setRunPending(false);
      }
    },
    [withBusy],
  );

  /**
   * `CANCEL` a run the instrument has finished but is still holding (`usb.md` §7.6).
   *
   * Guarded on the status this is *only* correct for: a completed protocol leaves `STATUS?`
   * reporting `IDLE` with the run's name still attached, and acknowledging that releases the
   * instrument and makes the final plate read, the `ended` marker and the `.alf` report appear.
   * The same command sent to a run still cycling would abort it, which is why the check is here
   * rather than trusted to the caller.
   */
  const acknowledgeFinishedRun = useCallback(async () => {
    const current = statusRef.current;
    if (!current || current.running || !current.runName) return false;
    const res = await withBusy("Acknowledging the finished run", (d) => d.acknowledgeRun());
    if (res) {
      const d = deviceRef.current;
      try {
        if (d) setStatus(await d.status());
      } catch {
        /* the poll will catch up */
      }
    }
    return res !== undefined;
  }, [withBusy]);

  /**
   * Read whatever `\Storage Card\PCRunReport` is holding into {@link lastReport}.
   *
   * **Called automatically once per connection**, which is what makes the Instrument view able to
   * say what this machine last did the moment it is plugged in. The report is there for *every*
   * run — a qPCR one and a thermal-only one alike (`usb.md` §5.2) — so unlike `CurrentRun`, which
   * exists only for runs with a `PLATEREAD`, this one directory answers "what ran here last?"
   * whatever was run. It survives until something deletes it, and the thing that deletes it is a
   * new run's pre-flight (`CfxDevice.clearRunReports`, §7.1), so what is sitting there on connect
   * is the previous run's and nobody has seen it in this app before.
   *
   * Cheap enough to do unasked: the file is 386 bytes to ~14 KB (`alf.md` §1), and this is a
   * listing plus one `GETFILE`.
   *
   * Also called after a run finishes, where it picks up the report that run just wrote — so the
   * panel describes the run that has actually just happened rather than the one before it.
   */
  const refreshLastReport = useCallback(async () => {
    const got = await withBusy("Reading the last run report", (d) => d.runReport());
    // `undefined` is a failed read, which `withBusy` has already reported; leave the last answer
    // standing rather than claiming the instrument has no report. `null` is the instrument
    // genuinely holding none, which is a real answer and replaces whatever was there.
    if (got === undefined) return null;
    if (got === null) {
      setLastReport(null);
      return null;
    }
    let report: AlfReport | null = null;
    try {
      report = parseAlf(got.bytes);
    } catch (e) {
      // A report we can't decode is still a report the instrument is holding, and its bytes are
      // still worth offering — so keep it, undecoded, rather than dropping the fact of it.
      console.warn("[useCfxDevice] the instrument's run report did not decode:", e);
    }
    const held: LastRunReport = { name: got.name, bytes: got.bytes, report };
    setLastReport(held);
    return held;
  }, [withBusy]);

  // Read it once per connection. `refreshLastReport` is stable, so this fires on the transition
  // into `connected` and not again — a reconnect mid-run runs it afresh, which is right: the
  // directory may have changed while the pipe was down.
  useEffect(() => {
    if (connection !== "connected") return;
    void refreshLastReport();
  }, [connection, refreshLastReport]);

  /**
   * Collect the `.alf` report the run that just finished wrote — the whole output of a thermal-only
   * run, which builds no run folder at all (see `RunPlan.producesRunFile`), so this is what the
   * watcher fetches in place of a `.zpcr`.
   *
   * The same read as {@link refreshLastReport}, and deliberately *is* it rather than a second call
   * to `runReport`: there is one report directory, so anything fetched out of it is by definition
   * the instrument's current last report, and having the two share a read means the last-run panel
   * is right after this without a duplicate transfer. Returns null when the directory holds no
   * report, or when the read fails — a report that doesn't arrive is worth nothing more than a note
   * in the rail, since by then the run itself is over and nothing about it can be lost by this
   * failing.
   */
  const fetchRunReport = useCallback(async () => {
    const held = await refreshLastReport();
    return held ? { name: held.name, bytes: held.bytes } : null;
  }, [refreshLastReport]);

  /**
   * Stop the run in progress — `usb.md` §7.8, driven by `CfxDevice.cancelRun`.
   *
   * Everything about *how* to stop safely lives in core; this adds the two things a browser
   * session owns. First, `expectStart`: the app knows a run has been asked for
   * ({@link runPending}) seconds before `STATUS?` will admit it, and that window is exactly where
   * a plain `CANCEL` is accepted and ignored — so the local fact is what lets the cancel wait for
   * the run it is meant to stop. Second, `onStatus`: `withBusy` stands the status poll down for
   * the duration, and a cancel can legitimately take a while (a plate read in flight is allowed
   * to finish), so the rail would otherwise freeze on a stale reading through the one operation
   * the user is most anxious to watch.
   *
   * Deliberately stops at §7.6's finished state rather than driving all the way to the empty-name
   * idle: the acknowledgement is what makes the last read, `ended` and the `.alf` appear, and
   * `useRunWatch` already owns that so the partial run still gets collected and filed.
   */
  const cancelRun = useCallback(
    async (options: { force?: boolean } = {}) => {
      const wasPending = runPendingRef.current;
      const res = await withBusy("Stopping the run", (d) =>
        d.cancelRun({
          expectStart: wasPending || statusRef.current?.running === true,
          force: options.force,
          onStatus: (s) => setStatus(s),
        }),
      );
      return res;
    },
    [withBusy],
  );

  /** `PAUSE`/`RESUME` — suspend or continue the running protocol (`usb.md` §7.9). */
  const setRunPaused = useCallback(
    async (paused: boolean) => {
      const res = await withBusy(paused ? "Pausing the run" : "Resuming the run", (d) =>
        paused ? d.pauseRun() : d.resumeRun(),
      );
      if (res) {
        // The pause bit is the whole feedback this has; don't make the user wait a poll for it.
        const d = deviceRef.current;
        try {
          if (d) setStatus(await d.status());
        } catch {
          /* the poll will catch up */
        }
      }
      return res;
    },
    [withBusy],
  );

  /**
   * Re-list `\Storage Card\CurrentRun` and report what it holds.
   *
   * Separate from {@link refreshDirectory} because this one is *polled* — it is how the app
   * notices a new plate read — so it keeps its own state rather than sharing the file browser's
   * map, and it decodes the `begun`/`ended` markers into a {@link RunProgress} on the way past.
   */
  const refreshRunFolder = useCallback(async () => {
    const dir = await withBusy("Checking the run", (d) => d.listFiles(CFX_CURRENT_RUN_DIR));
    if (dir) {
      setRunFolder(dir);
      setDirectories((prev) => ({ ...prev, [CFX_CURRENT_RUN_DIR]: dir }));
    }
    return dir;
  }, [withBusy]);

  const runAction = useCallback(
    async (name: CfxCommandName, spec: { label: string; command: string }) => {
      const res = await withBusy(spec.label, (d) => d.runAction(name));
      if (res) {
        setLastAction({ label: spec.label, command: spec.command, ok: res.ok, code: res.code, raw: res.raw, at: Date.now() });
        // An action that moves the lid changes what STATUS? reports; don't wait for the poll.
        const d = deviceRef.current;
        if (d) {
          try {
            setStatus(await d.status());
          } catch {
            /* the poll will catch up */
          }
        }
      }
      return res;
    },
    [withBusy],
  );

  /** Clear the console. The *view* only: a running recording keeps every line it has taken, since
   * clearing the screen to watch the next exchange is not a request to throw away the transcript
   * being kept for the run's `.zpcr`. */
  const clearTraffic = useCallback(() => {
    rebuildFrom.current = [];
    setTraffic([]);
  }, []);

  /**
   * Choose whether a finished run's `.zpcr` carries the recorded log.
   *
   * Recording itself is not a choice — it always happens, so the console's download button always
   * has a complete session behind it and a problem noticed after the fact is still recoverable.
   * What this decides is the copy that *persists*: the entry attached to the run's file, which
   * outlives the session and takes up disk wherever that file goes.
   *
   * Off by default, and read at the moment the log is attached rather than while recording, so
   * switching it on part-way through a run still saves the whole run — including everything that
   * happened before the switch was touched. Switching it off before the run ends leaves the file
   * without the entry entirely; nothing is half-saved.
   */
  const setSaveLog = useCallback((on: boolean) => {
    saveLogRef.current = on;
    setSaveLogState(on);
  }, []);

  /**
   * The log to attach to a run's `.zpcr`, or null for "attach nothing" — the one place both
   * conditions are decided, so the run watcher doesn't have to know either of them.
   *
   * Null when {@link setSaveLog} is off, and null for an empty recording: a session that saw no
   * traffic (the run was watched but the instrument was driven by someone else, say) is worth no
   * entry rather than an 8-byte header nobody can learn anything from.
   */
  const trafficLogForRun = useCallback(
    () => (saveLogRef.current && !recorder.current.isEmpty ? recorder.current.bytes() : null),
    [],
  );

  /** The whole session's log as text, for the console's download button — always available, since
   * recording is unconditional. */
  const trafficLogText = useCallback(
    () => formatUsbTrafficBytes(recorder.current.bytes()),
    [],
  );

  /**
   * Turn poll suppression on or off, and rebuild the console's display list from
   * {@link rebuildFrom} to match.
   *
   * The rebuild is what makes hiding at capture time safe: lines suppressed while the flag was on
   * were never in {@link traffic}, so un-hiding has to go back to a record that kept them,
   * honouring the last {@link clearTraffic} (which empties that record) and the same display cap a
   * live push would have applied. Rebuilding in both directions rather than only when un-hiding
   * keeps the result a pure function of the flag — turning it on drops the polls already on
   * screen, which is what "hide polling" is asked for in the first place.
   */
  const setHidePolls = useCallback((hide: boolean) => {
    hidePollsRef.current = hide;
    setHidePollsState(hide);
    const shown = rebuildFrom.current.filter((line) => !(hide && line.poll));
    setTraffic(shown.length > TRAFFIC_LIMIT ? shown.slice(shown.length - TRAFFIC_LIMIT) : shown);
  }, []);

  /** What the last `CurrentRun` listing says about the run's progress — derived, never stored
   * (see `runProgressFromNames`). Null until the folder has been listed at least once. */
  const runProgress: RunProgress | null = useMemo(
    () => (runFolder?.listed ? runProgressFromNames(runFolder.names) : null),
    [runFolder],
  );

  /** Block temperature against run time, buffered from the same polls — session-scoped for the
   * reason in the module comment, so the chart the Instrument view draws covers the run and not
   * the time since the view was last opened. */
  const liveThermal = useLiveThermalHistory(status);

  return {
    liveThermal,
    connection,
    error,
    info,
    status,
    rtStatus,
    traffic,
    hasTraffic,
    saveLog,
    setSaveLog,
    trafficLogForRun,
    trafficLogText,
    hidePolls,
    setHidePolls,
    directories,
    busy,
    lastAction,
    polling,
    runPending,
    setPolling,
    connect,
    disconnect,
    refreshDirectory,
    refreshAll,
    fetchFile,
    fetchDirectoryFiles,
    runAction,
    clearTraffic,
    startRun,
    cancelRun,
    setRunPaused,
    acknowledgeFinishedRun,
    fetchRunReport,
    lastReport,
    refreshLastReport,
    refreshRunFolder,
    runFolder,
    runProgress,
  };
}

export type CfxDeviceHandle = ReturnType<typeof useCfxDevice>;
