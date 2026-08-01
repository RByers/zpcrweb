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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CFX_DIRECTORIES,
  CFX_USB_FILTER,
  CfxDevice,
  type CfxCommandName,
  type CfxDeviceInfo,
  type CfxDirectory,
  type CfxStatus,
  type CfxTrafficEvent,
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

  const onTraffic = useCallback((e: CfxTrafficEvent) => {
    setTraffic((prev) => {
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
      const next = prev.length >= TRAFFIC_LIMIT ? prev.slice(prev.length - TRAFFIC_LIMIT + 1) : prev;
      return [...next, line];
    });
  }, []);

  const teardown = useCallback(() => {
    deviceRef.current = null;
    setConnection("disconnected");
    setInfo(null);
    setStatus(null);
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
          if (err) setError(err.message);
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
      if (!/no device selected/i.test(msg)) setError(msg);
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
      } catch {
        /* a transient failure is not worth tearing the connection down over */
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

  return {
    connection,
    error,
    info,
    status,
    traffic,
    directories,
    busy,
    lastAction,
    polling,
    setPolling,
    connect,
    disconnect,
    refreshDirectory,
    refreshAll,
    fetchFile,
    fetchDirectoryFiles,
    runAction,
    clearTraffic,
  };
}

export type CfxDeviceHandle = ReturnType<typeof useCfxDevice>;
