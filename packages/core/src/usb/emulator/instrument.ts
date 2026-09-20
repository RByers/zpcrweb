/**
 * The command language, answered statefully — `emulator.md` §3–§5, `usb.md` §3.
 *
 * One method, {@link EmulatedInstrument.handle}, takes a command line and returns the reply the
 * instrument would give. Everything the client can ask about is derived from state that a run
 * actually moves: `STATUS?`'s twenty fields come out of {@link EmulatedRun.observe}, the listing
 * pair comes out of {@link EmulatorFilesystem}, and the identity block is a table.
 *
 * **Two response shapes, and which one a command uses is a property of the command** (`usb.md`
 * §3): a query with something to report separates its value from the code with a semicolon, even
 * when the value is empty (`ERRORLIST A` → `;0000`), while a pure action command answers the bare
 * `0000` with no separator at all. Getting that wrong is invisible in a log and breaks
 * `parseResponse`, so the two are spelled as {@link value} and {@link ok} here and never mixed.
 *
 * **This emulator is never more permissive than the instrument.** A command the real one rejects
 * has to be rejected here, or the client grows a dependency on leniency that fails in the lab —
 * so `RemoteRun`'s operands are type-checked as §7.3 describes them, and anything unrecognised
 * answers a failure code rather than a cheerful `0000`. Where the real instrument's answer is
 * unknown, the failure is this emulator's invention and `emulator.md` Appendix A says so.
 */
import { OK_CODE } from "../commands.js";
import { cfxFileCrc } from "../crc.js";
import { CFX_CURRENT_RUN_DIR, CFX_RUN_REPORT_DIR } from "../runPlan.js";
import { isRunDefinitionVerb } from "../../runDefinition.js";
import type { EmulatorClock } from "./clock.js";
import type { EmulatorRunData } from "./data.js";
import { EmulatorFilesystem, FILE_MISSING } from "./filesystem.js";
import { AMBIENT_C, EmulatedRun, type RunRequest, type RunSnapshot } from "./run.js";
import type { EmulatorReply } from "./transport.js";

/**
 * The failure code this emulator answers with. **Invented**: neither reference capture nor any
 * live session has ever provoked a non-zero code, so what a real rejection looks like beyond
 * "not `0000`" is unknown (`usb.md` §3). It is deliberately not `0000` so that a client relying
 * on leniency fails here rather than in the lab.
 */
const FAIL_CODE = "0001";

/** The static identification block (`usb.md` §3), defaulting to the committed CT019138 strings. */
export interface EmulatorIdentity {
  manufacturer: string;
  model: string;
  /** The base-unit serial — `*IDN?`'s third field, `BASESN?`, and the `.alf`'s filename. */
  serial: string;
  firmware: string;
  frontEndSoftware: string;
  /** `ALPHASN?` — the block's own serial, distinct from the base unit's. */
  alphaSerial: string;
  alphaId: string;
  blockDescription: string;
  cpld: string;
  lidVersion: string;
  lidBVersion: string;
}

export const DEFAULT_IDENTITY: EmulatorIdentity = {
  manufacturer: "BIO-RAD LABORATORIES",
  model: "C1000",
  serial: "CT019138",
  firmware: "2.0.231.0",
  frontEndSoftware: "1.102.548.801",
  alphaSerial: "RN050773",
  alphaId: "4",
  blockDescription: '"96FX"',
  cpld: "B",
  lidVersion: "54",
  lidBVersion: "236",
};

const ENCODER = new TextEncoder();
const LATIN1 = new TextDecoder("latin1");

/** A pure action command's reply: the bare code, no separator (`usb.md` §3). */
function ok(code = OK_CODE): EmulatorReply {
  return { payload: ENCODER.encode(code) };
}

/** A query's reply: `<value>;<code>`, the separator kept even for an empty value. */
function value(v: string, code = OK_CODE): EmulatorReply {
  return { payload: ENCODER.encode(`${v};${code}`) };
}

/** A `passThrough` reply — raw bytes rather than text (`usb.md` §2). */
function binary(bytes: Uint8Array): EmulatorReply {
  return { payload: bytes, passThrough: true };
}

const fail = () => ok(FAIL_CODE);

/** Strip the quotes an operand or a path may arrive wrapped in. */
function unquote(v: string): string {
  return v.trim().replace(/^"|"$/g, "");
}

