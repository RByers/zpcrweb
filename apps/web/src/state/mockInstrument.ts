/**
 * The mock instrument — a simulated CFX96 the app can connect to with no hardware present.
 *
 * Turned on by `#mock` in the URL, which is read the way `pltdPassword.ts` reads `#cfxPassword`:
 * **an instruction, not state**. `urlHash.ts` deliberately serializes only `file` and `view`, so
 * the flag is consumed once at module load and the address bar goes back to an ordinary bookmark
 * — a link hands someone a mock session, and a reload of the rewritten URL is a real one.
 *
 * - `#mock` — realtime, 1× (an instrument's own pace).
 * - `#mock=10` / `#mock=60` — realtime, scaled: an hour of protocol a minute at 60×.
 * - `#mock=max` — no timers at all; the run advances a step per status poll.
 *
 * Everything simulated is loaded **lazily**: `@zpcrweb/core/emulator` is a whole imitation
 * instrument on its own entry point, reached through `import()` from {@link acquireMockDevice}
 * and from nowhere else, so a build that never sets the flag never downloads it.
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

const HASH_KEY = "mock";

function parseSpeed(raw: string | null): MockSpeed {
  if (raw === null || raw === "") return 1;
  if (/^max$/i.test(raw)) return "max";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Read the flag out of the URL at module load, before `urlHash.ts`'s first write rebuilds the
 * hash from file/view alone and drops it — the same ordering `pltdPassword.ts` relies on.
 */
let enabled = false;
let speed: MockSpeed = 1;
try {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if (hash.has(HASH_KEY)) {
    enabled = true;
    speed = parseSpeed(hash.get(HASH_KEY));
  }
} catch {
  /* ignore (no window, malformed URL) */
}

/** Whether this page load is a mock session. Fixed for the life of the page. */
export function mockInstrumentEnabled(): boolean {
  return enabled;
}

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
  const response = await fetch(sampleUrl(RECORDING));
  if (!response.ok) throw new Error(`Couldn't load the simulated instrument's run data (${response.status})`);
  const archive = unzipArchive(new Uint8Array(await response.arrayBuffer()));
  clock = switchableClock(speed);
  return createCfxEmulator({ data: recordedRunData(archive), clock });
}
