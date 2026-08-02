/**
 * Connection state for a CFX96 attached over WebUSB.
 *
 * All the protocol lives in `@zpcrweb/core`'s `CfxDevice` (see `packages/core/src/usb/`), per the
 * app's standing rule that logic belongs in the library — this hook owns only what a *browser
 * session* adds on top: obtaining the device through `navigator.usb`, a poll timer, a bounded
 * traffic log for the debug console, and the React state the view renders.
 *
 * The traffic log is kept in two forms, and the difference matters: `recordedTraffic` is an
 * uncapped ref holding every line captured *while recording is on*, and is what gets downloaded or
 * embedded in a run's `.zpcr`; `traffic` is the display window — capped, cleared by
 * `clearTraffic`, and with poll chatter withheld while `hidePolls` is set, so an idle instrument
 * produces no React updates at all (see {@link pushLine}).
 *
 * Recording is **off by default** (see {@link useCfxDevice.setRecording}): watching the console is
 * the common case, keeping a complete uncapped transcript of a multi-hour session is not.
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
  CFX_DIRECTORIES,
  CFX_USB_FILTER,
  CfxDevice,
  runProgressFromNames,
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

export type ConnectionState = "unsupported" | "disconnected" | "connecting" | "connected";

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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** WebUSB is Chromium-only and needs a secure context; `navigator.usb` is simply absent
 * otherwise, which is what the view checks to explain itself rather than offering a dead button. */
function usbApi(): { requestDevice(o: unknown): Promise<UsbDeviceLike>; getDevices(): Promise<UsbDeviceLike[]> } | null {
  const nav = navigator as unknown as { usb?: ReturnType<typeof usbApi> };
  return nav.usb ?? null;
}

