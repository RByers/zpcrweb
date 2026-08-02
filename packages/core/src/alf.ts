/**
 * The `.alf` run report — the instrument's own account of what the block actually did during a
 * run. See `alf.md` for the format; this decodes it.
 *
 * A `*`-delimited ASCII text file with four line roles fixed by position (`alf.md` §2): a run
 * header, the protocol as executed, an error summary, and one line per *executed* step, ending
 * on a zeroed sentinel. There is no fluorescence and nothing per-well in it — what it uniquely
 * carries is **timing**: each step line's timestamp is the wall-clock moment that step began
 * (`alf.md` §7.4), which is the only per-step timing record the instrument produces.
 *
 * Two fields are deliberately not interpreted here, because the format doc says they can't yet
 * be: the fourth step column, labelled a ramp time and not behaving like one (`alf.md` §8), is
 * carried through as {@link AlfStep.rampTimeField} with no meaning attached, and the error
 * line's failure encodings (`alf.md` §6) are unobserved, so flags are tested for the literal
 * `True` and the raw code list is left as text.
 *
 * The protocol line is the same grammar every other carrier holds, so it is normalized to the
 * `;` delimiter {@link parseRunDefinition} reads and handed on rather than re-parsed here
 * (`protocol.md` §8 tabulates the carriers' differences).
 */