export interface EmulatedInstrumentOptions {
  clock: EmulatorClock;
  data?: EmulatorRunData | null;
  identity?: Partial<EmulatorIdentity>;
  /** What `\Storage Card\CurrentRun` already holds — usually the *previous* run (`usb.md` §7.5). */
  initialRunFolder?: Record<string, Uint8Array> | null;
  /** The wall-clock instant simulated time zero corresponds to, for the files' own timestamps. */
  startedAt?: Date;
}

export class EmulatedInstrument {
  readonly identity: EmulatorIdentity;
  readonly fs: EmulatorFilesystem;
  private readonly clock: EmulatorClock;
  private readonly data: EmulatorRunData | null;
  private readonly startedAt: Date;

  /** The protocol currently typed in, one directive per entry (`usb.md` §7.2). */
  private authored: string[] = [];
  private run: EmulatedRun | null = null;
  private lid: "OPEN" | "CLOSED" = "CLOSED";
  private volumeUl = 10;
  private hotLidOperand = "105,30";
  private guidCounter = 0;

  constructor(options: EmulatedInstrumentOptions) {
    this.clock = options.clock;
    this.data = options.data ?? null;
    this.identity = { ...DEFAULT_IDENTITY, ...options.identity };
    this.startedAt = options.startedAt ?? new Date();
    this.fs = new EmulatorFilesystem([
      "\\Storage Card",
      CFX_CURRENT_RUN_DIR,
      CFX_RUN_REPORT_DIR,
    ]);
    for (const [name, bytes] of Object.entries(options.initialRunFolder ?? {})) {
      this.fs.write(`${CFX_CURRENT_RUN_DIR}\\${name}`, bytes);
    }
  }

  /** The run in progress or being held, for a caller that wants to look. */
  get currentRun(): EmulatedRun | null {
    return this.run;
  }

  // ---- dispatch ---------------------------------------------------------

  handle(command: string, payload: Uint8Array): EmulatorReply | null {
    const line = command.trim();
    // Every reply is answered from the same instant, and the run folder is brought up to date
    // first — so a listing and the `STATUS?` beside it can never disagree about whether a plate
    // read exists yet.
    const now = this.clock.now();
    this.run?.materialise(now);

    const [verb = "", rest = ""] = splitVerb(line);
    const upper = verb.toUpperCase();

    if (upper === "STATUS?") return this.status();
    if (upper === "RTSTATUS?") return this.rtStatus();
    if (upper === "ERRORLIST") return value("");

    const identity = this.identityReply(line);
    if (identity) return identity;

    const file = this.fileCommand(upper, rest, payload);
    if (file) return file;

    const control = this.runCommand(upper, rest, now);
    if (control) return control;

    // Anything left that is a protocol directive is authoring (`usb.md` §7.2). Checked last so
    // that `VOLUME?` reaches the query table above and `VOLUME 25` reaches this.
    if (isRunDefinitionVerb(upper)) return this.author(line, upper, rest);

    switch (upper) {
      case "PROTOCOL":
        // Not a lookup — there is no stored-protocol library (`usb.md` §5.1). It names the
        // protocol being typed into the one slot the instrument has, so it clears that slot.
        this.authored = [];
        return ok();
      case "LID":
        if (/^OPEN$/i.test(rest)) this.lid = "OPEN";
        else if (/^CLOSE$/i.test(rest)) this.lid = "CLOSED";
        else return fail();
        return ok();
      case "BLOCKID":
      case "TESTMODE":
      case "SETAPILOGLEVEL":
      case "FRONTENDLOCKED":
        return ok();
      case "SETDATETIME":
        // The one command that looks like an action and isn't: it reports success as a value.
        return value("True");
      default:
        return fail();
    }
  }

  // ---- status -----------------------------------------------------------

  private snapshot(now: number): RunSnapshot | null {
    const snap = this.run?.observe(now) ?? null;
    return snap && snap.visible ? snap : null;
  }

