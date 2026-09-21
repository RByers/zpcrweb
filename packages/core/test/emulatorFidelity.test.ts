/**
 * The emulator against the one recorded conversation with a real instrument — `emulator.md` §10.1.
 *
 * Every other emulator test proves the emulator is *self-consistent*: it answers the way we think
 * a CFX96 answers, to a client written from the same document. This one is the only check in the
 * suite with an outside witness. `samples/20260807-YouSeq_RT_-_S56.zpcr` carries a
 * `usb-traffic.bin` — 10 780 messages of a complete session against CT019138, connect → author →
 * start → watch → finish → pull — recorded by this app itself. The test replays every host→device
 * command out of it, in order, at the emulator, on a clock advanced to the recording's own
 * timestamps, and compares what comes back with what the instrument said.
 *
 * **How far this reaches, stated before anything else.**
 *
 * - It is **one session, of one run**: `METHOD BLOCK`, three `TEMP` steps, no `PLATEREAD`. That
 *   is a *heat-block* run (`usb.md` §7.10) — so this log witnesses the thermal path and, through
 *   the folder it pulls at the end, the file transfer of a previous qPCR run's output. **No
 *   recorded traffic exists for a qPCR run's execution, a melt, a cancel, or a pause**, and
 *   nothing here says anything about them (`emulator.md` §11).
 * - **Every result code in the recording is `0000`.** The instrument was never asked anything it
 *   refused, so the property `emulator.md` Appendix A cares about most — that the emulator is
 *   never *more permissive* than the instrument — is untestable from this file. All this can
 *   check is that the emulator does not invent a failure where the instrument succeeded.
 * - A different clock ran. Temperatures, elapsed seconds, GUIDs, free space and file timestamps
 *   cannot match and are never asserted equal; they are compared for shape, population and
 *   plausible range, and every difference is **listed in the test's output** rather than quietly
 *   tolerated.
 *
 * What it *does* prove, and what a failure here means: the emulator's reply to each of the ~5 390
 * commands has the shape the instrument's had (value + `;` + code, a bare code, or raw bytes),
 * the same result code, the same listing, byte-identical file contents, a `STATUS?` record of the
 * same twenty fields with the same ones populated in each phase of the run, and the same sequence
 * of run edges. Where it *knowingly* differs, the difference is one of {@link KNOWN_DIVERGENCES},
 * each of which is recorded in `emulator.md`; anything else fails and names the command.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseResponse,
  parseUsbTrafficLog,
  unzipArchive,
  type UsbTrafficMessage,
  type ZpcrArchive,
} from "../src/index.js";
import {
  createCfxEmulator,
  manualClock,
  type CfxEmulator,
  type EmulatorReply,
} from "../src/emulator.js";
import { RT_S56_SAMPLE_PATH } from "./sample.js";

const RUN_REPORTS = "\\Storage Card\\PCRunReport";
const LATIN1 = new TextDecoder("latin1");

/**
 * Differences between the emulator and the recording that are **understood and deliberate**, each
 * with its entry in `emulator.md`. A difference outside this set fails the run: the point of a
 * fidelity check is that it cannot be quietly widened.
 */
const KNOWN_DIVERGENCES = new Set([
  // The instrument terminates some replies with CRLF and others bare, per command (§10.1). The
  // emulator emits none. `parseResponse` strips either, so nothing in the client notices today.
  "crlf-terminator",
  // `GETFILE`'s reply is *not* a `passThrough` message on the real instrument — printable files
  // come back recorded as text. The emulator marks it passThrough.
  "getfile-passthrough",
  // Instrument-specific values that cannot match: free space and the staging GUID.
  "instrument-value",
  // The emulator serves this folder out of the archive, and the archive is not always a
  // byte-identical copy of what the instrument held — the app rewrote two of these files on the
  // way in. Not an emulator behaviour at all: it serves exactly the bytes it was given.
  "archive-copy-differs",
  // The staging GUID copy of an upload is gone from the instrument's listing by the end of the
  // run; the emulator keeps it until the next upload.
  "staging-guid-lifetime",
  // A file deleted and written again keeps its place in the instrument's listing; the emulator's
  // listing moves it to the end.
  "listing-order",
  // The instrument's at-target bit can fall back to 0 for a poll after the hold has begun; the
  // emulator's never does once a step has arrived.
  "at-target-flicker",
  // The emulator's modelled run is ~20 s longer than this instrument's was, which is enough to
  // change what the session's last `CANCEL` means.
  "run-duration-model",
]);

