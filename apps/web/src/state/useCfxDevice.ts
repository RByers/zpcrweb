/**
 * Connection state for a CFX96 attached over WebUSB.
 *
 * All the protocol lives in `@zpcrweb/core`'s `CfxDevice` (see `packages/core/src/usb/`), per the
 * app's standing rule that logic belongs in the library — this hook owns only what a *browser
 * session* adds on top: obtaining the device through `navigator.usb`, a poll timer, a bounded
 * traffic log for the debug console, and the React state the view renders.
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
  type CfxStatus,
  type CfxTrafficEvent,
  type RunPlan,
  type RunProgress,
  type UsbDeviceLike,
} from "@zpcrweb/core";

/** How many messages the debug console keeps. A 1.5 s poll writes six lines a minute; this is
 * roughly an hour of idle polling, and bounds memory on a session left open overnight. */
const TRAFFIC_LIMIT = 400;
/** Status poll period. CFX Manager polls about once a second; this is deliberately slower, since
 * nothing here needs sub-second latency and every poll is three lines of console noise. */
const POLL_MS = 1500;

export type ConnectionState = "unsupported" | "disconnected" | "connecting" | "connected";

/** One line in the debug console — a decoded message, pre-formatted for display. */
export interface TrafficLine {
  id: number;
  at: number;
  direction: "out" | "in";
  channel: number;
  unsolicited: boolean;
  /** The payload as text, or `null` when it is binary and must be shown as {@link hex}. */
  text: string | null;
  hex: string;
  bytes: number;
}

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
  // Every message this session has seen, uncapped — unlike `traffic` (bounded to TRAFFIC_LIMIT
  // for the on-screen console) and unaffected by `clearTraffic` (which only resets the view).
  // This is what backs the console's "download log" button and what gets embedded in a run's
  // `.zpcr` when it finishes — both want the complete record, not the display window.
  const fullTraffic = useRef<TrafficLine[]>([]);

  const [connection, setConnection] = useState<ConnectionState>(() =>
    usbApi() ? "disconnected" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<CfxDeviceInfo | null>(null);
  const [status, setStatus] = useState<CfxStatus | null>(null);
  const [traffic, setTraffic] = useState<TrafficLine[]>([]);
  const [directories, setDirectories] = useState<Record<string, CfxDirectory>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<ActionResult | null>(null);
  const [polling, setPolling] = useState(true);
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

  const onTraffic = useCallback((e: CfxTrafficEvent) => {
    const line: TrafficLine = {
      id: trafficId.current++,
      at: e.at,
      direction: e.direction,
      channel: e.channel,
      unsolicited: e.unsolicited,
      text: e.text === null ? null : e.text.replace(/\r?\n$/, ""),
      hex: toHex(e.payload),
      bytes: e.payload.length,
    };
    fullTraffic.current.push(line);
    setTraffic((prev) => {
      const next = prev.length >= TRAFFIC_LIMIT ? prev.slice(prev.length - TRAFFIC_LIMIT + 1) : prev;
      return [...next, line];
    });
  }, []);

  // Deliberately does not touch `traffic`: the console is the one place a disconnect's cause is
  // visible after the fact (what was in flight, what the last messages before the failure were),
  // so wiping it on the same event that most needs debugging would defeat the point.
  const teardown = useCallback(() => {
    deviceRef.current = null;
    setConnection("disconnected");
    setInfo(null);
    setStatus(null);
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
  }, [onTraffic, teardown]);

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

  const clearTraffic = useCallback(() => setTraffic([]), []);

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
    traffic,
    fullTraffic,
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
    acknowledgeFinishedRun,
    refreshRunFolder,
    runFolder,
    runProgress,
  };
}

export type CfxDeviceHandle = ReturnType<typeof useCfxDevice>;