  private status(): EmulatorReply {
    // The accelerated clock moves here and nowhere else: the host asking what is happening is
    // what makes the next thing happen (`emulator.md` §6).
    this.clock.poll(this.run?.observe(this.clock.now()).nextEventAtMs ?? null);
    const now = this.clock.now();
    this.run?.materialise(now);
    const snap = this.snapshot(now);

    if (!snap) {
      return value(
        [
          AMBIENT_C.toFixed(2),
          AMBIENT_C.toFixed(1),
          "0",
          "0",
          "IDLE",
          "0",
          '"",BLOCK,OFF',
          "0",
          "0.00",
          "0.00",
          "0.00",
          "0.00",
          "0.00",
          "0",
          "0",
          "0",
          AMBIENT_C.toFixed(2),
          this.lid,
          "0",
        ].join(";"),
      );
    }

    const run = this.run!;
    // Field 7, the status register (`usb.md` §3.2). Flags, not an enumeration.
    let flags = 0;
    if (snap.finished) {
      flags = 0x20 | (snap.cancelled ? 0x80 : 0);
    } else {
      flags = 0x20 | 0x40;
      if (snap.preheating) flags |= 0x08;
      if (snap.atTarget) flags |= 0x01;
      if (snap.paused) flags |= 0x02;
    }
    const descriptor = `"${reportedRunName(run.request.name)}",${run.request.method},${
      snap.finished ? "OFF" : run.request.lidOn ? "ON" : "OFF"
    }`;
    return value(
      [
        snap.blockTempC.toFixed(2),
        snap.lidTempC.toFixed(1),
        // Fields 2 and 3 are byte-identical in every sample `usb.md` §3.2 has, so they are
        // written the same here rather than inventing a distinction the traffic cannot support.
        String(snap.finished ? 0 : snap.cycle),
        String(snap.finished ? 0 : snap.cycle),
        snap.stepText,
        String(snap.finished ? 0 : snap.stepNumber),
        descriptor,
        String(flags),
        snap.elapsedS.toFixed(2),
        snap.stepElapsedS.toFixed(2),
        snap.remainingS.toFixed(2),
        snap.rampElapsedS.toFixed(2),
        snap.holdElapsedS.toFixed(2),
        snap.paused ? "1" : "0",
        "0",
        String(snap.stepCount),
        snap.sampleTempC.toFixed(2),
        this.lid,
        "0",
      ].join(";"),
    );
  }

  /** `RTSTATUS?` — the optical head's shuttle and ambient temperatures, and an empty fault list
   * (`usb.md` §3.3). The shuttle climbs during the run's warm-up alongside the lid and settles
   * around 45 °C; the empty third field is the healthy reading, not a truncation. */
  private rtStatus(): EmulatorReply {
    const snap = this.snapshot(this.clock.now());
    const shuttle = snap ? (snap.preheating ? 30 : 45.2) : 18.31;
    return value(`${shuttle.toFixed(2)};26;`);
  }

  // ---- the identity block ----------------------------------------------

  private identityReply(line: string): EmulatorReply | null {
    const id = this.identity;
    const table: Record<string, string> = {
      "*IDN?": `${id.manufacturer},${id.model},${id.serial},${id.firmware}`,
      "SOFTWARE?": id.firmware,
      "FrontEndSoftware?": id.frontEndSoftware,
      "BASESN?": id.serial,
      "ALPHASN?": id.alphaSerial,
      "ALPHAID?": id.alphaId,
      "BLOCKDESC?": id.blockDescription,
      "BLOCKCOUNT?": "1",
      "CPLD?": id.cpld,
      "DEVICES?": "0",
      "VOLUME?": String(this.volumeUl),
      "WORKING?": "True",
      "BOOTMODE?": "False",
      "SELFTEST?": "0",
      "ENABLERT?": "0",
      "ERRORS?": "0",
      GETSIPOSTERRORS: "true;",
      "SUPERLOCKDOWNMODE?": "OFF",
      GETFREESPACE: "4018397184",
      GETTOTALRAM: "96014336",
      "NAME?": `"${this.run ? reportedRunName(this.run.request.name) : ""}"`,
      "LIDFORCE?": "AUTO",
      "LIDVERSION?": id.lidVersion,
      "LIDBVERSION?": id.lidBVersion,
      "GETPOS?": "0",
      "PAUSE?": this.run?.isPaused ? "True" : "False",
    };
    for (const [command, reply] of Object.entries(table)) {
      if (line.toUpperCase() === command.toUpperCase()) return value(reply);
    }
    return null;
  }