export function useCfxDevice() {
  const deviceRef = useRef<CfxDevice | null>(null);
  const trafficId = useRef(0);
  // Every message and transfer error captured while recording was on, uncapped — unlike `traffic`
  // (bounded to TRAFFIC_LIMIT for the on-screen console) and unaffected by `clearTraffic` (which
  // only resets the view). This is what backs the console's "download log" button and what gets
  // embedded in a run's `.zpcr` when it finishes — both want the complete record, not the display
  // window. Empty unless `recording` has been switched on, which it isn't by default.
  const recordedTraffic = useRef<ConsoleLine[]>([]);
  // Whether the last outbound *message* was a poll query, which is how an inbound reply is
  // classified: it carries no copy of the request it answers.
  const lastOutWasPoll = useRef(false);
  // The lines `setHidePolls` rebuilds the display from, capped at REBUILD_LIMIT and reset by
  // `clearTraffic` — so a rebuild honours the last clear without tracking an offset into anything.
  // Separate from `recordedTraffic` because un-hiding polls has to work on a session nobody is
  // recording, which is every session by default.
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
  /** Whether arriving lines are appended to {@link recordedTraffic}. Off by default — see
   * {@link setRecording}. */
  const [recording, setRecordingState] = useState(false);
  // Read by `pushLine` for the same reason as `hidePollsRef`: it is a stable callback wired into
  // the device, so it can't close over the state.
  const recordingRef = useRef(false);
  /** True once any line has been *recorded*. A plain boolean rather than a count so it re-renders
   * exactly once per recording — the console's download button needs to know the log is non-empty,
   * and `recordedTraffic` is a ref that can't announce itself. */
  const [hasRecording, setHasRecording] = useState(false);
  /**
   * Set the instant Start run is clicked, cleared by the first `STATUS?` that comes back after the
   * start sequence has run — see {@link useCfxDevice.startRun}.
   */
  const [runPending, setRunPending] = useState(false);
  /** The last listing of `CurrentRun`, which is what the run watcher works from. */
  const [runFolder, setRunFolder] = useState<CfxDirectory | null>(null);
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
   * Append one console line to the recording (when one is running) and the rebuild buffer, and —
   * unless it's poll traffic being hidden — to the display-capped state. The one place any of them
   * is written, so a message and a transfer error interleave in the single arrival order they
   * actually happened in.
   *
   * The `hidePolls` check is **here**, not in the console's render, and that placement is the
   * whole point of the flag. Filtering at render time still put every poll line into React state,
   * so a 1.5 s poll re-rendered the panel and re-ran its follow-scroll six times a minute for
   * lines that were then thrown away — visible as a flash on an otherwise idle console. Hidden
   * polls now cause no state update at all, while a running recording still takes them, so the
   * downloaded log and the copy embedded in a run's `.zpcr` remain complete either way.
   */
  const pushLine = useCallback((line: ConsoleLine) => {
    if (recordingRef.current) {
      recordedTraffic.current.push(line);
      setHasRecording(true);
    }
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
      const text = e.text === null ? null : e.text.replace(/\r?\n$/, "");
      pushLine({
        kind: "message",
        id: trafficId.current++,
        at: e.at,
        direction: e.direction,
        channel: e.channel,
        unsolicited: e.unsolicited,
        text,
        hex: toHex(e.payload),
        bytes: e.payload.length,
        poll: classifyPoll(e.direction, text),
      });
    },
    [pushLine, classifyPoll],
  );

  const onTransferError = useCallback(
    (e: CfxTransferErrorEvent) => {
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
  const teardown = useCallback(() => {
    deviceRef.current = null;
    // No request is outstanding across a disconnect, so the next reply must not be classified by
    // whatever the last session happened to have sent.
    lastOutWasPoll.current = false;
    setConnection("disconnected");
    setInfo(null);
    setStatus(null);
    setRtStatus(null);
    setRunPending(false);
    setDirectories({});
    setBusy(null);
  }, []);

  const connect = useCallback(async () => {
    const api = usbApi();
    if (!api) return;
    setError(null);
    setConnection("connecting");
    try {
      // A device the user has already granted comes back from getDevices() without a second
      // prompt, so reconnecting after a reload is one click rather than a picker.
      const known = await api.getDevices();
      const chosen =
        known.find((d) => d.vendorId === CFX_USB_FILTER.vendorId) ??
        (await api.requestDevice({ filters: [CFX_USB_FILTER] }));
      const device = new CfxDevice(chosen, {
        onTraffic,
        onTransferError,
        onClose: (err) => {
          if (err) {
            // The library already logs the retries and the final failure; this adds the one
            // thing it can't know — that the UI is about to drop the connection because of it —
            // so the console shows cause and effect together rather than an isolated stack trace.
            console.error("[useCfxDevice] device closed unexpectedly, tearing down:", err);
            setError(err.message);
          }
          teardown();
        },
      });
      await device.open();
      deviceRef.current = device;
      setConnection("connected");
      setInfo(await device.deviceInfo());
      setStatus(await device.status());
      try {
        setRtStatus(await device.rtStatus());
      } catch {
        /* the poll will catch up */
      }
    } catch (e) {
      // requestDevice() rejects when the user dismisses the picker — not an error worth shouting.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no device selected/i.test(msg)) {
        console.error("[useCfxDevice] connect() failed:", e);
        setError(msg);
      }
      deviceRef.current = null;
      setConnection("disconnected");
    }
  }, [onTraffic, onTransferError, teardown]);

  const disconnect = useCallback(async () => {
    const d = deviceRef.current;
    if (!d) return;
    await d.close();
    teardown();
  }, [teardown]);

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

  // Close the interface on unmount so a view switch doesn't leave it claimed.
  useEffect(() => {
    return () => {
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
   * Start or stop recording — nothing more than whether arriving lines are appended to
   * {@link recordedTraffic}.
   *
   * Off by default. The console is the everyday use of this panel and it costs nothing to leave
   * open; keeping an uncapped transcript of every message of a multi-hour run is a thing to ask
   * for. Turning it on mid-run is therefore normal, and is why this only gates the append: the
   * lines already recorded stay, so stopping and restarting resumes the same log rather than
   * discarding it. What was on screen while recording was off is *not* backfilled — the recording
   * is what was captured, and a log with a silent gap in the middle would be worse than one that
   * plainly starts where it started.
   *
   * A run's `.zpcr` embeds the log only when the buffer is non-empty (see `useRunWatch`'s `pull`),
   * so a never-recorded session simply carries no `usb-traffic.log` entry.
   */
  const setRecording = useCallback((on: boolean) => {
    recordingRef.current = on;
    setRecordingState(on);
  }, []);

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

  return {
    connection,
    error,
    info,
    status,
    rtStatus,
    traffic,
    recordedTraffic,
    hasRecording,
    recording,
    setRecording,
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
    refreshRunFolder,
    runFolder,
    runProgress,
  };
}

export type CfxDeviceHandle = ReturnType<typeof useCfxDevice>;
