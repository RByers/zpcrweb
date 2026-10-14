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
 * | {@link START_WINDOW_MS} | 6 s between `RemoteRun` and the run appearing | measured (`usb.md` §7.8 step 0) |
 * | {@link LID_PREHEAT_MS} | the lid warm-up before the block moves | measured (`usb.md` §7.3, ~168 s) |
 * | {@link PLATE_READ_MS} | a `PLATEREAD #h3F` step | measured (`usb.md` §3.2, 15.2 s) |
 * | {@link RAMP_MS} | a thermal step's approach to its setpoint | this emulator's own |
 * | {@link LID_OPENING_MS}, {@link LID_CLOSING_MS} | the motorised lid in motion after `LID OPEN` / `LID CLOSE` | measured (`usb-run` capture, `usb.md` §3.2 field 17) |
 *
 * Only the last is invented. A real ramp's length depends on how far the block has to travel and
 * the instrument never reports a rate, so a constant is the honest placeholder — it produces the
 * one thing a client actually keys on, which is `atTarget` going false then true.
 */
import {
  walkProgram,
  type RunDefinitionDirective,
  type RunDefinitionProgram,
} from "../../runDefinition.js";

/** `RemoteRun` is accepted, and for this long `STATUS?` still reports the empty idle — a `CANCEL`
 * inside the window is answered `0000` and ignored (`usb.md` §7.8 step 0, measured ~6.1 s). */
export const START_WINDOW_MS = 6_000;
/** The lid climbs to its setpoint while the block sits at ambient and the run's clocks stay at
 * zero (`usb.md` §7.3, measured ~168 s). */
export const LID_PREHEAT_MS = 168_000;
/** One `PLATEREAD #h3F` (`usb.md` §3.2, measured 15.2 s). */
export const PLATE_READ_MS = 15_200;
/** How long a thermal step spends ramping before its hold starts counting. This emulator's own —
 * see the module comment. */
export const RAMP_MS = 10_000;
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
  /** The setpoint this pass, `INC` applied, or null for a step that has none (a plate read). */
  targetC: number | null;
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

/** How long one executed step occupies. `GOTO` and `END` are bookkeeping and take no time. */
function durationMs(step: RunDefinitionDirective, holdSeconds: number): number {
  if (step.verb === "PLATEREAD") return PLATE_READ_MS;
  if (step.verb === "TEMP" || step.verb === "GRAD") return RAMP_MS + holdSeconds * 1000;
  return 0;
}

/**
 * Lay the program out on a timeline.
 *
 * Throws whatever {@link walkProgram} throws for a protocol that cannot be executed on paper — a
 * `GOTO` off the end of the step list, or a loop that never terminates. That is the right answer
 * here: the instrument would have rejected such a step list while it was being authored, and an
 * emulator that ran it anyway would be more permissive than the thing it imitates.
 */
export function scheduleRun(program: RunDefinitionProgram): RunSchedule {
  const steps: ScheduledStep[] = [];
  let at = 0;
  let reads = 0;
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
    if (directive.verb === "GOTO" || directive.verb === "END") continue;
    if (stepNumber > previousStepNumber + 1) repeat = 1;
    else if (stepNumber <= previousStepNumber) repeat++;
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
    const length = durationMs(directive, holdSeconds);
    const step: ScheduledStep = {
      directive,
      stepNumber,
      executed,
      repeat,
      targetC,
      holdSeconds,
      startMs: at,
      endMs: at + length,
    };
    if (directive.verb === "PLATEREAD") step.readIndex = ++reads;
    steps.push(step);
    at += length;
  }

  return { steps, endMs: at, plateReads: reads };
}