  // ---- filesystem -------------------------------------------------------

  private fileCommand(verb: string, rest: string, payload: Uint8Array): EmulatorReply | null {
    switch (verb) {
      case "GETFILESLEN": {
        const answer = this.fs.getFilesLen(unquote(rest));
        return answer.kind === "length" ? value(String(answer.value)) : binary(answer.bytes);
      }
      case "LISTALLFILES":
        // The measured quirk, reproduced deliberately: whatever the last GETFILESLEN buffered,
        // *ignoring the path given here* (`usb.md` §5).
        return value(this.fs.listAllFiles());
      case "GETFILESIZE": {
        const bytes = this.fs.read(unquote(rest));
        return bytes ? value(String(bytes.length)) : fail();
      }
      case "GETFILE": {
        const bytes = this.fs.read(unquote(rest));
        // The file and nothing else — no trailing `;0000` (`usb.md` §5).
        return bytes ? binary(bytes) : fail();
      }
      case "DELFILE":
        // A missing file is not an error: a first upload to a clean directory always gets this
        // (`usb.md` §7.4).
        return this.fs.delete(unquote(rest)) ? ok() : binary(FILE_MISSING);
      case "CRCSENDFILE":
        return this.receiveFile(payload);
      case "COMPUTEFILECRC": {
        // Despite the name it returns no CRC: it hands back the GUID name the device stored the
        // just-uploaded file under (`usb.md` §5, step 3).
        const stored = this.fs.stagedPath;
        return stored && this.fs.read(unquote(rest)) ? value(stored) : fail();
      }
      case "GETFILECRC": {
        const bytes = this.fs.read(unquote(rest));
        // Recomputed over what was actually stored, never echoed back — a corrupted upload has
        // to be able to disagree with the checksum that announced it.
        return bytes ? value(String(cfxFileCrc(bytes))) : fail();
      }
      default:
        return null;
    }
  }

