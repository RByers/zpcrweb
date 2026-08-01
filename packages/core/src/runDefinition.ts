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
  "INC",
  "RATE",
  "PLATEREAD",
  "GOTO",
  "END",
] as const;

export type RunDefinitionVerb = (typeof RUN_DEFINITION_VERBS)[number];

const VERB_SET: ReadonlySet<string> = new Set<string>(RUN_DEFINITION_VERBS);

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

/** `TEMP <°C>,<seconds>` — hold one temperature. */
export interface TempDirective extends DirectiveBase {
  verb: "TEMP";
  tempC: number;
  holdSeconds: number;
}

/** `GRAD <low>,<high>,<seconds>` — hold a temperature gradient across the block's rows. */
export interface GradDirective extends DirectiveBase {
  verb: "GRAD";
  lowTempC: number;
  highTempC: number;
  holdSeconds: number;
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
  | IncDirective
  | RateDirective
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

/** Directives that are not numbered steps: the setup header and the terminator. */
function isStepVerb(verb: string): boolean {
  return verb !== "METHOD" && verb !== "HOTLID" && verb !== "VOLUME" && verb !== "END";
}

const num = (s: string | undefined): number => {
  const v = Number((s ?? "").trim());
  return Number.isFinite(v) ? v : NaN;
};

/** `95` → `95`, `95.0` → `95` — the grammar writes trailing zeros the reader doesn't need. */
const degrees = (v: number): string => (Number.isFinite(v) ? String(v) : "?");

const seconds = (v: number): string => (Number.isFinite(v) ? `${v} s` : "? s");

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
            `Heated lid at ${degrees(lidTemperatureC)} °C` +
            (Number.isFinite(shutoffTemperatureC)
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
          description: `Sample volume ${degrees(volumeUl)} µL — sets the thermal model`,
        });
        break;
      }
      case "TEMP": {
        const tempC = num(args[0]);
        const holdSeconds = num(args[1]);
        directives.push({
          ...base,
          verb: "TEMP",
          tempC,
          holdSeconds,
          description:
            holdSeconds === 0
              ? `Hold ${degrees(tempC)} °C indefinitely`
              : `Hold ${degrees(tempC)} °C for ${seconds(holdSeconds)}`,
        });
        break;
      }
      case "GRAD": {
        const lowTempC = num(args[0]);
        const highTempC = num(args[1]);
        const holdSeconds = num(args[2]);
        directives.push({
          ...base,
          verb: "GRAD",
          lowTempC,
          highTempC,
          holdSeconds,
          description:
            `Gradient ${degrees(lowTempC)}–${degrees(highTempC)} °C across the block's rows ` +
            `for ${seconds(holdSeconds)}`,
        });
        break;
      }
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
    if (d.verb !== "PLATEREAD" || !d.scanMask) continue;
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
 * `CALC` is the only method any file or capture here carries; `BLOCK` appears in the
 * instrument's idle `STATUS?` response (`usb.md` §3), which is what makes the pair readable as
 * sample-temperature vs. block-temperature control. See `protocol.md` §6.
 */
function describeMethod(method: string): string {
  switch (method.toUpperCase()) {
    case "CALC":
      return "Control the calculated sample temperature (not the block's own)";
    case "BLOCK":
      return "Control the block temperature directly";
    default:
      return method ? `Thermal control method ${method}` : "Thermal control method";
  }
}
