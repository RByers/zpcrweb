/**
 * A **protocol builder** — the editable form of the thermal-protocol language (`protocol.md`).
 *
 * `runDefinition.ts` reads the grammar; this writes it. Between them sits the reason this module
 * exists at all: an editor must never be able to produce text the instrument would reject, and
 * the only way to guarantee that is to stop editing text. A {@link ProtocolBuilder} holds a
 * protocol as a **header plus an ordered list of typed steps** — no strings, no `;`, no step
 * numbers — and is the sole writer of the directive text. Every edit goes through a method that
 * returns a new builder, so a caller can hold a history of builders and get undo for free.
 *
 * Three invariants the type system alone wouldn't give, maintained by construction rather than
 * checked afterwards (`protocol.md` §3.1, §4):
 *
 * - **`END` is not a step.** It has no representation here; {@link ProtocolBuilder.toRunDefinition}
 *   emits it last, always. There is no edit that removes it or moves it.
 * - **Step numbers are never stored.** A step's number is its position (`protocol.md` §4 counts
 *   exactly the five step verbs, and modifiers ride on the step they modify — here, as fields of
 *   it), so inserting or deleting renumbers everything downstream for free.
 * - **`GOTO` targets follow their step.** They are repaired across every structural edit
 *   ({@link ProtocolBuilder.withInsertedStep}, {@link ProtocolBuilder.withoutStep}) so a loop
 *   keeps pointing at the step it pointed at, and can only ever name a legal one
 *   ({@link ProtocolBuilder.legalGotoTargets}).
 *
 * What it deliberately cannot express is as important as what it can. Loading is **strict**:
 * {@link ProtocolBuilder.fromRunDefinition} rejects anything it could not write back — an unknown
 * verb, a modifier on a step the language doesn't allow it on (`protocol.md` §3.5), a `PLATEREAD`
 * mask that isn't one of the four known configurations (§5, `usb.md` §3.1). A caller that can't
 * load a protocol should offer no editing for it rather than a lossy edit, which is what the web
 * app's Protocol view does.
 */

import {
  parseRunDefinition,
  parseScanMask,
  formatScanMaskOperand,
  SCAN_MASK_FLYOVER_BIT,
  type RunDefinitionDirective,
} from "./runDefinition.js";

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** `METHOD`'s operand — the thermal control method (`protocol.md` §3.2). */
export const PROTOCOL_METHODS = ["CALC", "BLOCK", "OTHER"] as const;
export type ProtocolMethod = (typeof PROTOCOL_METHODS)[number];

/** The `METHOD`/`HOTLID`/`VOLUME` header, which describes the run as a whole. */
export interface ProtocolHeaderDraft {
  method: ProtocolMethod;
  /** `HOTLID`'s setpoint, °C. `0` disables lid heating altogether. */
  lidTemperatureC: number;
  /** `HOTLID`'s second operand: the block temperature below which the lid heater turns off. */
  shutoffTemperatureC: number;
  /** `VOLUME`, µL — feeds `METHOD CALC`'s thermal model. `0` means "no model". */
  volumeUl: number;
}

/**
 * The channel half of a scan mask, as the two configurations that have ever been observed
 * (`usb.md` §3.1, §9): all six channels (`#h3F`) or channel 1 alone (`#h81`'s low bits). An
 * arbitrary subset is *encodable* in the byte but has never been seen accepted, so it isn't
 * offered — see `protocol.md` §9's first bullet.
 */
export const SCAN_CHANNEL_CHOICES = ["all6", "ch1"] as const;
export type ScanChannelChoice = (typeof SCAN_CHANNEL_CHOICES)[number];

/** A `PLATEREAD`/`MELT` operand as the two fields a person picks (`usb.md` §3.1). */
export interface ScanSelection {
  channels: ScanChannelChoice;
  /** True = flyover (bit 7 set, continuous sweep); false = step-and-repeat. */
  flyover: boolean;
}

