/**
 * Typed views over the instrument's status and identification replies (`usb.md` §3).
 *
 * Only fields whose meaning is actually established get a name. `STATUS?` returns twenty
 * semicolon-separated fields and the reference captures pin down maybe half of them; inventing
 * names for the rest would make guesses look like measurements. Every parser here therefore keeps
 * the raw `fields` array alongside the named properties, so a caller can show what isn't
 * understood rather than pretend it isn't there.
 */
import type { CfxResponse } from "./commands.js";

/** `*IDN?` → `BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0` — four comma-separated fields. */
export interface CfxIdentity {
  manufacturer: string;
  model: string;
  serial: string;
  firmware: string;
  raw: string;
}

export function parseIdentity(res: CfxResponse): CfxIdentity {
  const parts = (res.value ?? "").split(",");
  return {
    manufacturer: parts[0] ?? "",
    model: parts[1] ?? "",
    serial: parts[2] ?? "",
    firmware: parts[3] ?? "",
    raw: res.raw,
  };
}

/** Lid position as reported by `STATUS?` field 17 (`usb.md` §3.2). */
export type LidState =
  | "OPEN"
  | "CLOSED"
  | "OPENING"
  | "CLOSING"
  | "MANUAL"
  | "STOP"
  | "ERROR"
  | "NONE"
  | "UNKNOWN";

const LID_STATES: readonly LidState[] = [
  "OPEN",
  "CLOSED",
  "OPENING",
  "CLOSING",
  "MANUAL",
  "STOP",
  "ERROR",
  "NONE",
];

/**
 * `STATUS?` field 7, an 8-bit flag word (`usb.md` §3.2 "Field 7, the status register") — not an
 * enumeration, several bits can be set at once (e.g. lid preheating alongside protocol running).
 */
export interface CfxStatusFlags {
  /** Bit 0 — the block has reached the current step's setpoint. The cleanest "has it arrived"
   * signal in the protocol, better than comparing the block temp against a parsed setpoint. */
  atTarget: boolean;
  /** Bit 1 — paused. Mirrors field 13. */
  paused: boolean;
  /** Bit 2 — a fourth-block flag, meaningless on a CFX96 (one block). */
  fourthBlock: boolean;
  /** Bit 3 — lid preheating. The honest way to detect the ~3-minute warm-up before a run's block
   * starts ramping, during which field 10 (time remaining) is frozen. */
  lidPreheating: boolean;
  /** Bit 4 — incubating: holding a temperature outside a protocol. */
  incubating: boolean;
  /** Bit 5 — protocol running. */
  protocolRunning: boolean;
  /** Bit 6 — block active. */
  blockActive: boolean;
  /** Bit 7 — protocol cancelled. */
  cancelled: boolean;
  /** The raw byte value, 0–255. */
  raw: number;
}

/** The three coarse states `usb.md` §3.2 derives from bits 4–6 of the status register. `"other"`
 * covers combinations the reference captures never produced (e.g. incubating). */
export type CfxRunPhase = "idle" | "running" | "finished" | "other";

function parseStatusFlags(v: string | undefined): CfxStatusFlags {
  const raw = Number(v ?? 0) || 0;
  return {
    atTarget: (raw & 0x01) !== 0,
    paused: (raw & 0x02) !== 0,
    fourthBlock: (raw & 0x04) !== 0,
    lidPreheating: (raw & 0x08) !== 0,
    incubating: (raw & 0x10) !== 0,
    protocolRunning: (raw & 0x20) !== 0,
    blockActive: (raw & 0x40) !== 0,
    cancelled: (raw & 0x80) !== 0,
    raw,
  };
}

function derivePhase(flags: CfxStatusFlags): CfxRunPhase {
  if (!flags.incubating && !flags.protocolRunning && !flags.blockActive) return "idle";
  if (flags.protocolRunning && flags.blockActive && !flags.incubating) return "running";
  if (flags.protocolRunning && !flags.blockActive) return "finished";
  return "other";
}

