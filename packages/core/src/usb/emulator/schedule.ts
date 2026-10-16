/**
 * What a protocol *does*, laid out on a timeline — `emulator.md` §5.
 *
 * A run is authored as a step list with loops in it, and the emulator has to answer, for any
 * simulated moment, "which step is executing, what is it ramping toward, and how much of its hold
 * has gone". Computing the whole executed schedule once, up front, is what makes that a lookup
 * rather than a simulation with state in it — and it is also exactly the log the `.alf` report
 * needs afterwards, so the two are one thing.
 *
 * The loop semantics are not spelled out here: {@link walkProgram} owns them (`protocol.md` §4,
 * measured), and this walks what it yields. That matters because the same rules decide how many
 * plate reads a finished archive should hold (`runDefinition.ts`'s `expectedPlateReads`), and the
 * emulator producing a different number from the reader expecting it would be a bug in whichever
 * one was written twice.
 *
 * ## The durations
 *
 * | | | |
 * |---|---|---|
 * | {@link START_WINDOW_MS}, {@link START_WINDOW_PLATE_READ_MS} | `RemoteRun` to the run appearing, without and with plate reads | measured (`usb.md` §7.3) |
 * | {@link lidPreheatMs} | the lid warm-up before the block moves, from the lid's own temperature | measured (`usb.md` §7.3) |
 * | {@link PLATE_READ_MS} | a `PLATEREAD #h3F` step | measured (`usb.md` §3.2) |
 * | {@link rampMs} | a thermal step's approach to its setpoint, from how far the block has to go | measured (`usb.md` §3.2) |
 * | {@link LID_OPENING_MS}, {@link LID_CLOSING_MS} | the motorised lid in motion after `LID OPEN` / `LID CLOSE` | measured (`usb-run` capture, `usb.md` §3.2 field 17) |
 *
 * Every one is measured — from the two recorded sessions and the `usb-run` capture, `emulator.md`
 * §10. What is still this emulator's own is the *shape* inside a ramp (linear), not its length.
 */
import {
  walkProgram,
  type RunDefinitionDirective,
  type RunDefinitionProgram,
} from "../../runDefinition.js";

/** The block's resting temperature, and the ambient every idle reply reports. This emulator's
 * own — the instrument's depends on the room (17.7–22.9 °C across the recordings). */
export const AMBIENT_C = 18.4;

/** `RemoteRun` is accepted, and for this long `STATUS?` still reports the empty idle — a `CANCEL`
 * inside the window is answered `0000` and ignored (`usb.md` §7.3, §7.8 step 0). Measured on a
 * run with no `PLATEREAD`: between 4.4 and 5.9 s. */
export const START_WINDOW_MS = 5_500;
/** The same window for a run that writes a run folder, which is nearly twice as long: the firmware
 * empties the previous run out of `CurrentRun` and copies the calibration set in before the run
 * shows. Measured between 10.4 and 11.0 s across two plate-read runs (`usb.md` §7.3). */
export const START_WINDOW_PLATE_READ_MS = 10_700;
/** How fast the lid heats during the preheat, °C/s — 0.444, 0.455 and 0.469 in the three runs
 * measured (`usb.md` §7.3). */
export const LID_HEAT_C_PER_S = 0.455;
/** The preheat ends when the lid comes within this much of its setpoint: 94.8–95.2 °C on a 105 °C
 * lid, in all three runs measured (`usb.md` §7.3). */
export const LID_PREHEAT_MARGIN_C = 10;
/** One `PLATEREAD #h3F` — median 12.5 s over the 45 reads of one recorded run, 13.9 and 14.9 s in
 * the `usb-run` capture (`usb.md` §3.2). */
export const PLATE_READ_MS = 12_500;
/** Ramp rates, °C/s, as far as a step's at-target bit is concerned: up 3.1 (12–72 °C rises across
 * both recordings and the capture, each within 1.7 s of this), down 2.35 (35 and 40 °C falls,
 * 15.0 and 16.9 s). Measured, `usb.md` §3.2 field 11. */
export const RAMP_UP_C_PER_S = 3.1;
export const RAMP_DOWN_C_PER_S = 2.35;

/** After the acknowledging `CANCEL` the run stays named in `STATUS?` (register 32) for this long;
 * then `ended` and the `.alf` appear and the instrument reports the empty idle. Measured to lie
 * between 0.3 s — still named, the final read listed but no `ended` — and 2.75 s, by which CFX
 * Manager's next poll found the empty idle (`usb.md` §7.6). The middle of that bracket. */