/** `TEMP` — hold one temperature, with any of the four modifiers attached. */
export interface TempStepDraft {
  kind: "temp";
  tempC: number;
  /** `0` is the language's indefinite hold (`protocol.md` §3.2). */
  holdSeconds: number;
  /** `INC` — per-pass increment applied on each pass through the enclosing loop. */
  incrementC?: number;
  /** `RATE` — ramp-rate cap toward this step's target. */
  rateCPerSecond?: number;
  /** `EXT` — per-pass change to the hold. */
  extendSeconds?: number;
  /** `BEEP` — sound the beeper when this step completes. */
  beep?: boolean;
}

/** `GRAD` — a temperature gradient across the block's rows. Takes only `EXT` (`protocol.md` §3.5). */
export interface GradStepDraft {
  kind: "grad";
  lowTempC: number;
  highTempC: number;
  holdSeconds: number;
  extendSeconds?: number;
}

/** `MELT` — the compact one-directive melt curve (`protocol.md` §3.2, §6). */
export interface MeltStepDraft {
  kind: "melt";
  startTempC: number;
  endTempC: number;
  incrementC: number;
  holdSeconds: number;
  scan: ScanSelection;
}

/** `PLATEREAD` — the optical measurement (`protocol.md` §5). */
export interface PlateReadStepDraft {
  kind: "plateread";
  scan: ScanSelection;
}

/** `GOTO` — loop back to an earlier step, `repeats` more times (`protocol.md` §4). */
export interface GotoStepDraft {
  kind: "goto";
  /** 1-based step number, always an earlier non-`GOTO` step — see {@link ProtocolBuilder.legalGotoTargets}. */
  targetStep: number;
  /** Additional passes: the loop body runs `repeats + 1` times in total. */
  repeats: number;
}

/** One editable step, discriminated by `kind`. One step = one number in `protocol.md` §4. */
export type ProtocolStepDraft =
  | TempStepDraft
  | GradStepDraft
  | MeltStepDraft
  | PlateReadStepDraft
  | GotoStepDraft;

export type ProtocolStepKind = ProtocolStepDraft["kind"];

/** Every step kind, in the order an editor should offer them. */
export const PROTOCOL_STEP_KINDS = ["temp", "grad", "plateread", "goto", "melt"] as const;

/** The modifiers a step of each kind accepts (`protocol.md` §3.2, §3.5). */
export const STEP_MODIFIERS: Record<ProtocolStepKind, readonly ("INC" | "RATE" | "EXT" | "BEEP")[]> =
  {
    temp: ["INC", "RATE", "EXT", "BEEP"],
    // "GRAD steps take no INC, RATE or BEEP modifier" — protocol.md §3.5.
    grad: ["EXT"],
    melt: [],
    plateread: [],
    goto: [],
  };

/** Thrown by {@link ProtocolBuilder.fromRunDefinition} for text this model can't hold. */
export class ProtocolBuilderError extends Error {
  override name = "ProtocolBuilderError";
}

// ---------------------------------------------------------------------------
// Limits (protocol.md §3.5 — the language's own bounds, all *stated*)
// ---------------------------------------------------------------------------

/** One operand's permitted range, for validation and for an editor to show beside the field. */
export interface ProtocolLimit {
  min: number;
  max: number;
  /** True when the operand is written as an integer (`protocol.md` §3.3). */
  integer?: boolean;
}

export const PROTOCOL_LIMITS = {
  temperatureC: { min: 0, max: 100 },
  gradientC: { min: 30, max: 100 },
  /** The spread between `GRAD`'s two temperatures. */
  gradientSpreadC: { min: 1, max: 24 },
  holdSeconds: { min: 0, max: 64800, integer: true },
  lidTemperatureC: { min: 0, max: 110, integer: true },
  volumeUl: { min: 0, max: 125, integer: true },
  incrementC: { min: -10, max: 10 },
  rateCPerSecond: { min: 0.1, max: 5 },
  extendSeconds: { min: -60, max: 60, integer: true },
  gotoRepeats: { min: 1, max: 9999, integer: true },
  gotoTargetStep: { min: 1, max: 97, integer: true },
} as const satisfies Record<string, ProtocolLimit>;

/** The most steps a protocol may hold (`protocol.md` §3.5). */
export const MAX_PROTOCOL_STEPS = 98;

// ---------------------------------------------------------------------------
// Formatting (protocol.md §3.3)
// ---------------------------------------------------------------------------