  /**
   * `CRCSENDFILE "<crc>*<path>",<raw bytes>` — the one command whose payload is not all text, so
   * it is parsed out of the raw message rather than the decoded line (`usb.md` §5).
   */
  private receiveFile(payload: Uint8Array): EmulatorReply {
    const head = LATIN1.decode(payload.slice(0, 512));
    const match = /^CRCSENDFILE "(\d+)\*([^"]*)",/.exec(head);
    if (!match) return fail();
    const path = match[2]!;
    const bytes = payload.slice(ENCODER.encode(match[0]!).length);
    this.guidCounter++;
    // Deterministic rather than random: an emulated session should replay identically.
    const guid = `0e72e6e2-5b85-4d00-b08a-${String(this.guidCounter).padStart(12, "0")}`;
    this.fs.receive(path, bytes, guid);
    return ok();
  }

  // ---- authoring and run control ---------------------------------------

  private author(line: string, verb: string, rest: string): EmulatorReply {
    if (verb === "HOTLID") this.hotLidOperand = rest.trim();
    if (verb === "VOLUME") {
      const n = Number(rest.trim());
      if (!Number.isFinite(n)) return fail();
      this.volumeUl = n;
    }
    this.authored.push(line);
    return ok();
  }

  private runCommand(verb: string, rest: string, now: number): EmulatorReply | null {
    switch (verb) {
      case "REMOTERUN":
        return this.remoteRun(rest, now);
      case "ADDCYCLES": {
        // `ADDCYCLES 0` is what a run's setup sends, and it is a no-op. Extending a *running*
        // protocol's loop is deliberately not modelled, and rejecting says so rather than
        // pretending it worked (`emulator.md` §8).
        return rest.trim() === "0" ? ok() : fail();
      }
      case "PROCEED":
        this.run?.proceed(now);
        return ok();
      case "PAUSE":
        this.run?.pause(now);
        return ok();
      case "RESUME":
        this.run?.resume(now);
        return ok();
      case "CANCEL":
        return this.cancel(now);
      default:
        return null;
    }
  }

  /**
   * `CANCEL` — and it is two different things (`usb.md` §7.6, §7.8).
   *
   * On a run still cycling it aborts. On the finished-but-held run it is the acknowledgement that
   * releases it, and only then do `ended`, the last read and the `.alf` appear. Inside the ~6 s
   * start window it is answered `0000` and does nothing at all, and the run starts anyway — which
   * is exactly why stopping a run takes two of these and why a client has to remember that it
   * asked for one.
   */
  private cancel(now: number): EmulatorReply {
    const run = this.run;
    if (!run) return ok();
    const snap = run.observe(now);
    if (!snap.visible) return ok(); // the start window: accepted, ignored
    if (snap.finished) {
      run.acknowledge(now);
      this.run = null;
      return ok();
    }
    run.abort(now);
    return ok();
  }

  private remoteRun(rest: string, now: number): EmulatorReply {
    const operands = parseOperands(rest);
    if (!operands || operands.length !== 8) return fail();
    const [block, lidOn, remoteStart, name, user, sampleId, sierra, method] = operands as string[];
    const bool = (v: string): boolean | null =>
      /^true$/i.test(v) ? true : /^false$/i.test(v) ? false : null;
    const lid = bool(lidOn!);
    const remote = bool(remoteStart!);
    const autonomous = bool(sierra!);
    if (!/^[AB]$/i.test(block!)) return fail();
    if (lid === null || remote === null || autonomous === null) return fail();
    if (!["CALC", "BLOCK", "OTHER"].includes(method!.toUpperCase())) return fail();
    // Both off-values are real parts of the language and neither is modelled here: a
    // remote-start run waits for a human at a touchscreen this has none of, and a non-autonomous
    // run needs the optical protocol nothing in this project has reversed (`usb.md` §6).
    // Rejecting is the honest answer — see `emulator.md` §8.
    if (remote || !autonomous) return fail();
    if (this.run) return fail();
    if (this.authored.length === 0) return fail();

    const request: RunRequest = {
      name: name!,
      user: user!,
      method: method!.toUpperCase(),
      lidOn: lid,
      sampleId: sampleId!,
      directives: [...this.authored],
      lidTemperatureC: Number(this.hotLidOperand.split(",")[0]) || 105,
      hotLidOperand: this.hotLidOperand,
      volumeUl: this.volumeUl,
    };
    let run: EmulatedRun;
    try {
      run = new EmulatedRun(
        request,
        now,
        new Date(this.startedAt.getTime() + now),
        this.fs,
        this.data,
        {
          alphaSerial: this.identity.alphaSerial,
          baseSerial: this.identity.serial,
          blockLetter: block!.toUpperCase(),
          blockType: "CFX96",
          cyclerName: this.identity.serial,
        },
      );
    } catch {
      // A protocol that cannot be executed on paper — a `GOTO` off the end of the step list, or
      // a loop that never terminates. The instrument would not run it either.
      return fail();
    }
    // A compact `MELT` directive stands for a whole melt curve, and how many reads it produces
    // follows from operands nothing in this project has ever seen an instance of — so the number
    // would be invented, exactly as `expectedPlateReads` refuses to guess it. A melt spelled out
    // the long way (a `PLATEREAD` inside a `GOTO` loop, which is what every stored protocol here
    // uses) runs normally.
    if (run.program.directives.some((d) => d.verb === "MELT")) return fail();
    if (run.producesRunFile && !this.data) {
      throw new Error(
        "this emulator was given no run data, so it cannot produce the plate reads this " +
          "protocol asks for — pass `data` to createCfxEmulator()",
      );
    }
    this.run = run;
    return ok();
  }
}

/** Split a command line into its verb and the rest. `LID OPEN` and `ERRORLIST A` both land with
 * the operand in `rest`. */
function splitVerb(line: string): [string, string] {
  const cut = line.indexOf(" ");
  return cut < 0 ? [line, ""] : [line.slice(0, cut), line.slice(cut + 1)];
}

/** `"A","True",…` → the eight operands, or null if the quoting doesn't parse. */
function parseOperands(rest: string): string[] | null {
  const out: string[] = [];
  for (const part of rest.split(",")) {
    const m = /^"(.*)"$/.exec(part.trim());
    if (!m) return null;
    out.push(m[1]!);
  }
  return out;
}

/** The run name as `STATUS?` reports it back: uppercased and cut to eight characters
 * (`usb.md` §7.3 — `singletest` → `SINGLETE`). */
function reportedRunName(name: string): string {
  return name.toUpperCase().slice(0, 8);
}