export const RELEASE_MS = 1_500;
/** For this long after a step that changes the setpoint begins, the at-target bit still reads the
 * step before's — 14 of the 90 such step changes in one recorded run were polled inside it, at a
 * 1.5 s poll interval (`usb.md` §3.2, field 7 bit 0). */
export const AT_TARGET_LAG_MS = 250;
/** Once a run ends the block and lid fall back towards ambient — exponentially, with these time
 * constants. The lid's is measured: 105 °C at one run's end, 35.0 °C 42 minutes later at the next
 * connect. The block's is a fit to three falls of under 3 s each (0.15–0.44 °C/s just after a
 * finish), so take it as an order of magnitude (`usb.md` §7.6). */
export const LID_COOL_TAU_S = 1_300;
export const BLOCK_COOL_TAU_S = 150;

/** Newtonian cooling: where something at `fromC` is `elapsedMs` later, falling toward `ambientC`. */
export function cooled(fromC: number, elapsedMs: number, tauS: number, ambientC = AMBIENT_C): number {
  if (elapsedMs <= 0) return fromC;
  return ambientC + (fromC - ambientC) * Math.exp(-elapsedMs / 1000 / tauS);
}

/**
 * How long the lid preheat lasts, from the lid's temperature when the run appears (`usb.md` §7.3).
 * The block does not move until the lid is within {@link LID_PREHEAT_MARGIN_C} of its setpoint, so
 * a lid still warm from the previous run cuts it short — 124.5 s from 37.7 °C against 169 s from
 * 19.6 °C, measured. A run with the lid off has none.
 */
export function lidPreheatMs(lidStartC: number, lidTargetC: number, lidOn = true): number {
  if (!lidOn) return 0;
  const rise = lidTargetC - LID_PREHEAT_MARGIN_C - lidStartC;
  return rise <= 0 ? 0 : Math.round((rise / LID_HEAT_C_PER_S) * 1000);
}

/** How long the block takes to reach `toC` from `fromC` — zero for a step that holds where the
 * last one did, which is what the instrument does with `TEMP 95.0,180` → `TEMP 95.0,15`. */
export function rampMs(fromC: number, toC: number): number {
  const delta = toC - fromC;
  const rate = delta >= 0 ? RAMP_UP_C_PER_S : RAMP_DOWN_C_PER_S;
  return Math.round((Math.abs(delta) / rate) * 1000);
}
/** After `LID OPEN`, field 17 reads `OPENING` for this long before `OPEN`; after `LID CLOSE`,
 * `CLOSING` before `CLOSED`. Measured once each in the `usb-run` capture, to the ±1.4 s of its
 * status poll (`emulator.md` §10.2). */
export const LID_OPENING_MS = 17_600;
export const LID_CLOSING_MS = 8_500;

/** One step of the run, as it executes — one pass through it, not one protocol step. */
export interface ScheduledStep {
  directive: RunDefinitionDirective;
  /** 1-based protocol step number, the numbering `GOTO` counts in. */
  stepNumber: number;
  /** How many steps had already executed when this one started, 0-based. */
  executed: number;
  /** 1-based pass through the loop this step is in — the `.alf`'s second field (`alf.md` §7). */
  repeat: number;
  /** `STATUS?` field 2: 1 until the loop's `GOTO` has executed once, then the loop's total number
   * of passes — `1` through the first cycle of a `GOTO 2,44`, `45` from the second on (measured,
   * `usb.md` §3.2). */
  cycles: number;
  /** The setpoint this pass, `INC` applied, or null for a step that has none (a plate read). */
  targetC: number | null;
  /** Where the block starts this step from: the last setpoint, or the run's starting temperature. */
  fromC: number;
  /** How much of the step is the ramp to {@link targetC} — 0 for a plate read. */
  rampMs: number;
  /** The nominal hold, seconds, `EXT` applied. */
  holdSeconds: number;
  /** Simulated ms since the run's steps began — i.e. after the start window and the lid preheat. */
  startMs: number;
  endMs: number;
  /** 1-based position among the run's plate reads, for a `PLATEREAD` step. */
  readIndex?: number;
}

