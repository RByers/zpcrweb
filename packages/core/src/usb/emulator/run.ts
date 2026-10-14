/**
 * A run, from `RemoteRun` to the acknowledgement that releases it — `emulator.md` §5.
 *
 * The whole of `usb.md` §7 lives here, and the order is the measured one rather than the obvious
 * one: the protocol is **typed in** as directives, `RemoteRun` and nothing else starts it, the
 * files a host deposits arrive afterwards into a folder that is already being written, and the
 * finished run is **held** until a second `CANCEL` acknowledges it.
 *
 * Four behaviours here exist because a client got them wrong against real hardware, and an
 * emulator that smoothed any of them over would let the same mistake back in:
 *
 * - **A `.Plateread` appears when its step *ends*, not when it starts** (§7.5). A client watching
 *   for the file while `STATUS?` still says `PLATEREAD` waits forever.
 * - **There is a ~6 s window after `RemoteRun` in which the instrument still reports the empty
 *   idle** and a `CANCEL` is answered `0000` and ignored (§7.8 step 0) — the run then starts
 *   anyway. This is why `CfxDevice.cancelRun` has an `expectStart` at all.
 * - **A finished run is not idle** (§7.6): step `IDLE`, cycle counters zero, the run's name still
 *   attached, status register `32`. The last read, the `ended` marker and the `.alf` appear only
 *   after the acknowledging `CANCEL`, which is why collecting them has to wait for it.
 * - **A protocol with no `PLATEREAD` writes no run folder at all** (§7.10) — not an empty one, no
 *   folder: the previous run's files sit there untouched from first command to last. That
 *   asymmetry is what `RunPlan.producesRunFile` exists for, and it is the case in which a client
 *   that pulls the folder at the finish carries off somebody else's run.
 */
import { parseRunDefinition, type RunDefinitionProgram } from "../../runDefinition.js";
import { CFX_CURRENT_RUN_DIR, CFX_RUN_REPORT_DIR } from "../runPlan.js";
import { RUN_BEGUN_MARKER, RUN_ENDED_MARKER } from "../../runFolder.js";
import type { EmulatorRunData } from "./data.js";
import type { EmulatorFilesystem } from "./filesystem.js";
import { formatAlf, reportFileName, type AlfRunIdentity } from "./report.js";
import {
  LID_PREHEAT_MS,
  RAMP_MS,
  START_WINDOW_MS,
  scheduleRun,
  type RunSchedule,
  type ScheduledStep,
} from "./schedule.js";

/** The block's resting temperature, and the ambient every idle reply reports. This emulator's
 * own — the instrument's depends on the room. */
export const AMBIENT_C = 18.4;

/** What `RemoteRun` was told, plus what the instrument holds alongside it. */
export interface RunRequest {
  name: string;
  user: string;
  method: string;
  lidOn: boolean;
  sampleId: string;
  /** The directives typed in since `PROTOCOL '<name>'`, in order, `END` included. */
  directives: string[];
  lidTemperatureC: number;
  /** `HOTLID`'s operand pair as the instrument holds it, e.g. `105,30`. */
  hotLidOperand: string;
  volumeUl: number;
}

/** Everything a client can read about the run at one moment — the inputs to `STATUS?`. */
export interface RunSnapshot {
  /** False inside the start window, where the instrument still reports the empty idle. */
  visible: boolean;
  finished: boolean;
  cancelled: boolean;
  paused: boolean;
  preheating: boolean;
  atTarget: boolean;
  stepText: string;
  stepNumber: number;
  cycle: number;
  stepCount: number;
  blockTempC: number;
  lidTempC: number;
  sampleTempC: number;
  elapsedS: number;
  stepElapsedS: number;
  rampElapsedS: number;
  holdElapsedS: number;
  remainingS: number;
  /** Simulated time of the next state change, for {@link acceleratedClock} to jump to. */
  nextEventAtMs: number | null;
}