/**
 * `STATUS?`, the once-a-second poll every real client runs. Field numbers in the doc comments
 * below are `usb.md` §3.2's — they line up 1:1 with {@link CfxResponse.fields} because that
 * table's own field 19 (the trailing result code) is already split off into `res.code`.
 *
 * Measured against a live instrument at idle:
 * `18.40;23.8;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;18.40;CLOSED;0;0000`
 * and, from `usb.md` §3's capture, mid-run:
 * `60.25;104.9;2;2;TEMP 95.0,10;2;"SINGLETE",CALC,ON;96;110.22;0.00;75.15;2.10;0.00;0;0;6;55.61;CLOSED;0;0000`
 */
export interface CfxStatus {
  /** Field 0 — block temperature, °C. */
  blockTempC: number | null;
  /** Field 1 — heated-lid temperature, °C. */
  lidTempC: number | null;
  /**
   * Field 2 — byte-identical to {@link cycle} in every sample `usb.md` §3.2 has, so whether this
   * is genuinely a separate "total cycles" or the firmware echoing the current cycle twice isn't
   * decidable from one run. Prefer {@link cycle} for "which cycle is this" and the protocol you
   * authored for the total.
   */
  cycleCount: number | null;
  /** Field 3 — current cycle, 1-based, 0 while idle. */
  cycle: number | null;
  /** Field 4 — the running step as text: `IDLE`, or e.g. `TEMP 95.0,10`. */
  stepText: string;
  /** Field 5 — that step's 1-based number in the run definition, 0 while idle. This is what lines
   * up with a decoded protocol's own step numbers — not {@link cycle}. */
  stepNumber: number | null;
  /** Field 6, first component — the run name in quotes, empty while idle. */
  runName: string;
  /** Field 6, second component — `BLOCK` at idle, the method name (e.g. `CALC`) during a run. */
  method: string;
  /** Field 6, third component — `ON`/`OFF`. Reads ON during a real-time run. */
  realTime: boolean | null;
  /** Field 7 — the status register, decoded. */
  flags: CfxStatusFlags;
  /** Field 8 — total elapsed run time, seconds. Counts up from 0 for the life of the run; the
   * best input to a progress bar (`usb.md` §3.2). */
  elapsedS: number | null;
  /** Field 9 — seconds elapsed in the current step. On this firmware indistinguishable from
   * {@link holdElapsedS} (`usb.md` §3.2). */
  stepElapsedS: number | null;
  /**
   * Field 10 — the instrument's own estimate of time remaining in the protocol, seconds. It is
   * genuinely useful (elapsed + remaining holds ~constant) but not a precise countdown: it freezes
   * during lid preheat and during a plate read, re-plans when a step is skipped, and otherwise
   * runs a few seconds optimistic per plate read (`usb.md` §3.2). Display it as an estimate —
   * don't try to correct for what it doesn't count.
   */
  remainingS: number | null;
  /** Field 11 — seconds spent ramping toward this step's setpoint; freezes the instant `flags.atTarget` sets. */
  rampElapsedS: number | null;
  /** Field 12 — seconds held at setpoint in this step. */
  holdElapsedS: number | null;
  /** Field 13 — paused flag; mirrors `flags.paused`. */
  paused: boolean;
  /** Field 14 — `:`-separated block error codes, empty when there are none. */
  errors: string[];
  /** Field 15 — number of steps in the run definition, 0 while idle. The denominator for
   * "step *n* of *m*" alongside {@link stepNumber}. */
  stepCount: number | null;
  /**
   * Field 16. Tracks but lags the block temperature (equal to it at idle, 55.61 against a block
   * 60.25 mid-ramp), which is what a calculated sample temperature does — **inferred from those
   * two observations, not confirmed.**
   */
  sampleTempC: number | null;
  /** Field 17 — lid position. */
  lid: LidState;
  /** Field 18 — an unidentified sensor reading, `0` in every sample so far. */
  sensor: number | null;
  /** True when the instrument reports anything other than `IDLE`. */
  running: boolean;
  /** The coarse run phase derived from `flags` (`usb.md` §3.2). */
  phase: CfxRunPhase;
  /** Every field as received. */
  fields: string[];
  raw: string;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function unquote(v: string): string {
  return v.replace(/^"|"$/g, "");
}

function parseErrors(v: string | undefined): string[] {
  if (v === undefined || v.trim() === "" || v === "0") return [];
  return v.split(":");
}

export function parseStatus(res: CfxResponse): CfxStatus {
  const f = res.fields;
  // Field 6 is a compound: `"<run name>",<method>,<ON|OFF>`.
  const [name = "", method = "", rt = ""] = (f[6] ?? "").split(",");
  const stepText = f[4] ?? "";
  const lidRaw = (f[17] ?? "").toUpperCase();
  const flags = parseStatusFlags(f[7]);
  return {
    blockTempC: num(f[0]),
    lidTempC: num(f[1]),
    cycleCount: num(f[2]),
    cycle: num(f[3]),
    stepText,
    stepNumber: num(f[5]),
    runName: unquote(name),
    method,
    realTime: rt === "ON" ? true : rt === "OFF" ? false : null,
    flags,
    elapsedS: num(f[8]),
    stepElapsedS: num(f[9]),
    remainingS: num(f[10]),
    rampElapsedS: num(f[11]),
    holdElapsedS: num(f[12]),
    paused: f[13] === "1",
    errors: parseErrors(f[14]),
    stepCount: num(f[15]),
    sampleTempC: num(f[16]),
    lid: (LID_STATES as string[]).includes(lidRaw) ? (lidRaw as LidState) : "UNKNOWN",
    sensor: num(f[18]),
    running: stepText !== "" && stepText !== "IDLE",
    phase: derivePhase(flags),
    fields: f,
    raw: res.raw,
  };
}

/** One entry of `RTSTATUS?`'s fault list (`usb.md` §3.3) — a hex code with an optional
 * comma-separated extra value. Neither reference capture ever populated this list, so the format
 * is documented but unobserved beyond "empty". */
export interface CfxFault {
  code: string;
  extra?: string;
}

/**
 * `RTSTATUS?` → `18.31;26;;0000`, the optical head's status, polled alongside `STATUS?`
 * (`usb.md` §3.3).
 */
export interface CfxRtStatus {
  /** Field 0 — the optical head's own heated shuttle, °C. The useful one — it climbs during the
   * pre-run warm-up alongside the lid and settles once the block is cycling. */
  shuttleTempC: number | null;
  /** Field 1 — ambient temperature at the upper board, °C (a coarser integer reading). */
  ambientTempC: number | null;
  /** Fields 2..n−1 — fault entries; empty when healthy. */
  faults: CfxFault[];
  /** Every field as received. */
  fields: string[];
  raw: string;
}

export function parseRtStatus(res: CfxResponse): CfxRtStatus {
  const f = res.fields;
  const faults: CfxFault[] = f
    .slice(2)
    .filter((s) => s !== "")
    .map((s) => {
      const [code = "", extra] = s.split(",");
      return extra === undefined ? { code } : { code, extra };
    });
  return {
    shuttleTempC: num(f[0]),
    ambientTempC: num(f[1]),
    faults,
    fields: f,
    raw: res.raw,
  };
}

/**
 * The one-shot identification block a client reads at connect time — every static query in
 * `usb.md` §3's first table. All optional: a field is simply absent if that query errored, so one
 * unsupported command on some other Bio-Rad model can't fail the whole connect.
 */
export interface CfxDeviceInfo extends CfxIdentity {
  frontEndSoftware?: string;
  baseSerial?: string;
  alphaSerial?: string;
  alphaId?: string;
  blockDescription?: string;
  blockCount?: number;
  cpld?: string;
  volumeUl?: number;
  freeSpaceBytes?: number;
  totalRamBytes?: number;
  lidForce?: string;
  lidVersion?: string;
  lidBVersion?: string;
  superLockdown?: string;
  errorCount?: number;
}
