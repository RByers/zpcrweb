/**
 * The mock instrument — a simulated CFX96 the app can connect to with no hardware present.
 *
 * Reached from the Instrument view's **Fake device** button, which the rail offers once a real
 * connect has failed — no instrument plugged in, the picker dismissed, or no WebUSB at all
 * (`useCfxDevice.ts`'s `connectFake`). Nothing about it is in the URL: which instrument a
 * connection reaches is decided by which button was clicked, not by how the page was opened.
 *
 * Simulated time starts at 1× (an instrument's own pace) and is switchable from the rail —
 * 10× / 60× scaled, or `Max`, which has no timers at all and advances the run a step per status
 * poll.
 *
 * Everything simulated is loaded **lazily**: `@zpcrweb/core/emulator` is a whole imitation
 * instrument on its own entry point, reached through `import()` from {@link acquireMockDevice}
 * and from nowhere else, so a session that never clicks Fake device never downloads it.
 *
 * ## One instrument per page, not one per connection
 *
 * The emulator is built once and kept ({@link instrument}). Disconnecting is unplugging a cable,
 * not switching the machine off: a run goes on running, and connecting again finds it mid-run —
 * which is the case the app most needs to get right and the one nothing could exercise before.
 * A page *reload*, though, takes the emulated instrument with it: it lives in this tab, so there
 * is no instrument left to reconnect to.
 */
import { unzipArchive, type UsbDeviceLike } from "@zpcrweb/core";
import type { EmulatorClock } from "@zpcrweb/core/emulator";
import { useSyncExternalStore } from "react";
import { sampleUrl } from "../lib/samples";

/** How fast simulated time runs: a multiple of wall time, or `"max"` — see the module comment. */
export type MockSpeed = number | "max";

/** The speeds the rail offers. `1` is an instrument's own pace; `"max"` has no clock at all. */
export const MOCK_SPEEDS: readonly MockSpeed[] = [1, 10, 60, "max"];

/** How a speed is written, in the rail and in the URL. */
export function mockSpeedLabel(speed: MockSpeed): string {
  return speed === "max" ? "Max" : `${speed}×`;
}

/**
 * The run the emulated instrument's fluorescence is lifted from.
 *
 * A bundled sample rather than anything synthetic: a plate read is a real read of a real plate,
 * re-headed with this run's cycle and temperatures, so what the Curves view draws is data an
 * instrument once produced (see core's emulator data source).
 */
const RECORDING = "20260807-YouSeq_RT_-_S56.zpcr";

/**
 * What the simulated instrument's `Real-Time Data` holds on connect: completed runs to browse and
 * open, since the emulator never writes there itself. These three are runs this project's own
 * instrument made in July 2026 — the same span `Real-Time Data` was found holding — and every one
 * is over 64 KB, so opening one exercises a download that arrives in several messages.
 *
 * Only the `.zpcr` of each: the real directory pairs every run with a `<run>.txt` too, but what
 * that file holds has never been read, and a made-up one would be the mock inventing a format.
 */
const COMPLETED_RUNS = [
  "20260720_FirstQualification.zpcr",
  "20260725_GRADIENTTEST.zpcr",
  "20260726_S183-S185_RVP.zpcr",
];

const REAL_TIME_DATA_DIR = "\\Storage Card\\Real-Time Data";

/** How fast simulated time runs, kept across connects — the rail's speed control sets it. */
let speed: MockSpeed = 1;

const listeners = new Set<() => void>();

/** The live clock, once an instrument has been built — what a speed change reaches. */
let clock: SwitchableClock | null = null;

function setSpeed(next: MockSpeed): void {
  speed = next;
  clock?.setSpeed(next);
  listeners.forEach((l) => l());
}

/** React hook: `[speed, setSpeed]` for the rail's segmented control. Takes effect immediately,
 * mid-run, without rebuilding anything — see {@link switchableClock}. */
export function useMockSpeed(): [MockSpeed, (next: MockSpeed) => void] {
  const current = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => speed,
    () => speed,
  );
  return [current, setSpeed];
}

interface SwitchableClock extends EmulatorClock {
  setSpeed(next: MockSpeed): void;
}

/**
 * One clock that covers both of core's, so changing speed never rebuilds the instrument.
 *
 * Core offers a scaled wall clock and a timer-free accelerated one, and `Max` is a move between
 * them rather than another multiplier — but swapping the clock under a running emulator would
 * mean a new emulator, and a new emulator has no run in it. So this is both, and switching
 * **rebases**: the time already simulated stays exactly where it is and only the rate from this
 * moment on differs.
 *
 * That is the invariant core's own clocks keep and the reason this one is written out rather than
 * composed: simulated time must never jump in either direction. Everything above the wire — the
 * run's elapsed seconds, the live thermal chart, the follower's edge detection — is a difference
 * between successive `STATUS?` replies, so time that moves backwards (or leaps forward) is an
 * instrument that cannot exist, and a bug found against it isn't real.
 */
function switchableClock(initial: MockSpeed): SwitchableClock {
  let rate = initial;
  /** Simulated ms already accrued, at `wallAt`. */
  let accrued = 0;
  let wallAt = Date.now();
  const now = () => (rate === "max" ? accrued : accrued + (Date.now() - wallAt) * rate);
  return {
    now,
    poll(nextEventAtMs) {
      // Only `Max` moves on a poll: it has no wall clock, so the host asking what is happening is
      // what makes the next thing happen. A scaled clock ignores this entirely.
      if (rate !== "max") return;
      accrued = nextEventAtMs === null ? accrued + IDLE_TICK_MS : Math.max(accrued, nextEventAtMs);
    },
    setSpeed(next) {
      accrued = now(); // Rebase before the rate changes — see above.
      wallAt = Date.now();
      rate = next;
    },
  };
}

/** How far an idle `Max` clock creeps per poll, so an idle instrument's clock isn't frozen
 * solid. Nothing depends on it; it matches core's accelerated clock. */
const IDLE_TICK_MS = 1000;

/** The one emulated instrument this page has, built on first connect and kept afterwards. */
let instrument: Promise<UsbDeviceLike> | null = null;

/**
 * The emulated CFX96, as the session's `acquire` port wants it — a `UsbDeviceLike`, which is
 * every bit of what `CfxDevice` knows about a real one. Built on the first connect and handed
 * back unchanged on every later one, so a reconnect finds the instrument as it was left.
 */
export function acquireMockDevice(): Promise<UsbDeviceLike> {
  instrument ??= buildMockDevice();
  return instrument;
}

async function buildMockDevice(): Promise<UsbDeviceLike> {
  const { createCfxEmulator, recordedRunData } = await import("@zpcrweb/core/emulator");
  const [response, completed] = await Promise.all([
    fetch(sampleUrl(RECORDING)),
    Promise.all(COMPLETED_RUNS.map(fetchOptionalSample)),
  ]);
  if (!response.ok) throw new Error(`Couldn't load the simulated instrument's run data (${response.status})`);
  const archive = unzipArchive(new Uint8Array(await response.arrayBuffer()));
  const initialFiles: Record<string, Uint8Array> = {};
  for (const [i, bytes] of completed.entries()) {
    if (bytes) initialFiles[`${REAL_TIME_DATA_DIR}\\${COMPLETED_RUNS[i]}`] = bytes;
  }
  clock = switchableClock(speed);
  return createCfxEmulator({ data: recordedRunData(archive), clock, initialFiles });
}

/** A sample's bytes, or null when it isn't there to fetch — an emptier `Real-Time Data` is no
 * reason to refuse the whole instrument. */
async function fetchOptionalSample(name: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(sampleUrl(name));
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