export class EmulatedRun {
  readonly program: RunDefinitionProgram;
  readonly schedule: RunSchedule;
  /** True when this run will build a run folder at all (`usb.md` §7.10). */
  readonly producesRunFile: boolean;

  private pausedAt: number | null = null;
  private pausedTotalMs = 0;
  /** What `PROCEED` has cut out of the run so far, in run-clock ms. */
  private skewMs = 0;
  /** Set by an abort: the run clock stops here and the protocol is over. */
  private abortedAtMs: number | null = null;
  private acknowledged = false;
  private started = false;
  private readsWritten = 0;

  constructor(
    readonly request: RunRequest,
    /** Simulated time `RemoteRun` was accepted at. */
    private readonly requestedAtMs: number,
    /** Wall-clock instant the same moment corresponds to, for the files' timestamps. */
    private readonly requestedAt: Date,
    private readonly fs: EmulatorFilesystem,
    private readonly data: EmulatorRunData | null,
    private readonly identity: Omit<AlfRunIdentity, "name" | "user" | "sampleId" | "lidTemperatureC" | "volumeUl">,
  ) {
    this.program = parseRunDefinition(request.directives.join(";"));
    this.schedule = scheduleRun(this.program);
    this.producesRunFile = this.schedule.plateReads > 0;
    // **Clear the folder here, where the run is requested — not where it becomes visible.**
    // A new run's folder holds that run's files and no other, which is derived rather than
    // observed (`emulator.md` Appendix A). *When* it is emptied is not a free choice, though:
    // the host deposits `zpcrweb.json`, the plate and the protocol into this directory
    // immediately after `RemoteRun` returns (`usb.md` §7.4), which is inside the start window
    // and so long before the run first shows up in `STATUS?`. Clearing at that later moment
    // deleted everything the host had just put there, and the run came back named after
    // whatever `RunInfo.xml` the recording carried rather than the experiment it was started
    // from — with no plate, so the Curves view had no targets to offer. Found by driving a run
    // from the browser; a real instrument cannot behave this way, or a deposited run would
    // never survive its own start.
    if (this.producesRunFile) this.fs.clear(CFX_CURRENT_RUN_DIR);
  }

  /** When the run leaves the start window and becomes visible in `STATUS?`. */
  private get visibleAtMs(): number {
    return this.requestedAtMs + START_WINDOW_MS;
  }

  /** When the lid preheat ends and the first step's clock starts. */
  private get protocolStartMs(): number {
    return this.visibleAtMs + LID_PREHEAT_MS;
  }

  /** Position on the protocol's own clock: 0 at the first step, frozen while paused. */
  private runMs(nowMs: number): number {
    const at = this.pausedAt ?? nowMs;
    const raw = at - this.protocolStartMs - this.pausedTotalMs + this.skewMs;
    const capped = this.abortedAtMs === null ? raw : Math.min(raw, this.abortedAtMs);
    return Math.max(0, capped);
  }

  /** True once the protocol is over — completed or aborted — and the instrument is holding it. */
  private isOver(nowMs: number): boolean {
    return nowMs >= this.visibleAtMs && this.runMs(nowMs) >= this.endMs;
  }

  private get endMs(): number {
    return this.abortedAtMs ?? this.schedule.endMs;
  }

  /** The step executing at `runMs`, or null once the protocol is over. Zero-length steps (`GOTO`,
   * `END`) never answer: nothing ever observes the instrument sitting on one. */
  private stepAt(runMs: number): ScheduledStep | null {
    for (const step of this.schedule.steps) {
      if (step.endMs > runMs) return step;
    }
    return null;
  }

  /** True once the acknowledging `CANCEL` has released the run (`usb.md` §7.6). */
  get isReleased(): boolean {
    return this.acknowledged;
  }

  // ---- control ----------------------------------------------------------

  pause(nowMs: number): void {
    if (this.pausedAt === null && !this.isOver(nowMs)) this.pausedAt = nowMs;
  }

