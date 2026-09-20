/**
 * Writing the `.alf` run report — `emulator.md` §5, `alf.md` for the format.
 *
 * The report is the one file every run produces, whether or not it produces a run folder
 * (`usb.md` §7.10), and it has to describe *this* run: its steps, in the order they executed,
 * each with the wall-clock moment it began. So it is generated rather than lifted from a
 * recording — a recorded report describes a recorded run, and handing one back would make a
 * thermal-only emulated run report somebody else's protocol.
 *
 * Every field below is written the way the two committed reports write it
 * (`samples/20260807_231326_CT019138_AGBLK1.alf` and the melt run's), `*`-delimited with CRLF
 * line endings, so `parseAlf` reads an emulated report exactly as it reads an instrument's.
 *
 * Two behaviours worth knowing, both measured from those files:
 *
 * - **The protocol line is the instrument's normalization, not the host's text.** The AGBLK1 run
 *   was authored as `METHOD BLOCK;TEMP 37.0,30;END` and its report reads
 *   `METHOD BLOCK*HOTLID 105,30*VOLUME 10*TEMP 37.0,30*END` — the firmware filled in the lid and
 *   volume settings it was holding. {@link formatAlf} does the same.
 * - **The run name is uppercased and cut to twelve characters**, in the header's first field and
 *   in the filename alike: `Single Step RT-QPCR` → `SINGLE_STEP_`, `YouSeq_RP_validation` →
 *   `YOUSEQ_RP_VA`. (`usb.md` §5.2 says "in full"; both committed reports say otherwise.)
 */
import type { ScheduledStep } from "./schedule.js";

/** How many characters of the run name reach the `.alf` — measured; see the module comment. */
const REPORT_NAME_CHARS = 12;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `Aug 07, 2026` — an en-US month abbreviation, as `alf.md` §4 field 6 records it. */
function reportDate(at: Date): string {
  return `${MONTHS[at.getMonth()]} ${pad(at.getDate())}, ${at.getFullYear()}`;
}

/** `23:13:26` — 24-hour instrument-local time, no zone. */
function reportTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** `08/07/2026 23:13:27` — the step lines' timestamp (`alf.md` §7.4). */
function stepTimestamp(at: Date): string {
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())}/${at.getFullYear()} ${reportTime(at)}`;
}

/** `hh:mm:ss` — the header's total elapsed. */
function elapsedText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** The run name as the report spells it: uppercase, filename-safe, twelve characters. */
export function reportRunName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "_")
    .slice(0, REPORT_NAME_CHARS);
}

/** `<yyyymmdd>_<hhmmss>_<serial>_<RUN NAME>.alf` (`usb.md` §5.2). */
export function reportFileName(startedAt: Date, baseSerial: string, runName: string): string {
  const d = `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}`;
  const t = `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`;
  return `${d}_${t}_${baseSerial}_${reportRunName(runName)}.alf`;
}

/** A step line's setpoint field (`alf.md` §7, field 5). */
function setpointText(step: ScheduledStep): string {
  const d = step.directive;
  if (d.verb === "PLATEREAD") return "Plate Read";
  if (d.verb === "GRAD") return `${Math.round(d.lowTempC)};${Math.round(d.highTempC)}`;
  return (step.targetC ?? 0).toFixed(1);
}

/** Everything the report says about a run that isn't in its step log. */
export interface AlfRunIdentity {
  name: string;
  user: string;
  alphaSerial: string;
  baseSerial: string;
  blockLetter: string;
  blockType: string;
  cyclerName: string;
  sampleId: string;
  lidTemperatureC: number;
  volumeUl: number;
}

/**
 * Write the report for a run that executed `steps` between `startedAt` and `endedAt`.
 *
 * `steps` is the executed log, one entry per *pass* — for a run stopped early it is simply
 * shorter, which is all an aborted run's report differs by: measured, the error line's
 * user-aborted flag reads `False` and the sentinel still says `Protocol completed.` on a
 * genuinely aborted run (`usb.md` §7.8 step 7), so nothing here varies with how the run ended.
 */
export function formatAlf(
  identity: AlfRunIdentity,
  protocolDirectives: readonly string[],
  steps: readonly { step: ScheduledStep; at: Date }[],
  startedAt: Date,
  endedAt: Date,
): Uint8Array {
  const header = [
    reportRunName(identity.name),
    identity.user,
    identity.alphaSerial,
    identity.blockLetter,
    identity.blockType,
    reportDate(startedAt),
    reportTime(startedAt),
    reportTime(endedAt),
    elapsedText((endedAt.getTime() - startedAt.getTime()) / 1000),
    identity.lidTemperatureC.toFixed(1),
    identity.volumeUl.toFixed(1),
    identity.sampleId,
    identity.cyclerName,
    identity.baseSerial,
  ];

  const lines = [
    `${header.join("*")}*`,
    `${protocolDirectives.join("*")}`,
    // `alf.md` §6. Every committed report is clean, and an aborted run's is byte-identical to a
    // completed one's — so this line is a constant here rather than a function of the run.
    ` No errors reported. *0:*False*False*False*False*None*False*`,
    ...steps.map(({ step, at }) =>
      [
        // Field 1 is `-1` in all 6,205 step lines of this project's corpus (`alf.md` §7) and
        // field 4 is the unreadable "ramp time" (§8); both are written as observed.
        "-1",
        String(step.repeat),
        String(step.stepNumber),
        ".00",
        setpointText(step),
        String(step.holdSeconds),
        stepTimestamp(at),
        "False",
        "0",
      ].join("*") + "*",
    ),
    `-1*0*0*.00*0*0*${stepTimestamp(endedAt)} Protocol completed.*False*0*`,
    "",
  ];

  const text = lines.join("\r\n");
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}
