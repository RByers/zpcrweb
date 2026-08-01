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

/** Lid position as reported by `STATUS?` field 17. */
export type LidState = "OPEN" | "CLOSED" | "UNKNOWN";

/**
 * `STATUS?`, the once-a-second poll every real client runs.
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
  /** Field 2 — current cycle, 0 while idle. */
  cycle: number | null;
  /** Field 3 — current step index within the protocol, 0 while idle. */
  step: number | null;
  /** Field 4 — the running step as text: `IDLE`, or e.g. `TEMP 95.0,10`. */
  stepText: string;
  /** Field 6, first component — the run name in quotes, empty while idle. */
  runName: string;
  /** Field 6, second component — `BLOCK` at idle, the method name (e.g. `CALC`) during a run. */
  method: string;
  /** Field 6, third component — `ON`/`OFF`. Reads ON during a real-time run. */
  realTime: boolean | null;
  /**
   * Field 16. Tracks but lags the block temperature (equal to it at idle, 55.61 against a block
   * 60.25 mid-ramp), which is what a calculated sample temperature does — **inferred from those
   * two observations, not confirmed.**
   */
  sampleTempC: number | null;
  /** Field 17 — lid position. */
  lid: LidState;
  /** True when the instrument reports anything other than `IDLE`. */
  running: boolean;
  /** Every field as received, including the ones above and the ten with no established meaning. */
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

export function parseStatus(res: CfxResponse): CfxStatus {
  const f = res.fields;
  // Field 6 is a compound: `"<run name>",<method>,<ON|OFF>`.
  const [name = "", method = "", rt = ""] = (f[6] ?? "").split(",");
  const stepText = f[4] ?? "";
  const lidRaw = (f[17] ?? "").toUpperCase();
  return {
    blockTempC: num(f[0]),
    lidTempC: num(f[1]),
    cycle: num(f[2]),
    step: num(f[3]),
    stepText,
    runName: unquote(name),
    method,
    realTime: rt === "ON" ? true : rt === "OFF" ? false : null,
    sampleTempC: num(f[16]),
    lid: lidRaw === "OPEN" || lidRaw === "CLOSED" ? lidRaw : "UNKNOWN",
    running: stepText !== "" && stepText !== "IDLE",
    fields: f,
    raw: res.raw,
  };
}

/**
 * `RTSTATUS?` → `25.99;26;;0000`, polled alongside `STATUS?`.
 *
 * Three fields, none of them identified: the first reads like a temperature and the third is
 * consistently empty, but neither capture nor live probing varied them enough to say what they
 * are. Kept as a typed shell over the raw fields so a caller can display it without the library
 * asserting a meaning it doesn't have.
 */
export interface CfxRtStatus {
  fields: string[];
  raw: string;
}

export function parseRtStatus(res: CfxResponse): CfxRtStatus {
  return { fields: res.fields, raw: res.raw };
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