/** Temperatures, increments and ramp rates are written with one decimal place, always. */
function fmtTemp(v: number): string {
  return v.toFixed(1);
}

/** Times, volumes, lid temperatures and counts are written as plain integers. */
function fmtInt(v: number): string {
  return String(Math.round(v));
}

/** The raw mask byte a {@link ScanSelection} stands for (`usb.md` §3.1). */
export function scanSelectionToMask(scan: ScanSelection): number {
  const channels = scan.channels === "all6" ? 0x3f : 0x01;
  return channels | (scan.flyover ? SCAN_MASK_FLYOVER_BIT : 0);
}

/**
 * The inverse, for the two channel configurations this model admits — null for any other mask,
 * which is what makes {@link ProtocolBuilder.fromRunDefinition} refuse an unfamiliar operand
 * rather than quietly rewrite it (`protocol.md` §5: preserve what was recorded).
 */
export function scanSelectionFromMask(raw: number): ScanSelection | null {
  const flyover = (raw & SCAN_MASK_FLYOVER_BIT) !== 0;
  const channels = raw & ~SCAN_MASK_FLYOVER_BIT;
  if (channels === 0x3f) return { channels: "all6", flyover };
  if (channels === 0x01) return { channels: "ch1", flyover };
  return null;
}

/** The one-line summary `parseScanMask` gives the same byte — so both halves read alike. */
export function describeScanSelection(scan: ScanSelection): string {
  return parseScanMask(scanSelectionToMask(scan)).summary;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** `105,30` is the 96-well default every committed sample carries (`protocol.md` §3.2). */
export function defaultProtocolHeader(): ProtocolHeaderDraft {
  return { method: "CALC", lidTemperatureC: 105, shutoffTemperatureC: 30, volumeUl: 20 };
}

/** All six channels, step-and-repeat — `#h3F`, what an authored protocol writes (§5). */
export function defaultScanSelection(): ScanSelection {
  return { channels: "all6", flyover: false };
}

/**
 * A new step of the given kind, with operands a person would plausibly start from: a 15 s
 * anneal-ish hold, a 55–65 °C gradient, a melt over the usual range. A `GOTO` needs somewhere to
 * jump, so its target is supplied by the caller (`ProtocolBuilder.defaultStep` fills it in).
 */
export function defaultStepDraft(kind: ProtocolStepKind, targetStep = 1): ProtocolStepDraft {
  switch (kind) {
    case "temp":
      return { kind: "temp", tempC: 60, holdSeconds: 30 };
    case "grad":
      return { kind: "grad", lowTempC: 55, highTempC: 65, holdSeconds: 30 };
    case "melt":
      return {
        kind: "melt",
        startTempC: 65,
        endTempC: 95,
        incrementC: 0.5,
        holdSeconds: 5,
        scan: defaultScanSelection(),
      };
    case "plateread":
      return { kind: "plateread", scan: defaultScanSelection() };
    case "goto":
      return { kind: "goto", targetStep, repeats: 39 };
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One thing wrong with a draft, addressed to the person editing it. */
export interface ProtocolIssue {
  /** The step's 0-based index, or undefined for a header issue. */
  stepIndex?: number;
  /** The offending field of the draft, where one field owns the problem. */
  field?: string;
  message: string;
}

function checkRange(
  value: number,
  limit: ProtocolLimit,
  label: string,
  units: string,
): string | null {
  if (!Number.isFinite(value)) return `${label} must be a number.`;
  if (limit.integer && !Number.isInteger(value)) return `${label} must be a whole number.`;
  if (value < limit.min || value > limit.max) {
    return `${label} must be between ${limit.min} and ${limit.max}${units ? ` ${units}` : ""}.`;
  }
  return null;
}

/** Check the header's three directives. */
export function validateProtocolHeader(header: ProtocolHeaderDraft): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  const push = (field: string, message: string | null) => {
    if (message) issues.push({ field, message });
  };
  if (!PROTOCOL_METHODS.includes(header.method)) {
    push("method", `Method must be one of ${PROTOCOL_METHODS.join(", ")}.`);
  }
  push(
    "lidTemperatureC",
    checkRange(header.lidTemperatureC, PROTOCOL_LIMITS.lidTemperatureC, "Lid temperature", "°C"),
  );
  push(
    "shutoffTemperatureC",
    checkRange(
      header.shutoffTemperatureC,
      PROTOCOL_LIMITS.lidTemperatureC,
      "Lid shutoff temperature",
      "°C",
    ),
  );
  push("volumeUl", checkRange(header.volumeUl, PROTOCOL_LIMITS.volumeUl, "Volume", "µL"));
  return issues;
}

/**
 * Check one step in isolation, plus the one thing that isn't local: a `GOTO`'s target has to be
 * a legal step for a `GOTO` sitting at `stepIndex`, which needs the surrounding list. Pass
 * `legalTargets` (from {@link ProtocolBuilder.legalGotoTargets}) to have that checked too.
 */
export function validateStepDraft(
  step: ProtocolStepDraft,
  stepIndex?: number,
  legalTargets?: readonly number[],
): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  const push = (field: string, message: string | null) => {
    if (message) issues.push({ ...(stepIndex === undefined ? {} : { stepIndex }), field, message });
  };
  const modifiers = (s: TempStepDraft | GradStepDraft) => {
    if (s.kind === "temp" && s.incrementC !== undefined) {
      push("incrementC", checkRange(s.incrementC, PROTOCOL_LIMITS.incrementC, "Increment", "°C"));
    }
    if (s.extendSeconds !== undefined) {
      push("extendSeconds", checkRange(s.extendSeconds, PROTOCOL_LIMITS.extendSeconds, "Extend", "s"));
    }
  };

  switch (step.kind) {
    case "temp":
      push("tempC", checkRange(step.tempC, PROTOCOL_LIMITS.temperatureC, "Temperature", "°C"));
      push("holdSeconds", checkRange(step.holdSeconds, PROTOCOL_LIMITS.holdSeconds, "Duration", "s"));
      modifiers(step);
      if (step.rateCPerSecond !== undefined) {
        push(
          "rateCPerSecond",
          checkRange(step.rateCPerSecond, PROTOCOL_LIMITS.rateCPerSecond, "Ramp rate", "°C/s"),
        );
      }
      break;
    case "grad":
      push("lowTempC", checkRange(step.lowTempC, PROTOCOL_LIMITS.gradientC, "Low temperature", "°C"));
      push(
        "highTempC",
        checkRange(step.highTempC, PROTOCOL_LIMITS.gradientC, "High temperature", "°C"),
      );
      push("holdSeconds", checkRange(step.holdSeconds, PROTOCOL_LIMITS.holdSeconds, "Duration", "s"));
      push(
        "highTempC",
        checkRange(
          step.highTempC - step.lowTempC,
          PROTOCOL_LIMITS.gradientSpreadC,
          "The gradient's spread (high − low)",
          "°C",
        ),
      );
      modifiers(step);
      break;
    case "melt":
      push(
        "startTempC",
        checkRange(step.startTempC, PROTOCOL_LIMITS.temperatureC, "Start temperature", "°C"),
      );
      push(
        "endTempC",
        checkRange(step.endTempC, PROTOCOL_LIMITS.temperatureC, "End temperature", "°C"),
      );
      push("incrementC", checkRange(step.incrementC, PROTOCOL_LIMITS.incrementC, "Increment", "°C"));
      // "a melt's per-pass hold must be ≥ 1" — protocol.md §3.5.
      push("holdSeconds", checkRange(step.holdSeconds, PROTOCOL_LIMITS.holdSeconds, "Hold", "s"));
      if (Number.isFinite(step.holdSeconds) && step.holdSeconds < 1) {
        push("holdSeconds", "A melt's hold must be at least 1 s.");
      }
      if (step.incrementC === 0) push("incrementC", "A melt's increment can't be zero.");
      else if (Number.isFinite(step.incrementC) && Number.isFinite(step.startTempC)) {
        const climbing = step.incrementC > 0;
        if (climbing ? step.endTempC <= step.startTempC : step.endTempC >= step.startTempC) {
          push(
            "endTempC",
            climbing
              ? "With a positive increment the end temperature must be above the start."
              : "With a negative increment the end temperature must be below the start.",
          );
        }
      }
      break;
    case "plateread":
      break;
    case "goto":
      push(
        "targetStep",
        checkRange(step.targetStep, PROTOCOL_LIMITS.gotoTargetStep, "Target step", ""),
      );
      push("repeats", checkRange(step.repeats, PROTOCOL_LIMITS.gotoRepeats, "Repeats", ""));
      if (legalTargets && !legalTargets.includes(step.targetStep)) {
        push(
          "targetStep",
          legalTargets.length === 0
            ? "There is no earlier step to loop back to."
            : `A GOTO can only return to an earlier step that isn't itself a GOTO (${legalTargets.join(", ")}).`,
        );
      }
      break;
  }
  return issues;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

function cloneStep(step: ProtocolStepDraft): ProtocolStepDraft {
  return step.kind === "melt" || step.kind === "plateread"
    ? { ...step, scan: { ...step.scan } }
    : { ...step };
}

/**
 * An immutable protocol under construction. Every mutator returns a new builder; the receiver is
 * never modified, which is what lets an editor keep a plain array of builders as its undo stack.
 */
export class ProtocolBuilder {
  readonly #header: ProtocolHeaderDraft;
  readonly #steps: readonly ProtocolStepDraft[];

  private constructor(header: ProtocolHeaderDraft, steps: readonly ProtocolStepDraft[]) {
    this.#header = header;
    this.#steps = steps;
  }

  /** A protocol with the default header (`protocol.md` §3.2) and no steps. */
  static empty(): ProtocolBuilder {
    return new ProtocolBuilder(defaultProtocolHeader(), []);
  }

  /** Build directly from a header and steps — `GOTO` targets are repaired, not trusted. */
  static of(header: ProtocolHeaderDraft, steps: readonly ProtocolStepDraft[]): ProtocolBuilder {
    return new ProtocolBuilder({ ...header }, steps.map(cloneStep)).#repaired();
  }

  /**
   * Read a `;`-delimited run definition into an editable protocol.
   *
   * @throws {ProtocolBuilderError} for anything this model couldn't write back unchanged: an
   * unknown verb, a modifier with no step to attach to or on a step kind that doesn't take it, a
   * scan mask outside the four known configurations, or directives after `END`. Callers that
   * want a yes/no answer should use {@link ProtocolBuilder.tryFromRunDefinition}.
   */
  static fromRunDefinition(runDefinition: string): ProtocolBuilder {
    const program = parseRunDefinition(runDefinition);
    if (program.unknownVerbs.length > 0) {
      throw new ProtocolBuilderError(
        `Unrecognized directive ${program.unknownVerbs.map((v) => `"${v}"`).join(", ")}.`,
      );
    }

    const header = defaultProtocolHeader();
    const steps: ProtocolStepDraft[] = [];
    let ended = false;

    const requireScan = (d: RunDefinitionDirective & { operand: string }): ScanSelection => {
      const raw = "scanMask" in d ? d.scanMask?.raw : undefined;
      const scan = raw === undefined ? null : scanSelectionFromMask(raw);
      if (!scan) {
        throw new ProtocolBuilderError(
          `Scan mask "${d.operand}" isn't one of the configurations this editor knows ` +
            `(all 6 channels or channel 1, step-and-repeat or flyover).`,
        );
      }
      return scan;
    };

    /** Every operand has to be a number we could write back — `TEMP a,b` isn't editable. */
    const finite = (value: number, what: string, text: string): number => {
      if (!Number.isFinite(value)) {
        throw new ProtocolBuilderError(`"${text}" has an operand that isn't a number (${what}).`);
      }
      return value;
    };

    /** A modifier's target: the step it follows (`protocol.md` §3.2). */
    const modifierTarget = (verb: string): TempStepDraft | GradStepDraft => {
      const last = steps[steps.length - 1];
      if (!last) throw new ProtocolBuilderError(`${verb} has no step to modify.`);
      if (!(STEP_MODIFIERS[last.kind] as readonly string[]).includes(verb)) {
        throw new ProtocolBuilderError(
          `${verb} can't modify a ${last.kind.toUpperCase()} step (protocol.md §3.5).`,
        );
      }
      return last as TempStepDraft | GradStepDraft;
    };

    for (const d of program.directives) {
      if (ended) throw new ProtocolBuilderError(`"${d.text}" comes after END.`);
      switch (d.verb) {
        case "METHOD": {
          const method = d.method.toUpperCase() as ProtocolMethod;
          if (!PROTOCOL_METHODS.includes(method)) {
            throw new ProtocolBuilderError(`Unknown thermal control method "${d.method}".`);
          }
          header.method = method;
          break;
        }
        case "HOTLID":
          header.lidTemperatureC = finite(d.lidTemperatureC, "lid temperature", d.text);
          header.shutoffTemperatureC = finite(d.shutoffTemperatureC, "shutoff", d.text);
          break;
        case "VOLUME":
          header.volumeUl = finite(d.volumeUl, "volume", d.text);
          break;
        case "TEMP":
          steps.push({
            kind: "temp",
            tempC: finite(d.tempC, "temperature", d.text),
            holdSeconds: finite(d.holdSeconds, "duration", d.text),
            ...(d.incrementC !== undefined
              ? { incrementC: finite(d.incrementC, "increment", d.text) }
              : {}),
            ...(d.extendSeconds !== undefined
              ? { extendSeconds: finite(d.extendSeconds, "extend", d.text) }
              : {}),
          });
          break;
        case "GRAD":
          steps.push({
            kind: "grad",
            lowTempC: finite(d.lowTempC, "low temperature", d.text),
            highTempC: finite(d.highTempC, "high temperature", d.text),
            holdSeconds: finite(d.holdSeconds, "duration", d.text),
            ...(d.extendSeconds !== undefined
              ? { extendSeconds: finite(d.extendSeconds, "extend", d.text) }
              : {}),
          });
          break;
        case "MELT":
          steps.push({
            kind: "melt",
            startTempC: finite(d.startTempC, "start temperature", d.text),
            endTempC: finite(d.endTempC, "end temperature", d.text),
            incrementC: finite(d.incrementC, "increment", d.text),
            holdSeconds: finite(d.holdSeconds, "hold", d.text),
            scan: requireScan(d),
          });
          break;
        case "PLATEREAD":
          steps.push({ kind: "plateread", scan: requireScan(d) });
          break;
        case "GOTO":
          steps.push({
            kind: "goto",
            targetStep: finite(d.targetStep, "target step", d.text),
            repeats: finite(d.repeats, "repeats", d.text),
          });
          break;
        case "INC":
          (modifierTarget("INC") as TempStepDraft).incrementC = finite(
            d.incrementC,
            "increment",
            d.text,
          );
          break;
        case "RATE":
          (modifierTarget("RATE") as TempStepDraft).rateCPerSecond = finite(
            d.rateCPerSecond,
            "ramp rate",
            d.text,
          );
          break;
        case "EXT":
          modifierTarget("EXT").extendSeconds = finite(d.extendSeconds, "extend", d.text);
          break;
        case "BEEP":
          (modifierTarget("BEEP") as TempStepDraft).beep = true;
          break;
        case "END":
          ended = true;
          break;
        default:
          throw new ProtocolBuilderError(`Unrecognized directive "${d.text}".`);
      }
    }

    const builder = new ProtocolBuilder(header, steps);
    // A GOTO whose target the text names but the model can't (a forward jump, a jump to another
    // GOTO) is a real difference between what the file says and what we'd write back, so it is
    // reported rather than silently repaired on load.
    for (const [index, step] of steps.entries()) {
      if (step.kind !== "goto") continue;
      const legal = builder.legalGotoTargets(index);
      if (!legal.includes(step.targetStep)) {
        throw new ProtocolBuilderError(
          `GOTO at step ${index + 1} targets step ${step.targetStep}, which this editor can't ` +
            `represent (a GOTO must return to an earlier step that isn't itself a GOTO).`,
        );
      }
    }
    return builder;
  }

  /** {@link ProtocolBuilder.fromRunDefinition} as a result rather than an exception. */
  static tryFromRunDefinition(
    runDefinition: string,
  ): { builder: ProtocolBuilder; error?: undefined } | { builder?: undefined; error: string } {
    try {
      return { builder: ProtocolBuilder.fromRunDefinition(runDefinition) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────

  get header(): ProtocolHeaderDraft {
    return { ...this.#header };
  }

  /** The steps, in order. Index `i` is step number `i + 1` (`protocol.md` §4). */
  get steps(): readonly ProtocolStepDraft[] {
    return this.#steps;
  }

  get stepCount(): number {
    return this.#steps.length;
  }

  step(index: number): ProtocolStepDraft | undefined {
    const s = this.#steps[index];
    return s ? cloneStep(s) : undefined;
  }

  /**
   * The step numbers a `GOTO` at `stepIndex` may target: every **earlier** step that is not
   * itself a `GOTO`.
   *
   * The backward restriction is the language's (`protocol.md` §3.2 — "jump back to step"); the
   * no-GOTO-target part is this library's own, since nothing observed loops onto a loop control
   * and doing so has no defined meaning here.
   */
  legalGotoTargets(stepIndex: number): number[] {
    const targets: number[] = [];
    const upto = Math.min(stepIndex, this.#steps.length);
    for (let i = 0; i < upto; i++) {
      if (this.#steps[i]!.kind === "goto") continue;
      if (i + 1 > PROTOCOL_LIMITS.gotoTargetStep.max) break;
      targets.push(i + 1);
    }
    return targets;
  }

  /** Whether a step of this kind can be inserted at `index` — only `GOTO` is ever refused. */
  canInsert(kind: ProtocolStepKind, index: number): boolean {
    if (this.#steps.length >= MAX_PROTOCOL_STEPS) return false;
    return kind !== "goto" || this.legalGotoTargets(index).length > 0;
  }

  /** A ready-to-insert step of `kind` at `index`, with a `GOTO`'s target pre-filled. */
  defaultStep(kind: ProtocolStepKind, index: number): ProtocolStepDraft {
    const targets = this.legalGotoTargets(index);
    return defaultStepDraft(kind, targets[0] ?? 1);
  }

  /** Every problem with the current contents — empty for a protocol that's good to send. */
  validate(): ProtocolIssue[] {
    const issues = validateProtocolHeader(this.#header);
    for (const [index, step] of this.#steps.entries()) {
      issues.push(...validateStepDraft(step, index, this.legalGotoTargets(index)));
    }
    if (this.#steps.length > MAX_PROTOCOL_STEPS) {
      issues.push({ message: `A protocol can hold at most ${MAX_PROTOCOL_STEPS} steps.` });
    }
    return issues;
  }

  // ── Editing ────────────────────────────────────────────────────────────────────────────

  withHeader(patch: Partial<ProtocolHeaderDraft>): ProtocolBuilder {
    return new ProtocolBuilder({ ...this.#header, ...patch }, this.#steps);
  }

  /** Replace one step. A `GOTO`'s target is clamped to a legal one rather than trusted. */
  withStep(index: number, step: ProtocolStepDraft): ProtocolBuilder {
    if (index < 0 || index >= this.#steps.length) return this;
    const next = this.#steps.slice();
    next[index] = cloneStep(step);
    return new ProtocolBuilder(this.#header, next).#repaired();
  }

  /**
   * Insert a step so it becomes step number `index + 1`, pushing the rest down. Every `GOTO`
   * that pointed past the insertion point is renumbered to keep pointing at the same step.
   */
  withInsertedStep(index: number, step: ProtocolStepDraft): ProtocolBuilder {
    const at = Math.max(0, Math.min(index, this.#steps.length));
    const next = this.#steps.slice();
    // A GOTO's target is a step *number*, so anything at or past the insertion point moves.
    for (let i = 0; i < next.length; i++) {
      const s = next[i]!;
      if (s.kind === "goto" && s.targetStep - 1 >= at) {
        next[i] = { ...s, targetStep: s.targetStep + 1 };
      }
    }
    next.splice(at, 0, cloneStep(step));
    return new ProtocolBuilder(this.#header, next).#repaired();
  }

  /** Append a step at the end (just before the implicit `END`). */
  withAppendedStep(step: ProtocolStepDraft): ProtocolBuilder {
    return this.withInsertedStep(this.#steps.length, step);
  }

  /**
   * Delete one step, renumbering the rest.
   *
   * A `GOTO` that pointed *at* the deleted step follows the step list rather than dangling: it
   * lands on whatever now occupies that position, and {@link ProtocolBuilder.#repaired} clamps it
   * if that isn't legal. A `GOTO` left with nowhere legal to jump is deleted along with it —
   * there is no valid text for one, so keeping it would mean an unwritable protocol.
   */
  withoutStep(index: number): ProtocolBuilder {
    if (index < 0 || index >= this.#steps.length) return this;
    const next = this.#steps.slice();
    next.splice(index, 1);
    for (let i = 0; i < next.length; i++) {
      const s = next[i]!;
      if (s.kind === "goto" && s.targetStep - 1 > index) {
        next[i] = { ...s, targetStep: s.targetStep - 1 };
      }
    }
    return new ProtocolBuilder(this.#header, next).#repaired();
  }

  /**
   * Bring every `GOTO` back into range after a structural edit: clamp a target to the nearest
   * legal earlier step, and drop a `GOTO` that has none. Iterates, because dropping one shifts
   * the numbering the next one was checked against.
   */
  #repaired(): ProtocolBuilder {
    let steps = this.#steps.slice();
    for (;;) {
      let changed = false;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        if (s.kind !== "goto") continue;
        const legal = new ProtocolBuilder(this.#header, steps).legalGotoTargets(i);
        if (legal.length === 0) {
          steps.splice(i, 1);
          changed = true;
          break;
        }
        if (!legal.includes(s.targetStep)) {
          // The nearest legal target at or before where it pointed, else the first legal one.
          const at = [...legal].reverse().find((t) => t <= s.targetStep) ?? legal[0]!;
          steps[i] = { ...s, targetStep: at };
          changed = true;
        }
      }
      if (!changed) break;
    }
    return new ProtocolBuilder(this.#header, steps);
  }

  // ── Writing ────────────────────────────────────────────────────────────────────────────

  /** The directives, in order, each without its `;` — the unit the USB channel sends (§7). */
  toDirectives(): string[] {
    const h = this.#header;
    const out = [`METHOD ${h.method}`, `HOTLID ${fmtInt(h.lidTemperatureC)},${fmtInt(h.shutoffTemperatureC)}`, `VOLUME ${fmtInt(h.volumeUl)}`];
    for (const step of this.#steps) {
      switch (step.kind) {
        case "temp":
          out.push(`TEMP ${fmtTemp(step.tempC)},${fmtInt(step.holdSeconds)}`);
          // Modifiers follow their step, in the order every observed protocol writes them (§6).
          if (step.incrementC !== undefined) out.push(`INC ${fmtTemp(step.incrementC)}`);
          if (step.rateCPerSecond !== undefined) out.push(`RATE ${fmtTemp(step.rateCPerSecond)}`);
          if (step.extendSeconds !== undefined) out.push(`EXT ${fmtInt(step.extendSeconds)}`);
          if (step.beep) out.push("BEEP");
          break;
        case "grad":
          out.push(
            `GRAD ${fmtTemp(step.lowTempC)},${fmtTemp(step.highTempC)},${fmtInt(step.holdSeconds)}`,
          );
          if (step.extendSeconds !== undefined) out.push(`EXT ${fmtInt(step.extendSeconds)}`);
          break;
        case "melt":
          // MELT's mask is written in lower-case hex where PLATEREAD's is upper (§3.3).
          out.push(
            `MELT ${fmtTemp(step.startTempC)},${fmtTemp(step.endTempC)},` +
              `${fmtTemp(step.incrementC)},${fmtInt(step.holdSeconds)},` +
              formatScanMaskOperand(scanSelectionToMask(step.scan)).toLowerCase(),
          );
          break;
        case "plateread":
          out.push(`PLATEREAD ${formatScanMaskOperand(scanSelectionToMask(step.scan))}`);
          break;
        case "goto":
          out.push(`GOTO ${fmtInt(step.targetStep)},${fmtInt(step.repeats)}`);
          break;
      }
    }
    out.push("END");
    return out;
  }

  /**
   * The canonical one-line form every carrier of `protocol.md` §2 holds — `;`-delimited, ending
   * `END;`. Round-trips through {@link ProtocolBuilder.fromRunDefinition}.
   */
  toRunDefinition(): string {
    return this.toDirectives().join(";") + ";";
  }
}
