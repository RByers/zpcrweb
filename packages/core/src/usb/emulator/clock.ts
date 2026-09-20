/**
 * The emulator's sense of time — `emulator.md` §6.
 *
 * A run is two hours of block temperature, so the one thing an emulated instrument must be able
 * to do that a real one cannot is *go faster*. Three implementations of one interface cover every
 * way this project wants to watch a run:
 *
 * - {@link realtimeClock} — wall time, optionally scaled, with the scale changeable **while a run
 *   is going**. What an interactive session uses.
 * - {@link acceleratedClock} — **no timers and no sleeps anywhere.** Simulated time moves only
 *   when the host asks a question, and each `STATUS?` jumps straight to the next thing that
 *   happens. One poll, one step; a run finishes in as many polls as it has steps.
 * - {@link manualClock} — a test drives it by hand.
 *
 * ## The invariant every implementation keeps
 *
 * **Simulated time never jumps, in either direction, and a speed change governs only the time
 * from that moment on.**
 *
 * A real instrument's clock only ever advances, and everything above the wire is built on that:
 * a run's elapsed seconds, its step timer, the live thermal chart and the run follower's own edge
 * detection are all differences between successive `STATUS?` replies. Let simulated time move
 * backwards, or jump forwards, and the app is being tested against a machine that cannot exist —
 * a bug found that way isn't real, and a bug hidden that way is.
 *
 * So {@link realtimeClock}'s `setSpeed` **rebases**: it recomputes the origin to `now()` *before*
 * storing the new rate, leaving everything already simulated exactly where it was. Rescaling
 * instead — multiplying the whole elapsed wall time by the new factor — moves time that has
 * already happened, backwards when the speed drops and forwards when it rises.
 */

export interface EmulatorClock {
  /** Simulated milliseconds since the emulator was created. Never decreases. */
  now(): number;
  /**
   * Called before every `STATUS?` is answered, with the simulated time of the next moment the
   * run's state changes — a step ending, a run starting or finishing — or null when nothing is
   * pending.
   *
   * A wall-clock implementation ignores it entirely; it exists for {@link acceleratedClock},
   * which has no timer and would otherwise never move. That is the whole of the accelerated
   * contract: the host asking "what is happening?" is what makes the next thing happen.
   */
  poll(nextEventAtMs: number | null): void;
}

/** A clock whose rate can be changed mid-run — {@link realtimeClock}'s addition. */
export interface ScaledClock extends EmulatorClock {
  /** The current multiple of wall time. */
  readonly speed: number;
  /** Change the rate from this moment on. Rebases; see the module comment. */
  setSpeed(speed: number): void;
}

/**
 * Wall time, scaled by `speed`. `1` is a real instrument's pace; `60` runs an hour a minute.
 *
 * `wall` is injected so a test can drive it without `Date.now()`; it defaults to the real clock
 * and no caller in the app passes one.
 */
export function realtimeClock(speed = 1, wall: () => number = Date.now): ScaledClock {
  let rate = speed;
  let origin = 0;
  let wallAt = wall();
  const now = () => origin + (wall() - wallAt) * rate;
  return {
    now,
    poll() {},
    get speed() {
      return rate;
    },
    setSpeed(next: number) {
      // Rebase *before* the new rate lands: what has already been simulated stays put, and only
      // the rate from here differs. See the module comment for why this is not negotiable.
      origin = now();
      wallAt = wall();
      rate = next;
    },
  };
}

/**
 * Simulated time that advances only when asked — no timers, no sleeps, no wall clock at all.
 *
 * Each `STATUS?` moves the clock to the next moment the run's state changes, so the run's
 * progress is a pure function of how many polls have happened and a check never waits on a
 * duration. With nothing pending it still creeps forward by {@link IDLE_TICK_MS}, so an idle
 * instrument's clock is not frozen solid.
 */
export function acceleratedClock(): EmulatorClock {
  let t = 0;
  return {
    now: () => t,
    poll(nextEventAtMs) {
      t = nextEventAtMs === null ? t + IDLE_TICK_MS : Math.max(t, nextEventAtMs);
    },
  };
}

/** How far an idle accelerated instrument's clock moves per poll. Arbitrary — nothing depends on
 * it, since nothing is scheduled; it exists so time is not literally stopped. */
const IDLE_TICK_MS = 1000;

/** A clock a test advances by hand, to sit *inside* a step rather than skip over it. */
export function manualClock(): EmulatorClock & { advance(ms: number): void } {
  let t = 0;
  return {
    now: () => t,
    poll() {},
    advance(ms: number) {
      if (ms < 0) throw new Error("an emulated clock never goes backwards");
      t += ms;
    },
  };
}