  resume(nowMs: number): void {
    if (this.pausedAt !== null) {
      this.pausedTotalMs += nowMs - this.pausedAt;
      this.pausedAt = null;
    }
  }

  get isPaused(): boolean {
    return this.pausedAt !== null;
  }

  /** `PROCEED` — skip to the next step (`usb.md` §7.5). Jumps the run clock to the end of the
   * step it is on, which is exactly what the instrument's re-plan looks like from outside. */
  proceed(nowMs: number): void {
    if (this.isOver(nowMs) || nowMs < this.visibleAtMs) return;
    const step = this.stepAt(this.runMs(nowMs));
    if (!step) return;
    this.skewMs += step.endMs - this.runMs(nowMs);
  }

  /**
   * `CANCEL` on a run in progress. Inside the start window it does nothing at all and the run
   * starts anyway — measured (`usb.md` §7.8 step 0), and the reason a Stop button cannot be
   * fire-and-forget.
   *
   * Returns true if the run was actually stopped.
   */
  abort(nowMs: number): boolean {
    if (nowMs < this.visibleAtMs || this.isOver(nowMs)) return false;
    // A run aborted while paused ends where it was paused; the pause's span still has to be
    // accounted for, or the report's end time and elapsed seconds leave it out.
    this.resume(nowMs);
    this.abortedAtMs = this.runMs(nowMs);
    return true;
  }

  /** `CANCEL` on a finished run — the acknowledgement that releases it and, with it, the `ended`
   * marker and the report (`usb.md` §7.6). */
  acknowledge(nowMs: number): void {
    if (this.acknowledged) return;
    this.acknowledged = true;
    this.depositEndOfRun(nowMs);
  }

  get wasCancelled(): boolean {
    return this.abortedAtMs !== null;
  }

  // ---- what the filesystem gains, and when ------------------------------

  /** Real time at a point on the run clock, for a file's own timestamps. */
  private dateAt(runMs: number): Date {
    return new Date(
      this.requestedAt.getTime() +
        START_WINDOW_MS +
        LID_PREHEAT_MS +
        this.pausedTotalMs +
        runMs -
        this.skewMs,
    );
  }