// ---- the recording ------------------------------------------------------------------------

interface Exchange {
  /** Index of the host→device record in the log. */
  index: number;
  /** Simulated ms since the first recorded message. */
  atMs: number;
  /** The command line, terminator stripped. */
  command: string;
  verb: string;
  /** The raw host→device payload — `CRCSENDFILE` carries a file in it. */
  payload: Uint8Array;
  /** The instrument's reply. */
  reply: UsbTrafficMessage;
}

interface Recording {
  archive: ZpcrArchive;
  exchanges: Exchange[];
  /** The `\Storage Card\CurrentRun` listing as the session's first `LISTALLFILES` reported it. */
  initialNames: string[];
  reportName: string;
}

function loadRecording(): Recording {
  const buf = readFileSync(RT_S56_SAMPLE_PATH);
  const archive = unzipArchive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  const records = parseUsbTrafficLog(archive["usb-traffic.bin"]!).filter(
    (r): r is UsbTrafficMessage => r.kind === "message",
  );
  const t0 = records[0]!.at;
  const exchanges: Exchange[] = [];
  for (let i = 0; i < records.length; i++) {
    const out = records[i]!;
    if (out.direction !== "out") continue;
    const reply = records[i + 1];
    // Every command in this log is answered by the very next record; a log that interleaved
    // differently would need pairing by channel, and saying so is cheaper than pretending.
    if (!reply || reply.direction !== "in") continue;
    const command = (out.text ?? LATIN1.decode(out.payload.slice(0, 512))).replace(/\r?\n$/, "");
    exchanges.push({
      index: i,
      atMs: out.at - t0,
      command,
      verb: command.trim().split(/[ ,"]/)[0] ?? "",
      payload: out.payload,
      reply,
    });
  }
  const firstListing = exchanges.find((e) => e.verb === "LISTALLFILES")!;
  const initialNames = parseResponse(firstListing.reply.payload).value!.split(",");
  const reportName = initialNames.find((n) => n.endsWith(".alf"))!;
  return { archive, exchanges, initialNames, reportName };
}

// ---- the emulator, seeded to look like that instrument ------------------------------------

/**
 * An emulator whose `CurrentRun` holds what the recording's first listing reported, in the order
 * it reported it — so the listing string, and with it the length `GETFILESLEN` answers, is
 * comparable to the real one rather than merely the same length by luck.
 *
 * The bytes come from the archive, which is what the session pulled off this very folder — with
 * two exceptions the comparison reports as `archive-copy-differs`: `zpcrweb.json`, which the
 * session overwrote (so the archive holds the *new* one, and the first `GETFILESIZE` of it
 * disagrees by five bytes), and the plate `.csv`, whose header the app rewrote on the way into
 * the archive (`FAM Ch1` became `FAM`). Neither is an emulator behaviour: it serves back exactly
 * the bytes it was handed.
 */
function seededEmulator(rec: Recording): CfxEmulator {
  const clock = manualClock();
  const initialRunFolder: Record<string, Uint8Array> = {};
  for (const name of rec.initialNames) {
    initialRunFolder[name] = rec.archive[name] ?? new Uint8Array(0);
  }
  const emulator = createCfxEmulator({ clock, initialRunFolder });
  // The previous run's report, which this session deletes before authoring its own (§7.4).
  emulator.instrument.fs.write(`${RUN_REPORTS}\\${rec.reportName}`, rec.archive[rec.reportName]!);
  return emulator;
}

// ---- comparison --------------------------------------------------------------------------

interface Divergence {
  kind: string;
  command: string;
  detail: string;
}

/** A 36-character GUID, whichever instrument minted it. */
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const maskGuids = (s: string) => s.replace(GUID, "<guid>");

/** The reply as text with the terminator removed — the form `parseResponse` works on. */
function replyText(payload: Uint8Array): string {
  return LATIN1.decode(payload).replace(/\r?\n$/, "");
}

/** Which of the three reply shapes (`usb.md` §3) a payload is. */
function shapeOf(text: string): "value;code" | "code" {
  return /^\d{4}$/.test(text) ? "code" : "value;code";
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A `STATUS?` phase, decoded from the status register (`usb.md` §3.2). */
function phaseOf(fields: string[]): string {
  const reg = Number(fields[7]);
  if (reg === 0) return "idle";
  if (!(reg & 0x40)) return reg & 0x80 ? "finished-cancelled" : "finished";
  if (reg & 0x08) return "preheat";
  return reg & 0x01 ? "hold" : "ramp";
}

/** A field counts as populated when it carries something other than a zero or an empty string —
 * which is what "the same fields are filled in" has to mean when the values themselves cannot
 * match. */
function populated(fields: string[]): number[] {
  const out: number[] = [];
  fields.forEach((f, i) => {
    if (f !== "" && f !== "0" && f !== "0.00" && f !== '"",BLOCK,OFF') out.push(i);
  });
  return out;
}

interface StatusSide {
  /** Phase, then step number and text, deduplicated — the edges a follower keys on. */
  edges: string[];
  /** Per phase, the union of the field indices ever populated in it. */
  populatedByPhase: Map<string, Set<number>>;
  /** Every distinct run descriptor (field 6) seen, in the order they appeared. The one part of
   * `STATUS?` that *can* be compared for equality: it is built out of the operands the host sent
   * (`usb.md` §7.3), so both sides should spell it the same. */
  descriptors: string[];
  samples: { phase: string; fields: string[] }[];
}

function emptyStatusSide(): StatusSide {
  return { edges: [], populatedByPhase: new Map(), descriptors: [], samples: [] };
}

function observeStatus(side: StatusSide, fields: string[]): void {
  const phase = phaseOf(fields);
  const edge = `${phase} step=${fields[5]} ${fields[4]}`;
  if (side.edges[side.edges.length - 1] !== edge) side.edges.push(edge);
  // The cancelled bit changes the register's value, not which fields carry anything, so the two
  // finished states share a bucket here and are told apart in the edge sequence.
  const bucket = phase === "finished-cancelled" ? "finished" : phase;
  const set = side.populatedByPhase.get(bucket) ?? new Set<number>();
  for (const i of populated(fields)) set.add(i);
  side.populatedByPhase.set(bucket, set);
  const descriptor = fields[6] ?? "";
  if (!side.descriptors.includes(descriptor)) side.descriptors.push(descriptor);
  side.samples.push({ phase, fields });
}

interface Replay {
  rec: Recording;
  divergences: Divergence[];
  failures: string[];
  real: StatusSide;
  emu: StatusSide;
  counts: Map<string, number>;
  unanswered: string[];
  /** Commands whose reply was compared byte-for-byte and matched. */
  exact: number;
  /** Of those, `GETFILE` transfers — the run's own files, served back out of the emulator. */
  filesExact: number;
}

/**
 * Drive the emulator with the recording, command for command.
 *
 * Two rewrites are applied to the host's own commands, and both are forced by replaying a
 * transcript at a *different* instrument rather than by any doubt about the emulator:
 *
 * - The GUID `COMPUTEFILECRC` hands back is the instrument's; the host's next `GETFILECRC` quotes
 *   it. Replaying that line verbatim would ask the emulator about a file only the real
 *   instrument ever had, so the recorded GUID is mapped to the emulator's own.
 * - The clock is advanced to each record's own timestamp, so the emulator's run sits at the same
 *   wall-clock moment the real one did. Its internal phase boundaries are its own (its lid
 *   preheat is 168 s against this instrument's ~155 s), which is why phases are compared as a
 *   *sequence* and never per-poll.
 */
function replay(): Replay {
  const rec = loadRecording();
  const emulator = seededEmulator(rec);
  const clock = emulator.clock as ReturnType<typeof manualClock>;
  const out: Replay = {
    rec,
    divergences: [],
    failures: [],
    real: emptyStatusSide(),
    emu: emptyStatusSide(),
    counts: new Map(),
    unanswered: [],
    exact: 0,
    filesExact: 0,
  };
  const note = (kind: string, command: string, detail: string) => {
    if (out.divergences.length < 400) out.divergences.push({ kind, command, detail });
  };
  const guidMap = new Map<string, string>();

  for (const ex of rec.exchanges) {
    out.counts.set(ex.verb, (out.counts.get(ex.verb) ?? 0) + 1);
    const target = Math.max(0, ex.atMs);
    if (target > clock.now()) clock.advance(target - clock.now());

    let line = ex.command;
    for (const [recorded, mine] of guidMap) line = line.split(recorded).join(mine);

    const reply: EmulatorReply | null = emulator.instrument.handle(line, ex.payload);
    if (!reply) {
      out.unanswered.push(ex.command.slice(0, 80));
      continue;
    }
    const mine = replyText(reply.payload);
    const theirs = replyText(ex.reply.payload);

    // The terminator, first: it is a property of every text reply and is checked once here
    // rather than inside each family below.
    if (/\r?\n$/.test(LATIN1.decode(ex.reply.payload)) && ex.verb !== "GETFILE") {
      note("crlf-terminator", ex.verb, "instrument ends this reply CRLF; emulator does not");
    }

    switch (ex.verb) {
      case "STATUS?": {
        const theirFields = parseResponse(ex.reply.payload).fields;
        const myResponse = parseResponse(reply.payload);
        if (myResponse.code !== parseResponse(ex.reply.payload).code) {
          out.failures.push(`STATUS? code ${myResponse.code} vs ${theirs.slice(-4)}`);
        }
        if (myResponse.fields.length !== theirFields.length) {
          out.failures.push(
            `STATUS? has ${myResponse.fields.length} fields, instrument had ${theirFields.length}`,
          );
        }
        observeStatus(out.real, theirFields);
        observeStatus(out.emu, myResponse.fields);
        break;
      }
      case "RTSTATUS?": {
        const mineFields = parseResponse(reply.payload).fields;
        const theirsFields = parseResponse(ex.reply.payload).fields;
        if (mineFields.length !== theirsFields.length) {
          out.failures.push(`RTSTATUS? ${mineFields.length} fields vs ${theirsFields.length}`);
        }
        break;
      }
      case "GETFILE": {
        if (reply.passThrough) {
          note("getfile-passthrough", ex.verb, "emulator marks the file reply passThrough");
        }
        if (bytesEqual(reply.payload, ex.reply.payload)) {
          out.exact++;
          out.filesExact++;
        } else {
          const detail = `${reply.payload.length} B vs ${ex.reply.payload.length} B`;
          const file = fileOf(ex.command);
          if (rec.initialNames.includes(file)) note("archive-copy-differs", `${ex.verb} ${file}`, detail);
          else out.failures.push(`GETFILE ${file}: served ${detail}`);
        }
        break;
      }
      default: {
        // Everything else answers `<value>;<code>` or a bare code, or — for the two measured
        // binary answers — four raw bytes. All three are compared in full.
        if (ex.reply.text === null && !/^\d{4}$/.test(theirs) && !theirs.includes(";")) {
          if (!bytesEqual(reply.payload, ex.reply.payload)) {
            out.failures.push(
              `${ex.verb}: binary reply ${[...reply.payload].join(",")} vs ` +
                `${[...ex.reply.payload].join(",")}`,
            );
          } else out.exact++;
          break;
        }
        const myShape = shapeOf(mine);
        const theirShape = shapeOf(theirs);
        if (myShape !== theirShape) {
          out.failures.push(`${ex.verb}: reply shape ${myShape}, instrument gave ${theirShape}`);
          break;
        }
        const myCode = parseResponse(reply.payload).code;
        const theirCode = parseResponse(ex.reply.payload).code;
        if (myCode !== theirCode) {
          out.failures.push(`${ex.verb}: result code ${myCode}, instrument gave ${theirCode}`);
          break;
        }
        if (maskGuids(mine) === maskGuids(theirs)) {
          out.exact++;
        } else {
          const kind = kindOfValueDifference(ex, mine, theirs, rec);
          if (kind === null) {
            out.failures.push(
              `${ex.verb} ${fileOf(ex.command)}: answered ${mine.slice(0, 80)}, ` +
                `instrument answered ${theirs.slice(0, 80)}`,
            );
            break;
          }
          note(kind, `${ex.verb} ${fileOf(ex.command)}`.trim(), `${mine.slice(0, 60)} vs ${theirs.slice(0, 60)}`);
        }
        if (ex.verb === "COMPUTEFILECRC") {
          const recorded = theirs.split(";")[0]!;
          const ours = mine.split(";")[0]!;
          guidMap.set(recorded.replace(/^"|"$/g, ""), ours.replace(/^"|"$/g, ""));
        }
        break;
      }
    }
  }

  // Two differences belong to the session as a whole rather than to any one command, and are
  // recorded here so they appear in the same list as the rest.
  const lastReal = out.real.samples.at(-1)?.fields ?? [];
  const lastHeld = [...out.emu.samples].reverse().find((s) => s.phase === "hold")?.fields ?? [];
  if (out.emu.edges.at(-1) !== out.real.edges.at(-1)) {
    note(
      "run-duration-model",
      "STATUS?/CANCEL",
      `the instrument had finished and was holding the run (elapsed ${lastReal[8]} s) when the ` +
        `session's CANCEL arrived; the emulator was still on step ${lastHeld[5]} ` +
        `(elapsed ${lastHeld[8]} s, ${lastHeld[10]} s left), so that CANCEL aborted its run ` +
        `instead of acknowledging it`,
    );
  }
  for (const [phase, real] of out.real.populatedByPhase) {
    const mine = out.emu.populatedByPhase.get(phase);
    const missing = mine ? [...real].filter((i) => !mine.has(i)) : [];
    if (phase === "ramp" && missing.join() === "12") {
      note(
        "at-target-flicker",
        "STATUS?",
        "one poll of 2585 reported not-at-target with the hold clock already running " +
          "(block 30.39 against a 30.0 setpoint); the emulator's at-target bit never falls back",
      );
    }
  }
  return out;
}

/** The path a file command names, for a readable report line. */
function fileOf(command: string): string {
  const m = /\\([^\\"]+)"?$/.exec(command.trim());
  return m ? m[1]! : "";
}

/**
 * Which documented reason a value difference falls under, or null when there is none — in which
 * case it is a bug in the emulator and the caller fails the run naming the command.
 *
 * This is the part of the test that decides what "close enough" means, so each branch has to be
 * narrow enough that a real mistake cannot slip through it: a listing is excused only when it
 * holds exactly the same names, a length only when it is over by exactly one GUID entry, a file
 * only when the archive's own copy is what differs.
 */
function kindOfValueDifference(
  ex: Exchange,
  mine: string,
  theirs: string,
  rec: Recording,
): string | null {
  if (ex.verb === "GETFREESPACE" || ex.verb === "COMPUTEFILECRC") return "instrument-value";
  if (ex.verb === "LISTALLFILES") {
    const ours = maskGuids(mine).replace(/;\d{4}$/, "").split(",");
    const them = maskGuids(theirs).replace(/;\d{4}$/, "").split(",");
    const extra = ours.filter((n) => !them.includes(n));
    if (extra.length === 1 && extra[0] === "<guid>") return "staging-guid-lifetime";
    if (ours.length === them.length && [...ours].sort().join() === [...them].sort().join()) {
      return "listing-order";
    }
    return null;
  }
  if (ex.verb === "GETFILESLEN") {
    // 36 characters of GUID plus the comma that joins it to the name before it.
    return Number(mine.split(";")[0]) - Number(theirs.split(";")[0]) === 37
      ? "staging-guid-lifetime"
      : null;
  }
  const file = fileOf(ex.command);
  if ((ex.verb === "GETFILESIZE" || ex.verb === "GETFILE") && rec.initialNames.includes(file)) {
    return "archive-copy-differs";
  }
  return null;
}

// ---- the checks ---------------------------------------------------------------------------

const session = replay();

describe("the emulator against the one recorded session", () => {
  it("replays the whole log, and answers every command", () => {
    // A command the emulator does not implement at all is the one failure that cannot be argued
    // about: the instrument answered it and we would not.
    expect(session.unanswered).toEqual([]);
    expect(session.rec.exchanges.length).toBeGreaterThan(5_000);
  });

  it("gives the same result code, in the same shape, to every command", () => {
    expect(session.failures).toEqual([]);
  });

  it("never disagrees for a reason that is not written down", () => {
    const unknown = session.divergences.filter((d) => !KNOWN_DIVERGENCES.has(d.kind));
    expect(unknown).toEqual([]);
  });

  it("answers the identity block and the file transfers byte for byte", () => {
    // Of the 222 commands that are not a status poll, all but the handful in the divergence list
    // come back exactly as the instrument's did — including the whole final pull: 45 plate
    // reads, 32 `.Dcal`s, the run log and the report, and the CRCs computed over them.
    // Pinned, not bounded: the nine replies that don't match are enumerated in
    // {@link KNOWN_DIVERGENCES}, so any other one moving is a change in what the emulator says
    // and should have to be looked at. A `>` here would let 213 rot to 206 in silence.
    expect(session.exact).toBe(213);
    expect(session.filesExact).toBe(82);
  });

  it("reports the same twenty `STATUS?` fields, populated the same way in each phase", () => {
    // The values cannot match, so what is compared is which fields carry anything at all, phase
    // by phase. The one exception is written down rather than filtered out: see
    // `at-target-flicker` in {@link KNOWN_DIVERGENCES}.
    for (const [phase, real] of session.real.populatedByPhase) {
      const mine = session.emu.populatedByPhase.get(phase);
      expect(mine, `the emulator never reached the ${phase} phase`).toBeDefined();
      const missing = [...real].filter((i) => !mine!.has(i)).sort((a, b) => a - b);
      const extra = [...mine!].filter((i) => !real.has(i)).sort((a, b) => a - b);
      expect(extra, `fields the emulator populates in ${phase} and the instrument does not`).toEqual(
        [],
      );
      if (phase === "ramp" && missing.join() === "12") continue;
      expect(missing, `fields the instrument populates in ${phase} and the emulator does not`).toEqual(
        [],
      );
    }
  });

  it("spells the run descriptor exactly as the instrument did", () => {
    // Field 6 is built from `RemoteRun`'s own operands (`usb.md` §7.3), so unlike every other
    // part of `STATUS?` it can be compared for equality — and it is where the instrument's name
    // mangling shows: `YouSeq RT - S56` comes back `"YOUSEQ_R"`, uppercased, cut to eight and
    // with its space turned into an underscore.
    expect(session.emu.descriptors).toEqual(session.real.descriptors);
  });

  it("passes through the same run edges in the same order", () => {
    // The values differ — a different clock ran — but the *sequence* a run follower keys on must
    // not: idle, the lid preheat, each step's ramp and hold in protocol order, then a finished
    // state the instrument holds until it is acknowledged (`usb.md` §7.6).
    expect(session.emu.edges.length).toBe(session.real.edges.length);
    expect(session.emu.edges.slice(0, -1)).toEqual(session.real.edges.slice(0, -1));
    // The last one differs in a way worth stating rather than asserting around: the emulator's
    // modelled run is ~20 s longer than this instrument's (a 168 s lid preheat against ~155 s,
    // and 10 s per thermal ramp against ~8 s), so the acknowledging `CANCEL` at the end of the
    // recording arrived while its final hold was still going — and a `CANCEL` on a running run
    // aborts it (§7.8), which is why its finish carries the cancelled bit. Every edge before
    // that is identical, which is the part a run follower keys on.
    expect(session.real.edges.at(-1)).toBe("finished step=0 IDLE");
    expect(session.emu.edges.at(-1)).toBe("finished-cancelled step=0 IDLE");
  });

  it("keeps every `STATUS?` value it invents inside a plausible range", () => {
    let previousElapsed = -1;
    for (const { phase, fields } of session.emu.samples) {
      const block = Number(fields[0]);
      const lid = Number(fields[1]);
      const elapsed = Number(fields[8]);
      const remaining = Number(fields[10]);
      expect(block).toBeGreaterThan(0);
      expect(block).toBeLessThanOrEqual(105);
      expect(lid).toBeGreaterThan(0);
      expect(lid).toBeLessThanOrEqual(110);
      expect(remaining).toBeGreaterThanOrEqual(0);
      // A run's elapsed clock only ever advances, which is the invariant the whole follower is
      // built on (`emulator.md` §6).
      if (phase !== "idle") expect(elapsed).toBeGreaterThanOrEqual(0);
      if (phase === "ramp" || phase === "hold") {
        expect(elapsed).toBeGreaterThanOrEqual(previousElapsed);
        previousElapsed = elapsed;
      }
      expect(fields[17]).toBe("CLOSED");
    }
  });

  it("prints what it found, differences included", () => {
    const byKind = new Map<string, Divergence[]>();
    for (const d of session.divergences) {
      (byKind.get(d.kind) ?? byKind.set(d.kind, []).get(d.kind)!).push(d);
    }
    const lines = [
      `commands replayed: ${session.rec.exchanges.length}`,
      `  by verb: ${[...session.counts]
        .sort((a, b) => b[1] - a[1])
        .map(([v, n]) => `${v}×${n}`)
        .join(" ")}`,
      `replies matching byte for byte (terminator and GUIDs aside): ${session.exact}` +
        `, of which ${session.filesExact} whole-file transfers`,
      `result codes: every one of them 0000, on both sides — this session refuses nothing`,
      `run edges, instrument: ${session.real.edges.join(" → ")}`,
      `run edges, emulator:   ${session.emu.edges.join(" → ")}`,
      "known differences:",
      ...[...byKind].map(([kind, list]) => {
        const where = [...new Set(list.map((d) => d.command))].slice(0, 6).join(", ");
        return `  ${kind} ×${list.length} — ${where}${list.length > 6 ? ", …" : ""}: ${list[0]!.detail}`;
      }),
    ];
    console.log(lines.join("\n"));
    expect(session.failures).toEqual([]);
  });
});
