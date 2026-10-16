/**
 * A run, from `RemoteRun` to the acknowledgement that releases it — `emulator.md` §5.
 *
 * The whole of `usb.md` §7 lives here, and the order is the measured one rather than the obvious
 * one: the protocol is **typed in** as directives, `RemoteRun` and nothing else starts it, the
 * files a host deposits arrive afterwards into a folder that is already being written, and the
 * finished run is **held** until a second `CANCEL` acknowledges it.
 *
 * Five behaviours here exist because a client got them wrong against real hardware, and an
 * emulator that smoothed any of them over would let the same mistake back in:
 *
 * - **A `.Plateread` appears when its step *ends*, not when it starts** (§7.5). A client watching
 *   for the file while `STATUS?` still says `PLATEREAD` waits forever.
 * - **There is a window after `RemoteRun` in which the instrument still reports the empty idle**
 *   (~5.5 s, or ~10.7 s for a run with plate reads) and a `CANCEL` is answered `0000` and ignored
 *   (§7.8 step 0) — the run then starts anyway. This is why `CfxDevice.cancelRun` has an
 *   `expectStart` at all.
 * - **A finished run is not idle** (§7.6): step `IDLE`, cycle counters zero, the run's name still
 *   attached, status register `32`. The last read appears only after the acknowledging `CANCEL`.
 * - **The acknowledgement is not instant either** (§7.6): for {@link RELEASE_MS} after it the run
 *   stays named, and only then do `ended` and the `.alf` appear. A client that lists the folder
 *   the moment `CANCEL` returns files a run with no `ended` and no report — which is what the first
 *   recorded qPCR session did.
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
import { dataFileName, emulatedRunIdentifier, runSupportFiles } from "./runInfo.js";
import {
  AMBIENT_C,
  AT_TARGET_LAG_MS,
  BLOCK_COOL_TAU_S,
  LID_COOL_TAU_S,
  LID_HEAT_C_PER_S,
  RELEASE_MS,
  START_WINDOW_MS,
  START_WINDOW_PLATE_READ_MS,
  cooled,
  lidPreheatMs,
  scheduleRun,
  type RunSchedule,
  type ScheduledStep,
} from "./schedule.js";

export { AMBIENT_C };

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

/** The block and lid temperatures at one moment. */
export interface Temperatures {
  blockC: number;
  lidC: number;
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
  /** Field 3, the current pass. */
  cycle: number;
  /** Field 2 — see {@link ScheduledStep.cycles}. */
  cycles: number;
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
  /** `RemoteRun` to visible, for this kind of run. */
  private readonly startWindowMs: number;
  /** How long this run's lid preheat lasts, from the lid it started with. */
  private readonly preheatMs: number;