  /**
   * Bring the run folder up to date with where the clock is. Called before every reply, so a
   * listing and a status poll can never disagree about whether a read exists yet.
   */
  materialise(nowMs: number): void {
    if (nowMs < this.visibleAtMs || !this.producesRunFile || !this.data) return;
    if (!this.started) {
      this.started = true;
      // The folder was emptied when the run was requested (see the constructor). Anything the
      // host deposited since is its own and stays.
      for (const [name, bytes] of Object.entries(this.data.supportFiles())) {
        this.fs.write(`${CFX_CURRENT_RUN_DIR}\\${name}`, bytes);
      }
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\ProtocolRunDefinition.txt`, ascii(this.protocolText()));
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\calibrationfilescopied`, new Uint8Array(0));
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\${RUN_BEGUN_MARKER}`, new Uint8Array(0));
    }
    const runMs = this.runMs(nowMs);
    for (const step of this.schedule.steps) {
      if (step.readIndex === undefined || step.endMs > runMs) continue;
      if (step.readIndex <= this.readsWritten) continue;
      // The run's last read is released by the acknowledging `CANCEL`, not by its step ending
      // (`usb.md` §7.6–§7.7): a listing taken at the final `PLATEREAD`→`IDLE` edge does not
      // find it, which is the case the follower's finish rule exists for. Deliberately only the
      // last one — every earlier read appears as its step ends, and is listed mid-run.
      if (step.readIndex === this.schedule.plateReads && !this.acknowledged) continue;
      this.readsWritten = step.readIndex;
      const fileName = `Read${String(step.readIndex).padStart(5, "0")}.Plateread`;
      const mask =
        step.directive.verb === "PLATEREAD" ? (step.directive.scanMask?.raw ?? 0x3f) : 0x3f;
      this.fs.write(
        `${CFX_CURRENT_RUN_DIR}\\${fileName}`,
        this.data.plateRead({
          index: step.readIndex,
          cycle: step.repeat,
          stepNumber: step.stepNumber,
          blockTempC: this.holdTempOf(step),
          lidTempC: this.request.lidTemperatureC,
          sampleTempC: this.holdTempOf(step),
          channelMask: mask,
          at: this.dateAt(step.endMs),
          fileName,
        }),
      );
      // Four little-endian int32s: the last read's step, its pass, the running read count, 0.
      // Read off the committed melt run's own marker (9, 61, 101, 0); nothing else is known
      // about it, and nothing in this project reads it.
      const status = new Uint8Array(16);
      const view = new DataView(status.buffer);
      view.setInt32(0, step.stepNumber, true);
      view.setInt32(4, step.repeat, true);
      view.setInt32(8, step.readIndex, true);
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\lastplatereadstatus`, status);
    }
  }

  /** The block temperature a step holds at — what a read taken during it records. */
  private holdTempOf(step: ScheduledStep): number {
    // A `PLATEREAD` has no setpoint of its own; it reads at whatever the preceding step held.
    if (step.targetC !== null) return step.targetC;
    let previous: number | null = null;
    for (const s of this.schedule.steps) {
      if (s === step) break;
      if (s.targetC !== null) previous = s.targetC;
    }
    return previous ?? AMBIENT_C;
  }

  /** The protocol as the instrument records it — the directives typed in, with the lid and volume
   * settings the firmware supplies itself (measured, `usb.md` §7.10). */
  private protocolText(): string {
    const steps = this.request.directives.filter((d) => !/^(METHOD|HOTLID|VOLUME)\b/i.test(d.trim()));
    return [
      `METHOD ${this.request.method}`,
      `HOTLID ${this.request.hotLidOperand}`,
      `VOLUME ${this.request.volumeUl}`,
      ...steps,
    ].join(";");
  }

  /** The `.alf`, the `ended` marker, and the report's copy inside the run folder — all of which
   * appear only once the finished run has been acknowledged (`usb.md` §7.6, §7.8 step 6). */
  private depositEndOfRun(nowMs: number): void {
    const endRunMs = this.endMs;
    const startedAt = this.dateAt(0);
    const endedAt = this.dateAt(endRunMs);
    const executed = this.schedule.steps
      .filter((step) => step.endMs <= endRunMs)
      .map((step) => ({ step, at: this.dateAt(step.startMs) }));
    const report = formatAlf(
      {
        ...this.identity,
        name: this.request.name,
        user: this.request.user,
        sampleId: this.request.sampleId,
        lidTemperatureC: this.request.lidTemperatureC,
        volumeUl: this.request.volumeUl,
      },
      this.protocolText().split(";"),
      executed,
      startedAt,
      endedAt,
    );
    const name = reportFileName(startedAt, this.identity.baseSerial, this.request.name);
    this.fs.write(`${CFX_RUN_REPORT_DIR}\\${name}`, report);
    if (this.producesRunFile) {
      this.materialise(nowMs);
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\${name}`, report);
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\${RUN_ENDED_MARKER}`, new Uint8Array(0));
    }
  }

  // ---- what STATUS? reads -----------------------------------------------

  observe(nowMs: number): RunSnapshot {
    const idle: RunSnapshot = {
      visible: false,
      finished: false,
      cancelled: false,
      paused: false,
      preheating: false,
      atTarget: false,
      stepText: "IDLE",
      stepNumber: 0,
      cycle: 0,
      stepCount: 0,
      blockTempC: AMBIENT_C,
      lidTempC: AMBIENT_C,
      sampleTempC: AMBIENT_C,
      elapsedS: 0,
      stepElapsedS: 0,
      rampElapsedS: 0,
      holdElapsedS: 0,
      remainingS: 0,
      nextEventAtMs: this.visibleAtMs,
    };
    if (nowMs < this.visibleAtMs) return idle;

    const stepCount = this.program.steps.length + (this.program.directives.some((d) => d.verb === "END") ? 1 : 0);
    const lidTarget = this.request.lidOn ? this.request.lidTemperatureC : AMBIENT_C;

    if (nowMs < this.protocolStartMs && !this.isOver(nowMs)) {
      // The lid preheat: the run is reporting its first step, the block has not moved, and the
      // clocks stay at zero — `usb.md` §7.3, which is also why a countdown needs its own state.
      // A `CANCEL` during the preheat is an abort like any other (`isOver`), so it is tested
      // first: a run that answered the abort and then went on reporting itself preheating would
      // time out the client's `cancelRun`, which waits for the register to say "stopped".
      const first = this.schedule.steps[0];
      const fraction = (nowMs - this.visibleAtMs) / LID_PREHEAT_MS;
      return {
        ...idle,
        visible: true,
        preheating: true,
        stepText: first?.directive.text ?? "IDLE",
        stepNumber: first?.stepNumber ?? 0,
        cycle: 1,
        stepCount,
        lidTempC: round1(AMBIENT_C + (lidTarget - AMBIENT_C) * fraction),
        remainingS: round2(this.schedule.endMs / 1000),
        nextEventAtMs: this.protocolStartMs,
      };
    }

    const runMs = this.runMs(nowMs);
    const step = this.isOver(nowMs) ? null : this.stepAt(runMs);
    if (!step) {
      // §7.6: finished, and still held. Not idle — the name is attached and the register reads
      // 32, or 160 when the run was aborted rather than allowed to finish (§3.2, §7.8).
      return {
        ...idle,
        visible: true,
        finished: true,
        cancelled: this.wasCancelled,
        stepCount: 0,
        elapsedS: round2((this.endMs - this.skewMs) / 1000),
        lidTempC: round1(lidTarget),
        nextEventAtMs: null,
      };
    }

    const into = runMs - step.startMs;
    const ramping = step.directive.verb !== "PLATEREAD" && into < RAMP_MS;
    const target = this.holdTempOf(step);
    const from = this.previousTargetOf(step);
    const blockTempC = ramping ? from + ((target - from) * into) / RAMP_MS : target;
    return {
      visible: true,
      finished: false,
      cancelled: false,
      paused: this.isPaused,
      preheating: false,
      atTarget: !ramping,
      stepText: step.directive.text,
      stepNumber: step.stepNumber,
      cycle: step.repeat,
      stepCount,
      blockTempC: round2(blockTempC),
      lidTempC: round1(lidTarget),
      // Field 16 lags the block through a ramp and settles on the setpoint (`usb.md` §3.2).
      sampleTempC: round2(ramping ? from + (blockTempC - from) * 0.6 : target),
      // Field 8 is wall time since the protocol started: a `PROCEED` re-plans what remains
      // (field 10) and moves the run to its next step, but does not jump this clock — measured
      // in the `usb-run` capture, where it read 37.77 s on the step after a skipped 180 s hold.
      elapsedS: round2((runMs - this.skewMs) / 1000),
      stepElapsedS: round2(into / 1000),
      rampElapsedS: round2(Math.min(into, RAMP_MS) / 1000),
      holdElapsedS: round2(Math.max(0, into - RAMP_MS) / 1000),
      // Counts down, and — measured — does not tick through a plate read (§3.2).
      remainingS: round2(Math.max(0, this.schedule.endMs - runMs) / 1000),
      nextEventAtMs: this.pausedAt === null ? nowMs + (step.endMs - runMs) : null,
    };
  }

  /** The setpoint the block is coming *from* when a step begins. */
  private previousTargetOf(step: ScheduledStep): number {
    let previous = AMBIENT_C;
    for (const s of this.schedule.steps) {
      if (s === step) break;
      if (s.targetC !== null) previous = s.targetC;
    }
    return previous;
  }
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
