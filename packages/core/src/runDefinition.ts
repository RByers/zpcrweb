/**
 * The ASCII thermal-protocol grammar — `METHOD CALC;HOTLID 105,30;…;END;` — decoded into typed
 * directives with step numbers and plain-English descriptions. See `protocol.md` for the
 * language itself, `usb.md` §3.1 for the `PLATEREAD` scan mask, and `prcl.md` §3 for where the
 * text form sits relative to the XML step list.
 *
 * This is the one place that knows what a directive *means*: every consumer — the web app's
 * protocol views, the `.prcl.txt` reader/writer, {@link protocolDocumentFromRunDefinition} —
 * reads structure from here rather than matching on the text itself.
 *
 * Three text sources share this exact grammar and all decode through {@link parseRunDefinition}:
 * a `.zpcr`'s `ProtocolRunDefinition.txt` (what the instrument recorded), a `.prcl`/`.pcrd`'s
 * `protocol2 runDefinition` attribute (what was authored), and a plaintext `.prcl`/`.prcl.txt`
 * (`prcl.md` §1.1, §3.1).
 */

import { formatDuration } from "./duration.js";

// ---------------------------------------------------------------------------
// The PLATEREAD scan mask (usb.md §3.1)
// ---------------------------------------------------------------------------

/** Optical channels a CFX96 head carries — the width of the scan mask's channel field. */
export const SCAN_MASK_CHANNELS = 6;

/** Bit 7 of the scan mask: set = flyover (continuous sweep), clear = step-and-repeat. */
export const SCAN_MASK_FLYOVER_BIT = 0x80;

/**
 * A decoded `PLATEREAD` operand: two fields packed into one byte (`usb.md` §3.1). Bits 0–5 are
 * one bit per optical channel; bit 7 picks how the head sweeps the plate.
 */
export interface ScanMask {
  /** The operand as an integer, exactly as recorded — never recomputed (`usb.md` §3.1). */
  raw: number;
  /** Selected optical channels, 1-based (`[1,2,3,4,5,6]` for `#h3F`, `[1]` for `#h81`). */
  channels: number[];
  /** True when bit 7 is set: the head scans continuously instead of stopping over each well. */
  flyover: boolean;
  /** Bits outside the two known fields (bit 6), 0 in every file seen. */
  unknownBits: number;
  /** One-line human summary, e.g. `all 6 channels, step-and-repeat`. */
  summary: string;
}

/** Decode a scan-mask byte into its two fields (`usb.md` §3.1). */
export function parseScanMask(raw: number): ScanMask {
  const channels: number[] = [];
  for (let i = 0; i < SCAN_MASK_CHANNELS; i++) if ((raw >> i) & 1) channels.push(i + 1);
  const flyover = (raw & SCAN_MASK_FLYOVER_BIT) !== 0;
  return {
    raw,
    channels,
    flyover,
    unknownBits: raw & ~(((1 << SCAN_MASK_CHANNELS) - 1) | SCAN_MASK_FLYOVER_BIT),
    summary: `${describeChannels(channels)}, ${flyover ? "flyover scan" : "step-and-repeat"}`,
  };
}

function describeChannels(channels: number[]): string {
  if (channels.length === 0) return "no channels";
  if (channels.length === SCAN_MASK_CHANNELS) return `all ${SCAN_MASK_CHANNELS} channels`;
  if (channels.length === 1) return `channel ${channels[0] as number} only`;
  return `channels ${channels.join(", ")}`;
}

/** The wire form of a scan mask: `#h` then uppercase hex, unpadded (`usb.md` §3.1). */
export function formatScanMaskOperand(raw: number): string {
  return `#h${raw.toString(16).toUpperCase()}`;
}