  private pausedAt: number | null = null;
  private pausedTotalMs = 0;
  /** What `PROCEED` has cut out of the run so far, in run-clock ms. */
  private skewMs = 0;
  /** Set by an abort: the run clock stops here and the protocol is over. */
  private abortedAtMs: number | null = null;
  /** Simulated time the abort arrived, for the cooling that follows it. */
  private abortedAtNowMs: number | null = null;
  /** Simulated time of the acknowledging `CANCEL`. */
  private acknowledgedAtMs: number | null = null;
  private endDeposited = false;
  private cleared = false;
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
    /** Where the block and lid were when the run was requested — still warm, after a recent run. */
    private readonly start: Temperatures = { blockC: AMBIENT_C, lidC: AMBIENT_C },
  ) {
    this.program = parseRunDefinition(request.directives.join(";"));
    this.schedule = scheduleRun(this.program, start.blockC);
    this.producesRunFile = this.schedule.plateReads > 0;
    this.startWindowMs = this.producesRunFile ? START_WINDOW_PLATE_READ_MS : START_WINDOW_MS;
    this.preheatMs = lidPreheatMs(start.lidC, request.lidTemperatureC, request.lidOn);
    // The folder is emptied in `materialise`, as the run becomes visible — not here.
  }

  /** When the run leaves the start window and becomes visible in `STATUS?`. */
  private get visibleAtMs(): number {
    return this.requestedAtMs + this.startWindowMs;
  }

  /** When the lid preheat ends and the first step's clock starts. */
  private get protocolStartMs(): number {
    return this.visibleAtMs + this.preheatMs;
  }

  /** Simulated time the first step starts — after the start window and this run's preheat — for
   * a test that wants to land inside a particular step ({@link schedule}'s times count from it). */
  get protocolStartsAtMs(): number {
    return this.protocolStartMs;
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

  /** Simulated time the protocol ended — the moment the block stops being driven. */
  private get finishedAtMs(): number {
    if (this.abortedAtNowMs !== null) return this.abortedAtNowMs;
    return this.protocolStartMs + this.pausedTotalMs - this.skewMs + this.schedule.endMs;
  }

  /** The step executing at `runMs`, or null once the protocol is over. Zero-length steps (`GOTO`,
   * `END`) never answer: nothing ever observes the instrument sitting on one. */
  private stepAt(runMs: number): ScheduledStep | null {
    for (const step of this.schedule.steps) {
      if (step.endMs > runMs) return step;
    }
    return null;
  }

  /**
   * True once the acknowledgement has released the run (`usb.md` §7.6) — {@link RELEASE_MS} after
   * the `CANCEL`, not at it. The instrument drops a released run and reports the empty idle.
   */
  isReleased(nowMs: number): boolean {
    return this.acknowledgedAtMs !== null && nowMs >= this.acknowledgedAtMs + RELEASE_MS;
  }

  /** True from the acknowledging `CANCEL` on, released or not. */
  get isAcknowledged(): boolean {
    return this.acknowledgedAtMs !== null;
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
    this.abortedAtNowMs = nowMs;
    return true;
  }

  /** `CANCEL` on a finished run — the acknowledgement. The last read appears at once; the run is
   * released, and the `ended` marker and the report written, {@link RELEASE_MS} later (`usb.md`
   * §7.6). A second `CANCEL` meanwhile changes nothing. */
  acknowledge(nowMs: number): void {
    if (this.acknowledgedAtMs !== null) return;
    this.acknowledgedAtMs = nowMs;
    this.materialise(nowMs);
  }

  get wasCancelled(): boolean {
    return this.abortedAtMs !== null;
  }

  // ---- temperatures -----------------------------------------------------

  /** The lid at `nowMs` while the run is going: climbing from where it started at the measured
   * preheat rate until it reaches its setpoint. */
  private lidAt(nowMs: number): number {
    const target = this.request.lidOn ? this.request.lidTemperatureC : AMBIENT_C;
    if (!this.request.lidOn) return cooled(this.start.lidC, nowMs - this.requestedAtMs, LID_COOL_TAU_S);
    const climbed = this.start.lidC + (LID_HEAT_C_PER_S * Math.max(0, nowMs - this.visibleAtMs)) / 1000;
    return Math.min(target, Math.max(this.start.lidC, climbed));
  }

  /** The block at a point on the run clock: linear through a ramp, then the setpoint. */
  private blockAt(runMs: number): number {
    const step = this.stepAt(runMs) ?? this.schedule.steps.at(-1);
    if (!step) return this.start.blockC;
    const target = this.holdTempOf(step);
    const into = Math.min(runMs, step.endMs) - step.startMs;
    if (step.rampMs <= 0 || into >= step.rampMs) return target;
    return step.fromC + ((target - step.fromC) * into) / step.rampMs;
  }

  /**
   * Block and lid at `nowMs`, for the instrument to report once it has dropped this run — they
   * cool from where the run left them rather than snapping to ambient (`usb.md` §7.6: a block
   * still at 94.42 °C, a lid at 103.1 °C, seconds after a finish). Also what the next run starts
   * from, which is what shortens a warm lid's preheat.
   */
  temperaturesAt(nowMs: number): Temperatures {
    if (!this.isOver(nowMs)) {
      if (nowMs < this.visibleAtMs) return { ...this.start };
      return { blockC: nowMs < this.protocolStartMs ? this.start.blockC : this.blockAt(this.runMs(nowMs)), lidC: this.lidAt(nowMs) };
    }
    const end = this.finishedAtMs;
    const since = nowMs - end;
    return {
      blockC: cooled(this.blockAt(this.endMs), since, BLOCK_COOL_TAU_S),
      lidC: cooled(this.lidAt(end), since, LID_COOL_TAU_S),
    };
  }

  // ---- what the filesystem gains, and when ------------------------------

  /** Real time at a point on the run clock, for a file's own timestamps. */
  private dateAt(runMs: number): Date {
    return new Date(
      this.requestedAt.getTime() +
        this.startWindowMs +
        this.preheatMs +
        this.pausedTotalMs +
        runMs -
        this.skewMs,
    );
  }

  /**
   * Bring the filesystem up to date with where the clock is. Called before every reply, so a
   * listing and a status poll can never disagree about whether a read exists yet.
   */
  materialise(nowMs: number): void {
    if (nowMs >= this.visibleAtMs && this.producesRunFile) this.materialiseRunFolder(nowMs);
    // A thermal-only run is released the same way, and its report appears at the same moment.
    if (!this.endDeposited && this.isReleased(nowMs)) {
      this.endDeposited = true;
      this.depositEndOfRun();
    }
  }

  private materialiseRunFolder(nowMs: number): void {
    if (!this.cleared) {
      // **The previous run is cleared out as this one becomes visible**, which is the *latest*
      // the real clear finishes: measured, the firmware empties the folder in the background over
      // the first ~4.4 s after `RemoteRun`, and the run appears in `STATUS?` at ~11.8 s (`usb.md`
      // §7.4, "The folder is cleared as the run starts"). Anything written inside the start window
      // is therefore lost here, where on the instrument it is lost only if it lands before the
      // clear passes it — the stricter of the two, so a host that deposits too early is caught by
      // the emulator rather than by a run that comes back without its plate. A host deposit that
      // waited for the run to appear arrives after this, is its own, and stays.
      this.cleared = true;
      this.fs.clear(CFX_CURRENT_RUN_DIR);
    }
    if (!this.data) return;
    if (!this.started) {
      this.started = true;
      // `RunInfo.xml` is made this run's (`runInfo.ts`): a host identifies a run by it, so the
      // recording's verbatim copy made every emulated run look like the same one.
      const startedAt = this.dateAt(0);
      const support = runSupportFiles(this.data, {
        identifier: emulatedRunIdentifier(this.requestedAt.getTime(), this.request.name),
        startedAt,
        dataFile: dataFileName(startedAt, this.identity.baseSerial, this.request.name),
        runDefinition: this.protocolText(),
      });
      for (const [name, bytes] of Object.entries(support)) {
        this.fs.write(`${CFX_CURRENT_RUN_DIR}\\${name}`, bytes);
      }
      // CRLF-terminated, unlike the `.alf`'s copy of the same line: 106 bytes for a 104-character
      // protocol, measured in the recorded qPCR session.
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\ProtocolRunDefinition.txt`, ascii(this.protocolText() + "\r\n"));
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
      if (step.readIndex === this.schedule.plateReads && this.acknowledgedAtMs === null) continue;
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
      // First read off the committed melt run's own marker (9, 61, 101, 0), and since confirmed
      // byte for byte by the recorded qPCR session's (4, 45, 45, 0) after `GOTO 2,44`.
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
    return step.targetC ?? step.fromC;
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
   * appear only once the acknowledgement has released the run (`usb.md` §7.6, §7.8 step 6). */
  private depositEndOfRun(): void {
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
      cycles: 0,
      stepCount: 0,
      blockTempC: round2(this.start.blockC),
      lidTempC: round1(this.start.lidC),
      sampleTempC: round2(this.start.blockC),
      elapsedS: 0,
      stepElapsedS: 0,
      rampElapsedS: 0,
      holdElapsedS: 0,
      remainingS: 0,
      nextEventAtMs: this.visibleAtMs,
    };
    if (nowMs < this.visibleAtMs) return idle;

    const stepCount = this.program.steps.length + (this.program.directives.some((d) => d.verb === "END") ? 1 : 0);

    if (nowMs < this.protocolStartMs && !this.isOver(nowMs)) {
      // The lid preheat: the run is reporting its first step, the block has not moved, and the
      // clocks stay at zero — `usb.md` §7.3, which is also why a countdown needs its own state.
      // A `CANCEL` during the preheat is an abort like any other (`isOver`), so it is tested
      // first: a run that answered the abort and then went on reporting itself preheating would
      // time out the client's `cancelRun`, which waits for the register to say "stopped".
      const first = this.schedule.steps[0];
      return {
        ...idle,
        visible: true,
        preheating: true,
        stepText: first?.directive.text ?? "IDLE",
        stepNumber: first?.stepNumber ?? 0,
        cycle: 1,
        cycles: 1,
        stepCount,
        lidTempC: round1(this.lidAt(nowMs)),
        remainingS: round2(this.schedule.endMs / 1000),
        nextEventAtMs: this.protocolStartMs,
      };
    }

    const runMs = this.runMs(nowMs);
    const step = this.isOver(nowMs) ? null : this.stepAt(runMs);
    if (!step) {
      // §7.6: finished, and still held — also through the {@link RELEASE_MS} after the
      // acknowledgement. Not idle — the name is attached and the register reads 32, or 160 when the
      // run was aborted rather than allowed to finish (§3.2, §7.8). The block and lid are where the
      // run left them, cooling.
      const temps = this.temperaturesAt(nowMs);
      return {
        ...idle,
        visible: true,
        finished: true,
        cancelled: this.wasCancelled,
        stepCount: 0,
        elapsedS: round2((this.endMs - this.skewMs) / 1000),
        blockTempC: round2(temps.blockC),
        lidTempC: round1(temps.lidC),
        sampleTempC: round2(temps.blockC),
        nextEventAtMs: this.acknowledgedAtMs === null ? null : this.acknowledgedAtMs + RELEASE_MS,
      };
    }

    const into = runMs - step.startMs;
    const ramping = step.directive.verb !== "PLATEREAD" && into < step.rampMs;
    // The at-target bit trails a setpoint change by a fraction of a second: the first poll of a
    // new step can still carry the last step's bit (`usb.md` §3.2, field 7).
    const lagging = ramping && step.executed > 0 && into < AT_TARGET_LAG_MS;
    const target = this.holdTempOf(step);
    const from = step.fromC;
    const blockTempC = this.blockAt(runMs);
    const rampS = Math.min(into, step.rampMs) / 1000;
    const holdS = Math.max(0, into - step.rampMs) / 1000;
    return {
      visible: true,
      finished: false,
      cancelled: false,
      paused: this.isPaused,
      preheating: false,
      atTarget: !ramping || lagging,
      stepText: step.directive.text,
      stepNumber: step.stepNumber,
      cycle: step.repeat,
      cycles: step.cycles,
      stepCount,
      blockTempC: round2(blockTempC),
      lidTempC: round1(this.lidAt(nowMs)),
      // Field 16 lags the block through a ramp and settles on the setpoint (`usb.md` §3.2).
      sampleTempC: round2(ramping ? from + (blockTempC - from) * 0.6 : target),
      // Field 8 is wall time since the protocol started: a `PROCEED` re-plans what remains
      // (field 10) and moves the run to its next step, but does not jump this clock — measured
      // in the `usb-run` capture, where it read 37.77 s on the step after a skipped 180 s hold.
      elapsedS: round2((runMs - this.skewMs) / 1000),
      stepElapsedS: round2(into / 1000),
      rampElapsedS: round2(rampS),
      holdElapsedS: round2(holdS),
      // Counts down, and — measured — does not tick through a plate read (§3.2).
      remainingS: round2(Math.max(0, this.schedule.endMs - runMs) / 1000),
      nextEventAtMs: this.pausedAt === null ? nowMs + (step.endMs - runMs) : null,
    };
  }
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