export interface RunSchedule {
  steps: ScheduledStep[];
  /** Simulated ms, relative to the same origin as {@link ScheduledStep.startMs}, at which the
   * protocol completes. */
  endMs: number;
  /** How many `Read0000N.Plateread` files this run will produce. */
  plateReads: number;
}

/** The modifiers that ride *after* the step they attach to (`protocol.md` §3.2). */
function modifiersFor(
  program: RunDefinitionProgram,
  step: RunDefinitionDirective,
): { incrementC: number; extendSeconds: number } {
  let incrementC = 0;
  let extendSeconds = 0;
  if (step.verb === "TEMP") {
    incrementC = step.incrementC ?? 0;
    extendSeconds = step.extendSeconds ?? 0;
  } else if (step.verb === "GRAD") {
    extendSeconds = step.extendSeconds ?? 0;
  }
  for (let i = step.index + 1; i < program.directives.length; i++) {
    const next = program.directives[i]!;
    if (next.verb === "INC") incrementC = next.incrementC;
    else if (next.verb === "EXT") extendSeconds = next.extendSeconds;
    else if (next.verb !== "RATE" && next.verb !== "BEEP") break;
  }
  return { incrementC, extendSeconds };
}

/**
 * Lay the program out on a timeline, starting from a block at `startC`.
 *
 * Throws whatever {@link walkProgram} throws for a protocol that cannot be executed on paper — a
 * `GOTO` off the end of the step list, or a loop that never terminates. That is the right answer
 * here: the instrument would have rejected such a step list while it was being authored, and an
 * emulator that ran it anyway would be more permissive than the thing it imitates.
 */
export function scheduleRun(program: RunDefinitionProgram, startC: number = AMBIENT_C): RunSchedule {
  const steps: ScheduledStep[] = [];
  let at = 0;
  let reads = 0;
  let blockC = startC;
  // Field 2 of `STATUS?`: the instrument learns a loop's length only by executing its `GOTO`, so
  // the first pass reports 1 and every later pass the total; leaving the loop puts it back to 1.
  let cycles = 1;
  // `repeat` counts passes through the loop currently executing: it goes up wherever the walk
  // jumps backwards — or lands on the step it just left, which is what a one-step loop body
  // looks like — and resets wherever it skips forward over a step — which is always a
  // closing `GOTO`, since that is the only directive that can sit between a loop's last body
  // step and whatever follows the loop. That forward skip is the only stage boundary the `.alf`
  // marks (`alf.md` §7.2). Read off the step numbers rather than tracked inside the walk, so the
  // loop semantics stay in the one place that owns them.
  let repeat = 1;
  let previousStepNumber = 0;

  for (const { directive, stepNumber, executed } of walkProgram(program)) {
    if (directive.verb === "GOTO") {
      cycles = directive.repeats + 1;
      continue;
    }
    if (directive.verb === "END") continue;
    if (stepNumber > previousStepNumber + 1) {
      repeat = 1;
      cycles = 1;
    } else if (stepNumber <= previousStepNumber) repeat++;
    previousStepNumber = stepNumber;

    const { incrementC, extendSeconds } = modifiersFor(program, directive);
    const pass = repeat - 1;
    const targetC =
      directive.verb === "TEMP"
        ? directive.tempC + incrementC * pass
        : directive.verb === "GRAD"
          ? directive.highTempC
          : null;
    const holdSeconds =
      directive.verb === "TEMP" || directive.verb === "GRAD"
        ? Math.max(0, directive.holdSeconds + extendSeconds * pass)
        : 0;
    const ramp = targetC === null ? 0 : rampMs(blockC, targetC);
    // `GOTO` and `END` never get here: they are bookkeeping and take no time.
    const length =
      directive.verb === "PLATEREAD"
        ? PLATE_READ_MS
        : directive.verb === "TEMP" || directive.verb === "GRAD"
          ? ramp + holdSeconds * 1000
          : 0;
    const step: ScheduledStep = {
      directive,
      stepNumber,
      executed,
      repeat,
      cycles: repeat === 1 ? 1 : cycles,
      targetC,
      fromC: blockC,
      rampMs: ramp,
      holdSeconds,
      startMs: at,
      endMs: at + length,
    };
    if (directive.verb === "PLATEREAD") step.readIndex = ++reads;
    steps.push(step);
    if (targetC !== null) blockC = targetC;
    at += length;
  }

  return { steps, endMs: at, plateReads: reads };
}
