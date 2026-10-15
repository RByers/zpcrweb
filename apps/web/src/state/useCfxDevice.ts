/**
 * The React shell around core's {@link CfxSession} — a CFX96 attached over WebUSB.
 *
 * Everything that is a *decision* now lives in the library (`packages/core/src/usb/session.ts`):
 * the status poll and its busy gate, the reconnect backoff, the traffic recording and the display
 * window, and the accumulated view of the instrument. It is driven in `vitest` against the
 * emulator, with no browser anywhere.
 *
 * What is left here is exactly what only a browser can do, and it is deliberately not in core:
 *
 * - **finding a device** — `navigator.usb`, its picker, and the `connect` event a replug fires;
 * - **the unofficial-software warning** and the `localStorage` acknowledgement that shows it once
 *   per browser rather than once per session;
 * - **remembering the "save log" switch** across page loads, which is a `localStorage` fact and
 *   was the reason a tab reloaded mid-run came back with the switch silently off;
 * - **{@link runPending}**, which exists to change a button the instant it is clicked — seconds
 *   before `STATUS?` will admit a run has started — and is React state by nature;
 * - mirroring the session's state into renders, through `useSyncExternalStore`.
 *
 * The session itself lives in a ref rather than in state. It owns a long-lived read loop and a
 * timer; putting it in `useState` would invite a re-render to be interpreted as a new connection,
 * and re-running `open()` on a claimed interface fails.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  CFX_USB_FILTER,
  CfxSession,
  type CfxCommandName,
  type RunPlan,
  type UsbDeviceLike,
} from "@zpcrweb/core";
import { useLiveThermalHistory } from "./useLiveThermalHistory";
import { acquireMockDevice } from "./mockInstrument";

export type {
  ActionResult,
  ConsoleLine,
  LastRunReport,
  TrafficLine,
  TransferErrorLine,
} from "@zpcrweb/core";

/** The session's four states, plus the one only the browser knows about. */
export type ConnectionState = "unsupported" | "disconnected" | "connecting" | "connected" | "reconnecting";

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

/** Set once the user has clicked through {@link useCfxDevice.connect}'s unofficial-software
 * warning — read before every connect attempt so the prompt shows exactly once per browser, not
 * once per session. */
const USB_WARNING_ACK_KEY = "zpcr:usbWarningAck";
/**
 * Whether a finished run's `.zpcr` carries the session's USB traffic log.
 *
 * Persisted, and that is a fix rather than a nicety: the switch used to be page-session state, so
 * a tab reloaded during a run — which is hours long — came back with it silently off, and the run
 * that finished afterwards was filed without the log its owner had asked for.
 */
const SAVE_LOG_KEY = "zpcr:usbSaveLog";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