/** True for an archive entry that is a run report. */
export function isAlfName(name: string): boolean {
  return /\.alf$/i.test(name);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Line 1 — the run's identity, as the instrument recorded it (`alf.md` §4). */
export interface AlfHeader {
  /**
   * Field 1. **Not always a run name**: `RemoteRun`'s name uppercased for a PC-started run, but
   * the *path of the selected protocol* for one started at the touchscreen (`alf.md` §4).
   * {@link runName} is the basename either way.
   */
  protocolName: string;
  /** {@link protocolName} reduced to a basename — what to show someone. */
  runName: string;
  /** Field 2 — empty for runs started at the instrument's own touchscreen. */
  user: string;
  /** Field 3 — the block (alpha) serial, matching `ALPHASN?` / `RunInfo.xml`'s `AlphaSerialNumber`. */
  blockSerial: string;
  /** Field 4 — the block letter `RemoteRun` takes. */
  blockLetter: string;
  /** Field 5 — the plate/block type, e.g. `CFX96`. */
  blockType: string;
  /** Field 6, verbatim: an en-US month abbreviation, e.g. `Jul 25, 2026`. */
  dateBegan: string;
  /** Field 7 — 24-hour instrument-local time, no zone. */
  timeBegan: string;
  /** Field 8 — same. */
  timeEnd: string;
  /** Field 9 — `hh:mm:ss`. */
  totalElapsed: string;
  /** Field 9 as seconds, or null if it isn't `hh:mm:ss`. */
  totalElapsedSeconds: number | null;
  /** Field 10 — the `HOTLID` setpoint, not a measurement. */
  lidTemperatureC: number | null;
  /** Field 11 — the `VOLUME` setpoint, µL. */
  sampleVolumeUl: number | null;
  /** Field 12 — `RemoteRun`'s operand 6; empty in every sample seen. */
  sampleId: string;
  /** Field 13 — defaults to the base serial when the cycler was never renamed. */
  cyclerName: string;
  /** Field 14 — the base-unit serial, matching `*IDN?` / `BASESN?`. */
  baseSerial: string;
  /** Field 15 — empty in every sample seen (`alf.md` §4). */
  lidPressure: string;
  /**
   * Fields 6+7 as a `Date` in the *host's* zone. The file states no zone, so this is only the
   * instrument's local clock reinterpreted locally — right when the two agree, off by the
   * offset when they don't. Null if either field is unparseable.
   */
  startedAt: Date | null;
}

/** Line 3 — the error summary (`alf.md` §6). Every observed run is clean, so only the shape is certain. */
export interface AlfErrorSummary {
  /** Field 1, verbatim — the leading/trailing spaces are the file's, not ours. */
  text: string;
  /** Field 2 — a `:`-separated code list. Only the empty case (`0:`) is observed; left as text. */
  rawErrors: string;
  /** Field 3. */
  powerFailed: boolean;
  /** Field 4. */
  userAborted: boolean;
  /** Field 5. */
  errorOccurred: boolean;
  /** Field 6 — paired with {@link emulationMode}. */
  emulationUsed: boolean;
  /** Field 7 — `None` when unused. */
  emulationMode: string;
  /** Field 8. */
  criticalError: boolean;
  /** True when any flag is set or the code list isn't the empty `0:` — i.e. worth looking at. */
  clean: boolean;
}

/** What a step line's temperature field (field 5) says (`alf.md` §7). */
export type AlfSetpoint =
  | { kind: "temperature"; tempC: number }
  /** A `GRAD` step, written `low;high` as integers. */
  | { kind: "gradient"; lowC: number; highC: number }
  /** The literal `Plate Read` — an optical step, which has no setpoint. */
  | { kind: "plateRead" }
  /** Anything else, including the sentinel's `0`. */
  | { kind: "other" };

/** One executed step (`alf.md` §7) — one line, one *execution*, not one protocol step. */
export interface AlfStep {
  /** 0-based position among the step lines, sentinel included. */
  index: number;
  /** Field 2 — the 1-based pass through the loop block executing now; resets at a stage boundary. */
  repeat: number;
  /** Field 3 — the protocol's 1-based step index, numbered as `protocol.md` §4 defines it. */
  stepNumber: number;
  /**
   * Field 4, carried through **uninterpreted**. CFX Manager calls it `RAMPTIME` and it does not
   * behave like one — `alf.md` §8 has the measurements. Use {@link elapsedSeconds} instead;
   * nothing in this library reads this.
   */
  rampTimeField: number | null;
  /** Field 5, verbatim. */
  setpointText: string;
  /** Field 5, decoded. */
  setpoint: AlfSetpoint;
  /** Field 6 — the step's *nominal* hold, seconds; the protocol's number, not the time held. */
  holdSeconds: number | null;
  /** Field 7, verbatim (`MM/DD/YYYY HH:MM:SS`), without the sentinel's trailing phrase. */
  timestampText: string;
  /** Field 7 as a `Date` — see {@link AlfHeader.startedAt} on the zone. */
  startedAt: Date | null;
  /** Field 8. */
  paused: boolean;
  /** Field 9 — seconds. */
  pausedSeconds: number | null;
  /**
   * Wall time this step occupied, ramp included: the *next* line's timestamp minus this one's
   * (`alf.md` §7.4 — the report never states a duration). Null on the last step before the
   * sentinel is absent, and on the sentinel itself.
   */
  elapsedSeconds: number | null;
  /**
   * 1-based stage, incremented wherever {@link repeat} goes backwards — the only stage boundary
   * the file marks (`alf.md` §7.2).
   */
  stage: number;
  /**
   * For a `Plate Read` line, its 1-based position among them — which is its position among the
   * archive's `Read0000N.Plateread` files, 1:1 and in order (`alf.md` §7.5). Undefined otherwise.
   */
  readIndex?: number;
  /** True for the zeroed end-of-run sentinel (`step == 0`, `alf.md` §7.3). */
  sentinel: boolean;
}

/** A decoded `.alf` run report. */
export interface AlfReport {
  header: AlfHeader;
  /**
   * Line 2 — the protocol as *executed*, normalized from the file's `*` delimiter to the `;`
   * every other carrier uses, so it feeds `parseRunDefinition` directly (`alf.md` §5).
   */
  runDefinition: string;
  errors: AlfErrorSummary;
  /** The executed-step log, sentinel excluded. */
  steps: AlfStep[];
  /** The end-of-run sentinel line, or null if the report is truncated (`alf.md` §7.3). */
  sentinel: AlfStep | null;
  /**
   * The sentinel's trailing status phrase — `Protocol completed.` in every sample. Null when
   * there is no sentinel or it carries no phrase.
   */
  completionPhrase: string | null;
  /** How many `Plate Read` lines the log holds — the read count to expect in the archive (§7.5). */
  plateReadCount: number;
  /** Lines that didn't have the field count their role calls for; empty for a well-formed report. */
  problems: string[];
}

/** A `.alf` archive entry paired with its decoded run report. */
export interface AlfEntry {
  /** Archive entry name, e.g. `20260725_124811_CT019138_GRADIENTTEST.alf`. */
  name: string;
  /** The parsed report. */
  alf: AlfReport;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const num = (s: string | undefined): number | null => {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

/** `alf.md` §6: test for the literal `True`; anything else is false. */
const flag = (s: string | undefined): boolean => (s ?? "").trim() === "True";

/**
 * Split one line on `*`, dropping the single empty token every line's terminating `*` leaves
 * behind (`alf.md` §2).
 */
function fields(line: string): string[] {
  const parts = line.split("*");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * The header is the exception (`alf.md` §4): its 15th field — lid pressure — is empty in every
 * sample, so its terminating `*` and an empty last field are indistinguishable. Reading it as
 * "15 fields, last one empty" makes both readings agree, which is why the trailing token is
 * kept here and dropped everywhere else.
 */
function headerFieldsOf(line: string): string[] {
  return line.split("*");
}

/** `hh:mm:ss` → seconds. */
function elapsedToSeconds(text: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** `MM/DD/YYYY HH:MM:SS`, read as a local-clock reading — see {@link AlfHeader.startedAt}. */
function parseStepTimestamp(text: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(
    Number(m[3]),
    Number(m[1]) - 1,
    Number(m[2]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The header's `Jul 25, 2026` + `12:48:11`, same caveat. */
function parseHeaderTimestamp(date: string, time: string): Date | null {
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time.trim());
  if (!t) return null;
  const day = new Date(`${date.trim()} 00:00:00`);
  if (Number.isNaN(day.getTime())) return null;
  day.setHours(Number(t[1]), Number(t[2]), Number(t[3]), 0);
  return day;
}

/** `\Storage Card\Recent\Luna_noRT` → `Luna_noRT`; a plain name is returned unchanged. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? path).trim();
}

function parseSetpoint(text: string): AlfSetpoint {
  const t = text.trim();
  if (/^plate\s*read$/i.test(t)) return { kind: "plateRead" };
  const grad = /^(-?\d+(?:\.\d+)?);(-?\d+(?:\.\d+)?)$/.exec(t);
  if (grad) return { kind: "gradient", lowC: Number(grad[1]), highC: Number(grad[2]) };
  const v = num(t);
  return v === null ? { kind: "other" } : { kind: "temperature", tempC: v };
}

const HEADER_FIELDS = 15;
const ERROR_FIELDS = 8;
const STEP_FIELDS = 9;

/**
 * Decode a `.alf` run report. Tolerant by design, like {@link parseRunDefinition}: a line with
 * the wrong field count is decoded as far as it goes and noted in {@link AlfReport.problems},
 * so a partly-understood report still displays.
 *
 * @param data the file's bytes (it is pure ASCII, `alf.md` §2) or its text.
 */
export function parseAlf(data: Uint8Array | ArrayBuffer | string): AlfReport {
  const text =
    typeof data === "string"
      ? data
      : new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const problems: string[] = [];

  const headerFields = headerFieldsOf(lines[0] ?? "");
  if (lines.length === 0) problems.push("Empty file — no run header.");
  else if (headerFields.length !== HEADER_FIELDS) {
    problems.push(`Header line has ${headerFields.length} fields, expected ${HEADER_FIELDS}.`);
  }
  const f = (i: number): string => headerFields[i] ?? "";
  const protocolName = f(0);
  const header: AlfHeader = {
    protocolName,
    runName: baseName(protocolName),
    user: f(1),
    blockSerial: f(2),
    blockLetter: f(3),
    blockType: f(4),
    dateBegan: f(5),
    timeBegan: f(6),
    timeEnd: f(7),
    totalElapsed: f(8),
    totalElapsedSeconds: elapsedToSeconds(f(8)),
    lidTemperatureC: num(f(9)),
    sampleVolumeUl: num(f(10)),
    sampleId: f(11),
    cyclerName: f(12),
    baseSerial: f(13),
    lidPressure: f(14),
    startedAt: parseHeaderTimestamp(f(5), f(6)),
  };

  // Line 2 — the same grammar as every other carrier, re-delimited (`alf.md` §5).
  const runDefinition = fields(lines[1] ?? "")
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .join(";");

  const errorFields = fields(lines[2] ?? "");
  if (lines.length > 2 && errorFields.length !== ERROR_FIELDS) {
    problems.push(`Error line has ${errorFields.length} fields, expected ${ERROR_FIELDS}.`);
  }
  const e = (i: number): string => errorFields[i] ?? "";
  const errors: AlfErrorSummary = {
    text: e(0),
    rawErrors: e(1),
    powerFailed: flag(e(2)),
    userAborted: flag(e(3)),
    errorOccurred: flag(e(4)),
    emulationUsed: flag(e(5)),
    emulationMode: e(6),
    criticalError: flag(e(7)),
    clean: false,
  };
  errors.clean =
    !errors.powerFailed &&
    !errors.userAborted &&
    !errors.errorOccurred &&
    !errors.criticalError &&
    /^0:?$/.test(errors.rawErrors.trim());

  const all: AlfStep[] = [];
  let stage = 1;
  let lastRepeat = 0;
  let plateReadCount = 0;
  let completionPhrase: string | null = null;

  lines.slice(3).forEach((line, index) => {
    const s = fields(line);
    if (s.length !== STEP_FIELDS) {
      problems.push(`Step line ${index + 4} has ${s.length} fields, expected ${STEP_FIELDS}.`);
    }
    const g = (i: number): string => s[i] ?? "";
    const repeat = num(g(1)) ?? 0;
    const stepNumber = num(g(2)) ?? 0;
    // The sentinel is `step == 0`, not the phrase — a run that didn't complete carries some
    // other phrase (`alf.md` §7.3).
    const sentinel = stepNumber === 0;

    // Field 7 is a timestamp alone on a step line, and a timestamp plus a status phrase on the
    // sentinel (`alf.md` §7.3).
    const stamp = g(6).trim();
    const split = /^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*(.*)$/.exec(stamp);
    const timestampText = split ? (split[1] as string) : stamp;
    if (sentinel && split && split[2]) completionPhrase = split[2];

    if (!sentinel && repeat < lastRepeat) stage += 1;
    if (!sentinel) lastRepeat = repeat;

    const setpoint = parseSetpoint(g(4));
    const step: AlfStep = {
      index,
      repeat,
      stepNumber,
      rampTimeField: num(g(3)),
      setpointText: g(4),
      setpoint,
      holdSeconds: num(g(5)),
      timestampText,
      startedAt: parseStepTimestamp(timestampText),
      paused: flag(g(7)),
      pausedSeconds: num(g(8)),
      elapsedSeconds: null,
      stage,
      ...(!sentinel && setpoint.kind === "plateRead" ? { readIndex: ++plateReadCount } : {}),
      sentinel,
    };
    all.push(step);
  });

  // A step's duration is the next line's timestamp minus its own — the sentinel's included,
  // since it timestamps the end of the run (`alf.md` §7.4).
  for (let i = 0; i < all.length - 1; i++) {
    const a = (all[i] as AlfStep).startedAt;
    const b = (all[i + 1] as AlfStep).startedAt;
    if (a && b) (all[i] as AlfStep).elapsedSeconds = Math.round((b.getTime() - a.getTime()) / 1000);
  }

  const sentinelStep = all.length > 0 && (all[all.length - 1] as AlfStep).sentinel
    ? (all[all.length - 1] as AlfStep)
    : null;
  if (all.length > 0 && !sentinelStep) problems.push("No end-of-run sentinel line — report truncated?");

  return {
    header,
    runDefinition,
    errors,
    steps: sentinelStep ? all.slice(0, -1) : all,
    sentinel: sentinelStep,
    completionPhrase,
    plateReadCount,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The thermal profile (`alf.md` §7.6)
// ---------------------------------------------------------------------------

/** What the block was doing over one span of a {@link ThermalProfile} (`alf.md` §7.6). */
export type ThermalPhase =
  /** Moving to this step's setpoint: `took − hold` seconds, ending there. */
  | "ramp"
  /** Sitting at it: the step's nominal `hold`. */
  | "hold"
  /** A `Plate Read`, which has no setpoint — the block stays wherever it already was. */
  | "read";

/** One span of the reconstructed block-temperature trace. */
export interface ThermalSegment {
  /** Seconds since the first logged step began. */
  startSeconds: number;
  /** Seconds since the first logged step began. Equal to {@link startSeconds} where the log's
   * whole-second timestamps make the span zero-length. */
  endSeconds: number;
  phase: ThermalPhase;
  /** Block temperature at {@link startSeconds}. Equals {@link toC} except on a `ramp`. */
  fromC: number;
  /** Block temperature at {@link endSeconds}. */
  toC: number;
  /** For a `GRAD` step, the span the block was spread across across the plate's rows; the
   * segment's own `fromC`/`toC` carry its midpoint, which is what one line can plot. */
  gradient?: { lowC: number; highC: number };
  /** The step line this span came from. */
  step: AlfStep;
}

/** A `Plate Read` as a point on the trace, carrying the index that names its `.Plateread`. */
export interface ThermalRead {
  /** 1-based, i.e. {@link AlfStep.readIndex} — the archive's `Read0000N.Plateread` (§7.5). */
  readIndex: number;
  /** When the read began, seconds since the first logged step. */
  atSeconds: number;
  /** When it ended — ~12 s later in practice (§7.4). */
  endSeconds: number;
  /** What the block was holding at: the *previous* step's setpoint, a read having none. */
  temperatureC: number;
  step: AlfStep;
}

/** The block-temperature-against-time trace a run report implies (`alf.md` §7.6). */
export interface ThermalProfile {
  /** The trace, in time order, contiguous except where a step's setpoint was unreadable. */
  segments: ThermalSegment[];
  /** Every `Plate Read`, in order. */
  reads: ThermalRead[];
  /** Length of the run in seconds — the sentinel's timestamp, or the last segment's end. */
  totalSeconds: number;
  /** Lowest / highest temperature the trace reaches, gradient spans included; null when no
   * segment was plottable at all. */
  range: { minC: number; maxC: number } | null;
  /**
   * How many steps' nominal hold outran the wall time they occupied, making `took − hold`
   * negative — clamped to a zero-length ramp. Timestamps are whole seconds (§7.4), so a 1 s
   * overrun is rounding; more than that says the log and the protocol disagree about that step.
   */
  clampedSteps: number;
}

/** The one temperature a segment plots for a step: its setpoint, or a gradient's midpoint. */
function segmentTemperature(step: AlfStep): number | null {
  switch (step.setpoint.kind) {
    case "temperature":
      return step.setpoint.tempC;
    case "gradient":
      return (step.setpoint.lowC + step.setpoint.highC) / 2;
    default:
      return null;
  }
}

/**
 * Reconstruct what the block temperature did over the run, as a sequence of ramp and hold spans
 * (`alf.md` §7.6).
 *
 * The report states no duration and no ramp anywhere. A step line carries the moment it *began*
 * (§7.4) and its *nominal* hold, so the wall time it occupied is the next line's timestamp minus
 * its own ({@link AlfStep.elapsedSeconds}), and what that time went on decomposes as
 *
 * ```
 * ramp = took − hold   (the block travelling to this step's setpoint)
 * hold = the step's own hold field   (the block sitting at it)
 * ```
 *
 * ramp first, since the hold cannot begin before the block arrives. Both halves are derived, not
 * read: the file's fourth column is labelled a ramp time and does not behave like one (§8), which
 * is exactly why this differences timestamps instead.
 *
 * Two spans are not ramps despite running longer than their hold. A `Plate Read` has no setpoint
 * — the block stays where the previous step left it for the ~12 s the read takes, so its whole
 * span is emitted as a `read` at that temperature. And the **first** step's ramp is dropped: the
 * report never says what the block was at before the run, so there is no temperature to draw that
 * ramp from, and the trace instead begins where it ends.
 */
export function alfThermalProfile(report: AlfReport): ThermalProfile {
  const segments: ThermalSegment[] = [];
  const reads: ThermalRead[] = [];
  let clampedSteps = 0;

  const origin = report.steps.find((s) => s.startedAt)?.startedAt ?? null;
  if (!origin) return { segments, reads, totalSeconds: 0, range: null, clampedSteps };
  const at = (d: Date): number => Math.round((d.getTime() - origin.getTime()) / 1000);

  // Where the block is now — null until the first step with a readable setpoint, which is what
  // suppresses the leading ramp.
  let blockC: number | null = null;
  let end = 0;

  for (const step of report.steps) {
    if (!step.startedAt) continue;
    const start = at(step.startedAt);
    // A truncated report leaves its last step untimed; falling back to the nominal hold draws
    // that step rather than stopping one short of it.
    const took = step.elapsedSeconds ?? step.holdSeconds ?? 0;

    if (step.setpoint.kind === "plateRead") {
      if (blockC === null) continue;
      segments.push({
        startSeconds: start,
        endSeconds: start + took,
        phase: "read",
        fromC: blockC,
        toC: blockC,
        step,
      });
      if (step.readIndex !== undefined) {
        reads.push({
          readIndex: step.readIndex,
          atSeconds: start,
          endSeconds: start + took,
          temperatureC: blockC,
          step,
        });
      }
      end = Math.max(end, start + took);
      continue;
    }

    const target = segmentTemperature(step);
    if (target === null) continue;

    const nominalHold = Math.max(0, step.holdSeconds ?? 0);
    const hold = Math.min(nominalHold, took);
    if (nominalHold > took) clampedSteps += 1;
    const ramp = took - hold;

    if (blockC !== null && ramp > 0) {
      segments.push({
        startSeconds: start,
        endSeconds: start + ramp,
        phase: "ramp",
        fromC: blockC,
        toC: target,
        step,
      });
    }
    segments.push({
      startSeconds: start + ramp,
      endSeconds: start + took,
      phase: "hold",
      fromC: target,
      toC: target,
      ...(step.setpoint.kind === "gradient"
        ? { gradient: { lowC: step.setpoint.lowC, highC: step.setpoint.highC } }
        : {}),
      step,
    });
    blockC = target;
    end = Math.max(end, start + took);
  }

  let minC = Infinity;
  let maxC = -Infinity;
  for (const s of segments) {
    minC = Math.min(minC, s.fromC, s.toC, s.gradient?.lowC ?? Infinity);
    maxC = Math.max(maxC, s.fromC, s.toC, s.gradient?.highC ?? -Infinity);
  }

  const sentinelAt = report.sentinel?.startedAt ? at(report.sentinel.startedAt) : null;
  return {
    segments,
    reads,
    totalSeconds: Math.max(end, sentinelAt ?? 0),
    range: segments.length > 0 ? { minC, maxC } : null,
    clampedSteps,
  };
}
