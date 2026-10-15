/**
 * A CFX96 that isn't there — `emulator.md`.
 *
 * Everything past the Instrument view's Connect button used to be untested: the recordings in
 * `samples/` are transcripts, not conversations, so a run could be read back but never *driven*.
 * This is the other half — an object satisfying {@link UsbDeviceLike} that speaks the raw
 * protocol of `usb.md`, so `new CfxDevice(createCfxEmulator(…))` exercises the real client, the
 * real framing and the real command language with no instrument on the desk and nothing in
 * `CfxDevice` changed to accommodate it.
 *
 * ```ts
 * const emulator = createCfxEmulator({ data: recordedRunData(archive), clock: acceleratedClock() });
 * const device = new CfxDevice(emulator);
 * await device.open();
 * await device.startRun(planRun({ runDefinition, plate, name: "demo" }));
 * ```
 *
 * **It is not evidence about the instrument.** It was written from the same document the client
 * was, so the two agreeing says only that they read `usb.md` the same way — see `emulator.md`
 * Appendix A, which records per command whether a reply is measured, derived or invented.
 */
import type { UsbDeviceLike } from "../transport.js";
import { realtimeClock, type EmulatorClock } from "./clock.js";
import type { EmulatorRunData } from "./data.js";
import { EmulatedInstrument, type EmulatorIdentity } from "./instrument.js";
import { EmulatorTransport } from "./transport.js";

export interface EmulatorOptions {
  /**
   * Where the fluorescence comes from. Optional: a thermal-only protocol produces no plate reads
   * and no run folder (`usb.md` §7.10), so a heat-block session needs none — and asking for one
   * with a `PLATEREAD` protocol and no data is a configuration error this says so about.
   */
  data?: EmulatorRunData | null;
  /** Defaults to realtime at 1×. */
  clock?: EmulatorClock;
  identity?: Partial<EmulatorIdentity>;
  /** What `\Storage Card\CurrentRun` already holds on connect — usually the previous run. */
  initialRunFolder?: Record<string, Uint8Array> | null;
  /** Files already anywhere else on the instrument, keyed by full path — `Real-Time Data`'s
   * completed runs, say, which the emulator never writes itself. */
  initialFiles?: Record<string, Uint8Array> | null;
  /** The wall-clock instant simulated time zero corresponds to, for the run's own timestamps. */
  startedAt?: Date;
}

/** The emulator, as the device handle a client takes — plus the two things a driver of it wants
 * to reach: the instrument's state, and the clock. */
export class CfxEmulator extends EmulatorTransport {
  readonly instrument: EmulatedInstrument;
  readonly clock: EmulatorClock;

  constructor(options: EmulatorOptions = {}) {
    const clock = options.clock ?? realtimeClock();
    const instrument = new EmulatedInstrument({ ...options, clock });
    super((command, payload) => instrument.handle(command, payload));
    this.clock = clock;
    this.instrument = instrument;
  }
}

/** Build an emulator. `new CfxEmulator(…)` does the same; this is the name the app reaches for. */
export function createCfxEmulator(options: EmulatorOptions = {}): CfxEmulator {
  return new CfxEmulator(options);
}

export { acceleratedClock, manualClock, realtimeClock } from "./clock.js";
export type { EmulatorClock, ScaledClock } from "./clock.js";
export { recordedRunData } from "./data.js";
export type { EmulatorRunData, PlateReadContext, RecordedRunDataOptions } from "./data.js";
export { DEFAULT_IDENTITY, EmulatedInstrument } from "./instrument.js";
export type { EmulatorIdentity } from "./instrument.js";
export { EmulatorTransport } from "./transport.js";
export type { EmulatorReply, EmulatorResponder } from "./transport.js";
export { EmulatedRun } from "./run.js";
export type { RunRequest, RunSnapshot } from "./run.js";
export {
  LID_PREHEAT_MS,
  PLATE_READ_MS,
  RAMP_MS,
  START_WINDOW_MS,
  scheduleRun,
} from "./schedule.js";
export type { RunSchedule, ScheduledStep } from "./schedule.js";
export type { UsbDeviceLike };