export function useCfxDevice() {
  /**
   * Whether the session reaches the simulated instrument (`state/mockInstrument.ts`) rather than a
   * real one — set by whichever of {@link connect} / {@link connectFake} was clicked last, and the
   * *only* thing that differs below: the emulator satisfies the same `UsbDeviceLike` a real device
   * does, so it goes in through the session's one `acquire` port and everything past it — the
   * protocol client, the poll, the follower, the view — is unchanged. Mirrored into a ref because
   * `acquire` is bound once, and an automatic reconnect must reach the same kind of instrument.
   */
  const [mock, setMock] = useState(false);
  const mockRef = useRef(false);
  const chooseMock = useCallback((on: boolean) => {
    mockRef.current = on;
    setMock(on);
  }, []);
  /**
   * Whether the rail offers **Fake device** — from the start in a browser with no WebUSB, since
   * there is no real connect to try, and otherwise once one has been tried and didn't connect.
   * Never before: someone with an instrument on the bench shouldn't be offered a pretend one
   * beside it.
   */
  const [fakeOffered, setFakeOffered] = useState(() => usbApi() === null);
  const hasUsb = useMemo(() => usbApi() !== null, []);
  const sessionRef = useRef<CfxSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new CfxSession({
      saveLog: readFlag(SAVE_LOG_KEY),
      /**
       * The one browser-only step. A device the user has already granted comes back from
       * `getDevices()` without a second prompt, so reconnecting after a reload is one click rather
       * than a picker — and an automatic reconnect is possible at all only because of that: a
       * picker needs a user gesture and would throw in the reconnect path.
       *
       * Null is "none available", which the session treats as a wait-and-retry on a reconnect and
       * as a quiet no-op on a connect — including when `requestDevice()` rejects because the user
       * dismissed the picker, which is not an error worth shouting.
       */
      acquire: async (reason) => {
        // The simulated instrument's whole reach into the app: one port, answered with an
        // emulated instrument instead of a found one. It is kept across disconnects, so a
        // reconnect gets the same instrument back — still running, if it was.
        if (mockRef.current) return acquireMockDevice();
        const api = usbApi();
        if (!api) return null;
        const known = await api.getDevices();
        const chosen = known.find((d) => d.vendorId === CFX_USB_FILTER.vendorId);
        if (chosen || reason === "reconnect") return chosen ?? null;
        try {
          return await api.requestDevice({ filters: [CFX_USB_FILTER] });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/no device selected/i.test(msg)) return null;
          throw e;
        }
      },
    });
  }
  const session = sessionRef.current;
  const state = useSyncExternalStore(
    useCallback((fn) => session.subscribe(fn), [session]),
    () => session.state,
  );

  /**
   * Set the instant Start run is clicked, cleared when the start sequence has run and the session
   * has re-read `STATUS?`.
   *
   * Set **synchronously**, before a single byte goes out: authoring the protocol is dozens of
   * round trips, so between the click and the first status there are seconds during which the
   * instrument still answers "idle" and the rail would otherwise look untouched — long enough to
   * invite a second click on a button that heats a block. Nothing is asked of the instrument to
   * know this; it is the local fact that a start has been requested, and it lasts exactly until
   * the instrument's own answer replaces it. That answer is *whatever it says*: a successful start
   * reports `running` and the rail moves on to the real running state on its own, and a start that
   * failed reports idle and releases the button rather than leaving it stuck pending forever.
   */
  const [runPending, setRunPending] = useState(false);
  const runPendingRef = useRef(false);
  runPendingRef.current = runPending;

  // A replug fires `connect` on `navigator.usb`, which is worth listening for on its own: it turns
  // "wait out the rest of the backoff" into "reconnect the moment the cable is back".
  useEffect(() => {
    const api = usbApi();
    if (!api) return;
    const onUsbConnect = () => {
      session.cancelReconnect();
      void session.reconnectNow();
    };
    api.addEventListener("connect", onUsbConnect);
    return () => api.removeEventListener("connect", onUsbConnect);
  }, [session]);

  // Close the interface on unmount so a view switch doesn't leave it claimed.
  useEffect(() => () => void session.dispose(), [session]);

  /** Connect to a real instrument over WebUSB. One that doesn't end up connected — the picker
   * dismissed, nothing plugged in, or an error opening it — offers {@link connectFake}. */
  const connect = useCallback(async () => {
    if (!usbApi()) return;
    chooseMock(false);
    if (!readFlag(USB_WARNING_ACK_KEY)) {
      const ok = window.confirm(
        "This software is unofficial and likely contains bugs. Are you sure you want to " +
          "connect to your instrument?",
      );
      if (!ok) return;
      writeFlag(USB_WARNING_ACK_KEY, true);
    }
    await session.connect();
    if (session.state.connection !== "connected") setFakeOffered(true);
  }, [session, chooseMock]);

  /**
   * Connect to the simulated instrument instead. No unofficial-software warning: it has nothing at
   * stake — no block to heat, no plate to consume — so the warning would be asking about a machine
   * that isn't there.
   */
  const connectFake = useCallback(async () => {
    chooseMock(true);
    await session.connect();
  }, [session, chooseMock]);

  const setSaveLog = useCallback(
    (on: boolean) => {
      writeFlag(SAVE_LOG_KEY, on);
      session.setSaveLog(on);
    },
    [session],
  );

  /**
   * Start the staged run. Everything about *what* is sent was decided by `planRun`; everything
   * about how the session behaves while it happens is core's. This adds {@link runPending} and
   * nothing else.
   */
  const startRun = useCallback(
    async (plan: RunPlan) => {
      setRunPending(true);
      try {
        return await session.startRun(plan);
      } finally {
        setRunPending(false);
      }
    },
    [session],
  );

  /** Stop the run in progress. `expectStart` is the local fact the instrument can't supply: the
   * app knows a run has been asked for seconds before `STATUS?` will admit it, and that window is
   * exactly where a plain `CANCEL` is accepted and ignored (`usb.md` §7.8). */
  const cancelRun = useCallback(
    async () => session.cancelRun({ expectStart: runPendingRef.current }),
    [session],
  );

  // Bound once: these are the session's own methods, and a component that depends on their
  // identity must not re-render because the hook did.
  const ops = useMemo(
    () => ({
      disconnect: () => session.disconnect(),
      setPolling: (on: boolean) => session.setPolling(on),
      setHidePolls: (hide: boolean) => session.setHidePolls(hide),
      clearTraffic: () => session.clearTraffic(),
      trafficLogForRun: () => session.trafficLogForRun(),
      trafficLogBytes: () => session.trafficLogBytes(),
      refreshDirectory: (path: string) => session.refreshDirectory(path),
      refreshAll: () => session.refreshAll(),
      fetchFile: (dir: string, name: string) => session.fetchFile(dir, name),
      fetchDirectoryFiles: (path: string, names: string[]) => session.fetchDirectoryFiles(path, names),
      runAction: (name: CfxCommandName, spec: { label: string; command: string }) =>
        session.runAction(name, spec),
      setRunPaused: (paused: boolean) => session.setRunPaused(paused),
      acknowledgeFinishedRun: () => session.acknowledgeFinishedRun(),
      fetchRunReport: () => session.fetchRunReport(),
      refreshLastReport: () => session.refreshLastReport(),
      refreshRunFolder: () => session.refreshRunFolder(),
    }),
    [session],
  );

  /** Block temperature against run time, buffered from the same polls — session-scoped rather
   * than owned by the view, so the chart the Instrument view draws covers the run and not the time
   * since the view was last opened. The block-temperature chart used to buffer inside the
   * Instrument rail and so restarted empty every time the view was left, which is precisely the
   * thing a live chart must not do. */
  const liveThermal = useLiveThermalHistory(state.status);

  return {
    ...state,
    // A simulated instrument needs no WebUSB at all, so while one is connected even a browser
    // without it has a connection to show; disconnected, it is back to having nothing real to try.
    connection:
      hasUsb || (mock && state.connection !== "disconnected")
        ? state.connection
        : ("unsupported" as ConnectionState),
    /** True when what this is connected to is simulated — the rail says so, and offers the one
     * control a real instrument has no equivalent of (how fast time runs). */
    mock,
    /** Whether the rail shows **Fake device** beside the real connect. */
    fakeOffered,
    ...ops,
    liveThermal,
    session,
    runPending,
    connect,
    connectFake,
    setSaveLog,
    startRun,
    cancelRun,
  };
}

export type CfxDeviceHandle = ReturnType<typeof useCfxDevice>;