/** Read a `#h<hex>` operand (also accepting bare decimal), or null if it isn't one. */
export function parseScanMaskOperand(operand: string): number | null {
  const hex = /^#h([0-9a-f]+)$/i.exec(operand.trim());
  if (hex) return parseInt(hex[1] as string, 16);
  const dec = /^\d+$/.exec(operand.trim());
  return dec ? Number(dec[0]) : null;
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/** Every verb the grammar defines (`protocol.md` §3). */
export const RUN_DEFINITION_VERBS = [
  "METHOD",
  "HOTLID",
  "VOLUME",
  "TEMP",
  "GRAD",
  "MELT",
  "INC",
  "RATE",
  "EXT",
  "BEEP",
  "PLATEREAD",
  "GOTO",
  "END",
] as const;

export type RunDefinitionVerb = (typeof RUN_DEFINITION_VERBS)[number];

const VERB_SET: ReadonlySet<string> = new Set<string>(RUN_DEFINITION_VERBS);

/**
 * The verbs that take a numbered position in the step list `GOTO` counts (`protocol.md` §4).
 *
 * The setup header and `END` are not steps, and neither are the four **modifiers** — `INC`,
 * `RATE`, `EXT`, `BEEP` — which attach to the step they follow rather than standing as steps of
 * their own, and so are skipped when numbering.
 */
const STEP_VERBS: ReadonlySet<string> = new Set<string>([
  "TEMP",
  "GRAD",
  "MELT",
  "PLATEREAD",
  "GOTO",
]);

/** True if `verb` (any case) is one this grammar defines. */
export function isRunDefinitionVerb(verb: string): verb is RunDefinitionVerb {
  return VERB_SET.has(verb.toUpperCase());
}

/** What every decoded directive carries, whatever its verb. */
interface DirectiveBase {
  /** 0-based position in the directive list, including the setup header. */
  index: number;
  /** The directive's own source text, without its `;`. */
  text: string;
  /**
   * 1-based protocol step number, or undefined for a directive that isn't a step (the
   * `METHOD`/`HOTLID`/`VOLUME` header and the `END` terminator). This is the numbering `GOTO`
   * counts in — see `protocol.md` §4.
   */
  stepNumber?: number;
  /** One-line plain-English reading of this directive, for display beside it. */
  description: string;
}

/** `METHOD <name>` — names the thermal control method (`CALC` in every file seen). */
export interface MethodDirective extends DirectiveBase {
  verb: "METHOD";
  method: string;
}

/** `HOTLID <temp>,<shutoff>` — heated-lid setpoint and its shutoff temperature. */
export interface HotLidDirective extends DirectiveBase {
  verb: "HOTLID";
  lidTemperatureC: number;
  shutoffTemperatureC: number;
}

/** `VOLUME <µL>` — sample volume, which drives the instrument's thermal model. */
export interface VolumeDirective extends DirectiveBase {
  verb: "VOLUME";
  volumeUl: number;
}

/**
 * `TEMP <°C>,<seconds>` — hold one temperature. The grammar also allows the `INC` and `EXT`
 * modifiers to ride inline as extra operands (`TEMP 95.0,10,INC 0.5`); no file here uses that
 * form, but it decodes to the same thing as the separate directives (`protocol.md` §3.2).
 */
export interface TempDirective extends DirectiveBase {
  verb: "TEMP";
  tempC: number;
  holdSeconds: number;
  /** An inline `INC` modifier's °C, if this directive carried one. */
  incrementC?: number;
  /** An inline `EXT` modifier's seconds, if this directive carried one. */
  extendSeconds?: number;
}

/** `GRAD <low>,<high>,<seconds>` — hold a temperature gradient across the block's rows. */
export interface GradDirective extends DirectiveBase {
  verb: "GRAD";
  lowTempC: number;
  highTempC: number;
  holdSeconds: number;
  /** An inline `EXT` modifier's seconds, if this directive carried one. */
  extendSeconds?: number;
}

/**
 * `MELT <start>,<end>,<increment>,<hold>,#h<mask>` — a melt curve as one directive, the compact
 * alternative to the six-directive expansion every stored protocol here uses (`protocol.md` §6).
 */
export interface MeltDirective extends DirectiveBase {
  verb: "MELT";
  startTempC: number;
  endTempC: number;
  incrementC: number;
  holdSeconds: number;
  /** The operand as written, e.g. `#h3f`. */
  operand: string;
  /** The decoded mask, or undefined if the operand wasn't a recognizable one. */
  scanMask?: ScanMask;
}

/** `INC <°C>` — per-pass temperature increment applied to the preceding step. */
export interface IncDirective extends DirectiveBase {
  verb: "INC";
  incrementC: number;
}

/** `RATE <°C/s>` — ramp rate toward the preceding step's target. */
export interface RateDirective extends DirectiveBase {
  verb: "RATE";
  rateCPerSecond: number;
}

/** `EXT <seconds>` — lengthen (or, negative, shorten) the preceding step's hold each pass. */
export interface ExtDirective extends DirectiveBase {
  verb: "EXT";
  extendSeconds: number;
}

/** `BEEP` — sound the instrument's beeper when the preceding step completes. */
export interface BeepDirective extends DirectiveBase {
  verb: "BEEP";
}

/** `PLATEREAD #h<hex>` — read the plate, with the scan mask of `usb.md` §3.1. */
export interface PlateReadDirective extends DirectiveBase {
  verb: "PLATEREAD";
  /** The operand as written, e.g. `#h3F`. */
  operand: string;
  /** The decoded mask, or undefined if the operand wasn't a recognizable one. */
  scanMask?: ScanMask;
}

/** `GOTO <step>,<repeats>` — loop back to an earlier step. 1-based, unlike the XML form. */
export interface GotoDirective extends DirectiveBase {
  verb: "GOTO";
  /** 1-based target step number, matching {@link DirectiveBase.stepNumber}. */
  targetStep: number;
  /** Additional passes: the loop body runs `repeats + 1` times in total. */
  repeats: number;
}

/** `END` — closes the step list. */
export interface EndDirective extends DirectiveBase {
  verb: "END";
}

/** A directive whose verb this grammar doesn't define — kept rather than dropped. */
export interface UnknownDirective extends DirectiveBase {
  verb: "UNKNOWN";
  /** The verb as written, whatever it was. */
  rawVerb: string;
}

/** One decoded directive, discriminated by `verb`. */
export type RunDefinitionDirective =
  | MethodDirective
  | HotLidDirective
  | VolumeDirective
  | TempDirective
  | GradDirective
  | MeltDirective
  | IncDirective
  | RateDirective
  | ExtDirective
  | BeepDirective
  | PlateReadDirective
  | GotoDirective
  | EndDirective
  | UnknownDirective;

/** A decoded run definition: the directives, plus the settings the header carries. */
export interface RunDefinitionProgram {
  /** Every directive in source order, including the header and terminator. */
  directives: RunDefinitionDirective[];
  /** Just the numbered steps, in order — `directives.filter(d => d.stepNumber !== undefined)`. */
  steps: RunDefinitionDirective[];
  /** `METHOD`'s operand, or null if the text carries none. */
  method: string | null;
  /** `HOTLID`'s first operand, °C, or null. */
  lidTemperatureC: number | null;
  /** `HOTLID`'s second operand, °C, or null (`prcl.md` §3: mirrors `shutoffTemperature`). */
  shutoffTemperatureC: number | null;
  /** `VOLUME`'s operand, µL, or null. */
  volumeUl: number | null;
  /** Every distinct scan mask the program's `PLATEREAD` steps carry, in first-appearance order. */
  scanMasks: ScanMask[];
  /** Verbs found that the grammar doesn't define — empty for a well-formed protocol. */
  unknownVerbs: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Split a run definition on the grammar's `;` delimiter (and any line breaks a text form
 * added), dropping the empties a trailing `;` or a blank line leaves behind.
 */
export function splitRunDefinition(runDefinition: string): string[] {
  return runDefinition
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True for the verbs that take a numbered position in the step list (`protocol.md` §4). */
function isStepVerb(verb: string): boolean {
  return STEP_VERBS.has(verb);
}

const num = (s: string | undefined): number => {
  const v = Number((s ?? "").trim());
  return Number.isFinite(v) ? v : NaN;
};

/** `95` → `95`, `95.0` → `95` — the grammar writes trailing zeros the reader doesn't need. */
const degrees = (v: number): string => (Number.isFinite(v) ? String(v) : "?");

/**
 * Every hold in the grammar is a count of seconds, but a description is read by a person, so it
 * says the clock time instead: `TEMP 95.0,2700` describes itself as a 45:00 hold, not a 2700 s
 * one. {@link formatDuration} is shared with the views that show the same times elsewhere.
 */
const seconds = (v: number): string => formatDuration(v);

/**
 * `INC` and `EXT` may ride inside a `TEMP`/`GRAD` directive as extra comma-separated operands
 * (`TEMP 95.0,10,INC 0.5,EXT 5`) instead of following it as directives of their own — the two
 * spellings mean the same thing (`protocol.md` §3.2).
 */
function inlineModifiers(extra: string[]): { incrementC?: number; extendSeconds?: number } {
  const out: { incrementC?: number; extendSeconds?: number } = {};
  for (const arg of extra) {
    const m = /^(INC|EXT)\s+(\S+)$/i.exec(arg.trim());
    if (!m) continue;
    const value = num(m[2]);
    if (!Number.isFinite(value)) continue;
    if ((m[1] as string).toUpperCase() === "INC") out.incrementC = value;
    else out.extendSeconds = value;
  }
  return out;
}

function describeInlineModifiers(m: { incrementC?: number; extendSeconds?: number }): string {
  const parts: string[] = [];
  if (m.incrementC !== undefined) parts.push(`${degrees(m.incrementC)} °C`);
  if (m.extendSeconds !== undefined) parts.push(seconds(m.extendSeconds));
  return parts.length > 0 ? `, then ${parts.join(" and ")} more on each pass` : "";
}

/**
 * Decode a `;`-delimited run definition into typed directives with step numbers and
 * descriptions.
 *
 * Tolerant by design: an unrecognized verb becomes an {@link UnknownDirective} rather than an
 * error, so a partly-understood protocol still displays. {@link parseRunDefinitionText} is the
 * strict door, for text a user picked off disk.
 */
export function parseRunDefinition(runDefinition: string): RunDefinitionProgram {
  const parts = splitRunDefinition(runDefinition);
  const directives: RunDefinitionDirective[] = [];
  const unknownVerbs: string[] = [];
  let stepNumber = 0;

  parts.forEach((text, index) => {
    const rawVerb = /^[A-Za-z]+/.exec(text)?.[0] ?? "";
    const verb = rawVerb.toUpperCase();
    const operand = text.slice(rawVerb.length).trim();
    const args = operand.length > 0 ? operand.split(",").map((s) => s.trim()) : [];
    const known = isRunDefinitionVerb(verb);
    const base: DirectiveBase = {
      index,
      text,
      description: "",
      ...(known && isStepVerb(verb) ? { stepNumber: ++stepNumber } : {}),
    };

    switch (known ? (verb as RunDefinitionVerb) : "") {
      case "METHOD":
        directives.push({
          ...base,
          verb: "METHOD",
          method: operand,
          description: describeMethod(operand),
        });
        break;
      case "HOTLID": {
        const lidTemperatureC = num(args[0]);
        const shutoffTemperatureC = num(args[1]);
        directives.push({
          ...base,
          verb: "HOTLID",
          lidTemperatureC,
          shutoffTemperatureC,
          description:
            // `HOTLID 0,30` is a *disabled* lid heater, not a 0 °C setpoint: the directive is
            // never omitted, so off is said with a zero operand while the second operand keeps
            // its constant `30` (`protocol.md` §3.1). Reading it as "heated lid at 0 °C" would
            // describe the one case the number isn't a temperature.
            (lidTemperatureC === 0
              ? "Heated lid off"
              : `Heated lid at ${degrees(lidTemperatureC)} °C`) +
            (lidTemperatureC !== 0 && Number.isFinite(shutoffTemperatureC)
              ? `, off below ${degrees(shutoffTemperatureC)} °C`
              : ""),
        });
        break;
      }
      case "VOLUME": {
        const volumeUl = num(args[0]);
        directives.push({
          ...base,
          verb: "VOLUME",
          volumeUl,
          // `VOLUME 0` is "no thermal model" — the directive is written out even for a method
          // that ignores it, and `METHOD` is derived from it (`protocol.md` §3.1).
          description:
            volumeUl === 0
              ? "No sample volume — block temperature is controlled directly (METHOD BLOCK)"
              : `Sample volume ${degrees(volumeUl)} µL — sets the thermal model`,
        });
        break;
      }
      case "TEMP": {
        const tempC = num(args[0]);
        const holdSeconds = num(args[1]);
        const inline = inlineModifiers(args.slice(2));
        directives.push({
          ...base,
          verb: "TEMP",
          tempC,
          holdSeconds,
          ...inline,
          description:
            (holdSeconds === 0
              ? `Hold ${degrees(tempC)} °C indefinitely`
              : `Hold ${degrees(tempC)} °C for ${seconds(holdSeconds)}`) +
            describeInlineModifiers(inline),
        });
        break;
      }
      case "GRAD": {
        const lowTempC = num(args[0]);
        const highTempC = num(args[1]);
        const holdSeconds = num(args[2]);
        const inline = inlineModifiers(args.slice(3));
        directives.push({
          ...base,
          verb: "GRAD",
          lowTempC,
          highTempC,
          holdSeconds,
          ...inline,
          description:
            `Gradient ${degrees(lowTempC)}–${degrees(highTempC)} °C across the block's rows ` +
            `for ${seconds(holdSeconds)}` +
            describeInlineModifiers(inline),
        });
        break;
      }
      case "MELT": {
        const startTempC = num(args[0]);
        const endTempC = num(args[1]);
        const incrementC = num(args[2]);
        const holdSeconds = num(args[3]);
        const maskOperand = (args[4] ?? "").trim();
        const raw = parseScanMaskOperand(maskOperand);
        const scanMask = raw === null ? undefined : parseScanMask(raw);
        directives.push({
          ...base,
          verb: "MELT",
          startTempC,
          endTempC,
          incrementC,
          holdSeconds,
          operand: maskOperand,
          scanMask,
          description:
            `Melt from ${degrees(startTempC)} to ${degrees(endTempC)} °C in ` +
            `${degrees(incrementC)} °C steps, holding ${seconds(holdSeconds)} and reading ` +
            (scanMask ? scanMask.summary : `scan mask "${maskOperand}"`),
        });
        break;
      }
      case "EXT": {
        const extendSeconds = num(args[0]);
        directives.push({
          ...base,
          verb: "EXT",
          extendSeconds,
          description:
            extendSeconds < 0
              ? `Shorten the previous step's hold by ${seconds(-extendSeconds)} on each pass`
              : `Extend the previous step's hold by ${seconds(extendSeconds)} on each pass`,
        });
        break;
      }
      case "BEEP":
        directives.push({
          ...base,
          verb: "BEEP",
          description: "Beep when the previous step completes",
        });
        break;
      case "INC": {
        const incrementC = num(args[0]);
        directives.push({
          ...base,
          verb: "INC",
          incrementC,
          description: `Raise the previous step by ${degrees(incrementC)} °C on each pass`,
        });
        break;
      }
      case "RATE": {
        const rateCPerSecond = num(args[0]);
        directives.push({
          ...base,
          verb: "RATE",
          rateCPerSecond,
          description: `Ramp toward the previous step at ${degrees(rateCPerSecond)} °C/s`,
        });
        break;
      }
      case "PLATEREAD": {
        const raw = parseScanMaskOperand(operand);
        const scanMask = raw === null ? undefined : parseScanMask(raw);
        directives.push({
          ...base,
          verb: "PLATEREAD",
          operand,
          scanMask,
          description: scanMask
            ? `Read the plate — ${scanMask.summary}`
            : `Read the plate (unrecognized scan mask "${operand}")`,
        });
        break;
      }
      case "GOTO": {
        const targetStep = num(args[0]);
        const repeats = num(args[1]);
        directives.push({ ...base, verb: "GOTO", targetStep, repeats, description: "" });
        break;
      }
      case "END":
        directives.push({ ...base, verb: "END", description: "End of the protocol" });
        break;
      default:
        if (rawVerb) unknownVerbs.push(rawVerb);
        directives.push({
          ...base,
          verb: "UNKNOWN",
          rawVerb,
          description: "Not a directive this decoder knows",
        });
        break;
    }
  });

  // GOTO's description names what it loops back to, which needs the whole list first.
  const byStep = new Map<number, RunDefinitionDirective>();
  for (const d of directives) if (d.stepNumber !== undefined) byStep.set(d.stepNumber, d);
  for (const d of directives) {
    if (d.verb !== "GOTO") continue;
    const target = byStep.get(d.targetStep);
    const passes = Number.isFinite(d.repeats) ? d.repeats + 1 : NaN;
    d.description =
      `Return to step ${degrees(d.targetStep)}` +
      (target ? ` (${target.text})` : "") +
      (Number.isFinite(passes) ? ` — ${passes} passes in total` : "");
  }

  const header = (verb: string) => directives.find((d) => d.verb === verb);
  const hotlid = header("HOTLID") as HotLidDirective | undefined;
  const method = header("METHOD") as MethodDirective | undefined;
  const volume = header("VOLUME") as VolumeDirective | undefined;

  const scanMasks: ScanMask[] = [];
  for (const d of directives) {
    if (d.verb !== "PLATEREAD" && d.verb !== "MELT") continue;
    if (!d.scanMask) continue;
    if (!scanMasks.some((m) => m.raw === d.scanMask!.raw)) scanMasks.push(d.scanMask);
  }

  return {
    directives,
    steps: directives.filter((d) => d.stepNumber !== undefined),
    method: method?.method || null,
    lidTemperatureC: finiteOrNull(hotlid?.lidTemperatureC),
    shutoffTemperatureC: finiteOrNull(hotlid?.shutoffTemperatureC),
    volumeUl: finiteOrNull(volume?.volumeUl),
    scanMasks,
    unknownVerbs,
  };
}

function finiteOrNull(v: number | undefined): number | null {
  return v !== undefined && Number.isFinite(v) ? v : null;
}

/**
 * `CALC` is the only method any file or capture here carries; `BLOCK` also appears in the
 * instrument's idle `STATUS?` response (`usb.md` §3), and the two read as sample-temperature vs.
 * block-temperature control. `OTHER` is the language's third value and is unexercised here.
 * See `protocol.md` §3.2, and §9 for what stays unmeasured.
 */
function describeMethod(method: string): string {
  switch (method.toUpperCase()) {
    case "CALC":
      return "Control the calculated sample temperature (not the block's own)";
    case "BLOCK":
      return "Control the block temperature directly";
    case "OTHER":
      return "Thermal control method OTHER";
    default:
      return method ? `Thermal control method ${method}` : "Thermal control method";
  }
}

// ---------------------------------------------------------------------------
// Execution counting
// ---------------------------------------------------------------------------

/**
 * A safety valve for {@link expectedPlateReads}: a malformed `GOTO` (one that jumps forward, or
 * back onto itself) can describe a loop that never terminates, and this function is called on
 * protocol text that came off an instrument rather than out of the editor. Well above any real
 * protocol — the largest in this project's corpus executes a few hundred steps.
 */
const MAX_SIMULATED_STEPS = 1_000_000;

/**
 * How many plate reads a protocol *should* produce, by executing its `GOTO` loops on paper.
 *
 * This is the number an archive's `Read0000N.Plateread` count is compared against to decide that
 * a run stopped short (`runFolder.ts`'s `runCompleteness`, `usb.md` §7.8 step 6): a cancelled run
 * is not marked as such anywhere in its own files, so "fewer reads than the protocol asked for"
 * is what says it. It follows that being *wrong* here mislabels an honest run, so the function
 * answers `null` — "can't say" — rather than guessing, in three cases:
 *
 * - **No `PLATEREAD` at all.** A thermal-only protocol produces no reads by design and nothing
 *   about it can be short.
 * - **A compact `MELT` directive.** One directive stands for a whole melt curve and its read
 *   count follows from operands this project has never seen an instance of (`protocol.md` §3.2
 *   marks the form *stated*, not measured), so any number here would be invented. Protocols that
 *   spell a melt out the long way (§6) are an ordinary `PLATEREAD` inside a `GOTO` loop and are
 *   counted exactly.
 * - **A loop that doesn't terminate** within {@link MAX_SIMULATED_STEPS}.
 *
 * `ADDCYCLES` is *not* a reason to answer `null`: it can only extend a loop, so a run that used
 * it produces *more* reads than this, and more is never reported as short.
 *
 * The simulation is the one `protocol.md` §4 describes — step numbers are 1-based and count only
 * steps, `GOTO <step>,<repeats>` runs its body `repeats + 1` times, and an inner loop's counter
 * resets when it is exhausted so that an enclosing loop re-entering it gets its full count again.
 */
export function expectedPlateReads(runDefinition: string): number | null {
  const { steps, directives } = parseRunDefinition(runDefinition);
  if (directives.some((d) => d.verb === "MELT")) return null;
  if (!steps.some((d) => d.verb === "PLATEREAD")) return null;

  /** Passes already taken through each `GOTO`, keyed by that `GOTO`'s own step number. */
  const taken = new Map<number, number>();
  let reads = 0;
  let pc = 0;
  for (let executed = 0; pc < steps.length; executed++) {
    if (executed >= MAX_SIMULATED_STEPS) return null;
    const step = steps[pc]!;
    if (step.verb === "PLATEREAD") reads++;
    if (step.verb === "GOTO" && Number.isFinite(step.repeats) && step.repeats > 0) {
      const self = step.stepNumber!;
      const already = taken.get(self) ?? 0;
      if (already < step.repeats) {
        taken.set(self, already + 1);
        // `targetStep` is 1-based and indexes `steps`, which holds exactly the numbered
        // directives in order — so step *n* is `steps[n - 1]`.
        const target = step.targetStep - 1;
        if (!Number.isInteger(target) || target < 0 || target >= steps.length) return null;
        pc = target;
        continue;
      }
      // Exhausted: forget it, so an enclosing loop that comes back round re-runs it in full.
      taken.delete(self);
    }
    pc++;
  }
  return reads;
}
