#!/usr/bin/env node
/**
 * Replay a USBPcap capture of CFX Manager talking to a real CFX96 at the emulator, and report
 * every command the instrument answered that the emulator answers differently — and every one it
 * does not implement at all. `emulator.md` §10.2; the output is what populates its Appendix A.
 *
 *   node tools/emucheck.mjs ~/lab/BioRad/CFX-usb-run.pcapng [--device N] [--data <run.zpcr>] [--all]
 *
 * The captures live outside the repository, so this is run by hand, not by `npm test`. Needs a
 * built core (`npm run build -w @zpcrweb/core`) and Python 3 with `dpkt` for the decode, which
 * `usbpcap_decode.py --jsonl` does; this script only pairs, replays and compares.
 *
 * What "differently" means, per exchange, in the order it is decided:
 *
 *   unanswered   the emulator returned nothing (it never does today; kept so a future "stopped
 *                answering" injection can't pass as agreement)
 *   shape        `<value>;<code>` versus a bare code, or text versus raw bytes
 *   code         the four-digit result code differs — split into *rejected* (the instrument said
 *                `0000`, the emulator didn't: a command it does not implement, or is stricter
 *                about than the real thing) and *accepted* (the reverse: the emulator is more
 *                permissive, the failure Appendix A cares about most)
 *   value        same shape and code, different text — the interesting ones are listed, the
 *                expected ones (free space, a GUID, a clock) are named as such
 *   bytes        a binary reply that is not byte-identical
 *   exact        identical, GUIDs masked
 *
 * Then the run itself: every `STATUS?` edge (step, cycle, descriptor, register) each side passed
 * through, side by side with the capture time it happened at — the sequence the follower keys on.
 *
 * The emulator is seeded before replay with what the capture shows the instrument holding when it
 * began — the first listing of each directory, with the bytes of whatever the capture went on to
 * download — so listings and file commands compare against the same folder rather than an empty
 * one. Anything the capture itself creates later is left for the emulator to produce. The
 * capture's own `COMPUTEFILECRC` GUIDs are mapped onto the emulator's as they appear, the way the
 * fidelity test does, so a later command naming one reaches the right staged file.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseResponse, unzipArchive } from "../packages/core/dist/index.js";
import { createCfxEmulator, manualClock, recordedRunData } from "../packages/core/dist/emulator.js";

const here = dirname(fileURLToPath(import.meta.url));
const DECODER = resolve(here, "usbpcap_decode.py");
const DEFAULT_DATA = resolve(here, "../samples/20260807-YouSeq_RT_-_S56.zpcr");
const LATIN1 = new TextDecoder("latin1");
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// ---- arguments ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const all = args.includes("--all");
if (all) args.splice(args.indexOf("--all"), 1);
const deviceArg = flag("--device");
const dataPath = flag("--data") ?? DEFAULT_DATA;
const python = flag("--python") ?? "python3";
const capture = args[0];
if (!capture || args.length !== 1) {
  console.error("usage: node tools/emucheck.mjs <capture.pcapng> [--device N] [--data <run.zpcr>] [--all]");
  process.exit(2);
}

// ---- decode ------------------------------------------------------------------------------

function decode(argv) {
  const r = spawnSync(python, [DECODER, capture, ...argv], { maxBuffer: 1 << 28, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || `usbpcap_decode.py exited ${r.status}`);
    process.exit(2);
  }
  return r.stdout;
}

let device = deviceArg === undefined ? undefined : Number(deviceArg);
if (device === undefined) {
  const summary = decode([]);
  const m = /device #(\d+):.*<-- CFX96/.exec(summary);
  if (!m) {
    console.error("no CFX96 (VID 0x0614) in this capture; pass --device N:\n" + summary);
    process.exit(2);
  }
  device = Number(m[1]);
}

const messages = decode(["--device", String(device), "--jsonl"])
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const m = JSON.parse(line);
    return { ...m, body: Uint8Array.from(Buffer.from(m.body, "base64")) };
  });

// ---- pair --------------------------------------------------------------------------------

/** Each host command on the text channel with the instrument's reply to it: the next channel-1
 * message inbound. Everything on another channel is counted, not modelled (`usb.md` §4). */
const exchanges = [];
let otherChannels = 0;
const t0 = messages[0]?.ts ?? 0;
for (let i = 0; i < messages.length; i++) {
  const m = messages[i];
  if (m.channel !== 1) {
    otherChannels++;
    continue;
  }
  if (m.dir !== "OUT") continue;
  const reply = messages.slice(i + 1).find((r) => r.channel === 1);
  if (!reply || reply.dir !== "IN") continue;
  const command = LATIN1.decode(m.body).replace(/\r?\n$/, "");
  const verb = command.trim().split(/[ ,"]/)[0] ?? "";
  exchanges.push({ i: m.i, atMs: (m.ts - t0) * 1000, command, verb, payload: m.body, reply });
}
// A `GETFILE` longer than one message arrives as consecutive full messages and a remainder
// (`usb.md` §5): the reply is all of them, joined — found by the `GETFILESIZE` just before it.
for (let k = 0; k < exchanges.length; k++) {
  const ex = exchanges[k];
  if (ex.verb !== "GETFILE" || ex.reply.passthrough) continue;
  const sized = exchanges[k - 1];
  if (sized?.verb !== "GETFILESIZE" || sized.reply.passthrough) continue;
  const expected = Number(parseResponse(sized.reply.body).value);
  if (!(expected > ex.reply.body.length)) continue;
  const parts = [ex.reply.body];
  let total = ex.reply.body.length;
  for (let j = messages.findIndex((x) => x.i === ex.reply.i) + 1; j < messages.length && total < expected; j++) {
    const x = messages[j];
    if (x.channel !== 1) continue;
    if (x.dir !== "IN") break;
    parts.push(x.body);
    total += x.body.length;
  }
  if (total === expected) ex.reply = { ...ex.reply, body: Buffer.concat(parts) };
}

// ---- seed --------------------------------------------------------------------------------

/** The path a file command names: quoted, or everything after the verb (paths carry spaces). */
const quoted = (command) =>
  /"([^"]*)"/.exec(command)?.[1] ?? command.trim().replace(/^\S+\s*/, "");
const replyText = (payload) => LATIN1.decode(payload).replace(/\r?\n$/, "");
const isText = (reply) => !reply.passthrough && /(^|;)\d{4}$/.test(replyText(reply.body));

const dataBytes = readFileSync(dataPath);
const emulator = createCfxEmulator({
  clock: manualClock(),
  data: recordedRunData(unzipArchive(new Uint8Array(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength))),
});
const { instrument, clock } = emulator;

// What the instrument held when the capture began: the first listing of each directory names
// it, a `GETFILESIZE` gives a size, and a `GETFILE` gives the bytes — used only when they are
// the whole file, since a download longer than one message arrives split and only its first
// part is paired here. Anything the capture itself creates later (an upload, a run's reads, its
// report) is left for the emulator to produce, which is the point of the comparison.
const sizes = new Map();
const contents = new Map();
for (const ex of exchanges) {
  if (ex.verb === "GETFILESIZE" && isText(ex.reply)) {
    sizes.set(quoted(ex.command), Number(parseResponse(ex.reply.body).value));
  }
  if (ex.verb === "GETFILE" && !isText(ex.reply)) contents.set(quoted(ex.command), ex.reply.body);
}
const initial = new Map(); // dir → names, from its first listing
for (let k = 0; k < exchanges.length; k++) {
  const ex = exchanges[k];
  if (ex.verb !== "GETFILESLEN") continue;
  const dir = quoted(ex.command).replace(/[\\/]+$/, "");
  if (initial.has(dir)) continue;
  const listing = exchanges.slice(k + 1).find((e) => e.verb === "LISTALLFILES");
  if (!listing) continue;
  const names = isText(listing.reply) ? (parseResponse(listing.reply.body).value ?? "").split(",") : [];
  initial.set(dir, names.filter(Boolean));
}
let seededFiles = 0;
let seededNames = 0;
for (const [dir, names] of initial) {
  for (const name of names) {
    const path = `${dir}\\${name}`;
    const size = sizes.get(path);
    const bytes = contents.get(path);
    if (bytes && (size === undefined || bytes.length === size)) {
      instrument.fs.write(path, bytes);
      seededFiles++;
    } else {
      instrument.fs.write(path, new Uint8Array(size ?? 0));
      seededNames++;
    }
  }
}

// ---- replay ------------------------------------------------------------------------------

const maskGuids = (s) => s.replace(GUID, "<guid>");
const shapeOf = (text) => (/^\d{4}$/.test(text) ? "code" : text.includes(";") ? "value;code" : "text");

/** Value differences that cannot be anything but a difference of instrument: not a drift. */
function expectedValueDifference(verb) {
  if (verb === "GETFREESPACE") return "free space is the instrument's own";
  if (verb === "COMPUTEFILECRC") return "the staging GUID is minted per instrument";
  if (verb === "STATUS?" || verb === "RTSTATUS?") return "live temperatures and clocks";
  if (verb === "VOLUME?") return "the volume last set on this instrument";
  return null;
}

const perVerb = new Map();
const tally = (verb, kind) => {
  const row = perVerb.get(verb) ?? { n: 0, exact: 0, value: 0, code: 0, shape: 0, bytes: 0, unanswered: 0 };
  row.n++;
  row[kind]++;
  perVerb.set(verb, row);
};
const examples = new Map(); // `${verb}|${kind}` → [{command, mine, theirs}]
const example = (verb, kind, command, mine, theirs) => {
  const key = `${verb}|${kind}`;
  const list = examples.get(key) ?? [];
  if (all || list.length < 1) list.push({ command, mine, theirs });
  examples.set(key, list);
};
const rejected = new Map(); // verbs the instrument accepted and the emulator did not
const accepted = new Map(); // verbs the instrument rejected and the emulator did not
const statusFields = { real: new Set(), emu: new Set(), realCount: new Set(), emuCount: new Set() };
/** The run as each side reported it: every change of step, cycle, descriptor or register. */
const edges = { real: [], emu: [] };
const edgeOf = (fields) => `${fields[4]} ${fields[5]} ${fields[6]} ${fields[17] ?? ""}`;
const observeEdge = (side, atMs, fields) => {
  const key = edgeOf(fields);
  const list = edges[side];
  if (list.at(-1)?.key !== key) list.push({ key, atS: atMs / 1000, elapsed: fields[8] });
};
const guidMap = new Map();

for (const ex of exchanges) {
  if (ex.atMs > clock.now()) clock.advance(ex.atMs - clock.now());
  let line = ex.command;
  for (const [theirs, mine] of guidMap) line = line.split(theirs).join(mine);

  const reply = instrument.handle(line, ex.payload);
  if (!reply) {
    tally(ex.verb, "unanswered");
    example(ex.verb, "unanswered", ex.command, "(nothing)", replyText(ex.reply.body).slice(0, 80));
    continue;
  }
  const theirs = replyText(ex.reply.body);
  const mine = replyText(reply.payload);

  if (!isText(ex.reply)) {
    // A raw reply: a downloaded file, or one of the two four-byte listing answers.
    const same =
      reply.payload.length === ex.reply.body.length &&
      reply.payload.every((b, j) => b === ex.reply.body[j]);
    if (same) tally(ex.verb, "exact");
    else {
      tally(ex.verb, "bytes");
      example(ex.verb, "bytes", ex.command, `${reply.payload.length} B`, `${ex.reply.body.length} B`);
    }
    continue;
  }

  const myShape = shapeOf(mine);
  const theirShape = shapeOf(theirs);
  if (myShape !== theirShape) {
    tally(ex.verb, "shape");
    example(ex.verb, "shape", ex.command, mine.slice(0, 80), theirs.slice(0, 80));
    continue;
  }
  const myCode = parseResponse(reply.payload).code;
  const theirCode = parseResponse(ex.reply.body).code;
  if (myCode !== theirCode) {
    tally(ex.verb, "code");
    example(ex.verb, "code", ex.command, mine.slice(0, 80), theirs.slice(0, 80));
    const bucket = theirCode === "0000" ? rejected : accepted;
    bucket.set(ex.verb, (bucket.get(ex.verb) ?? 0) + 1);
    continue;
  }
  if (ex.verb === "STATUS?") {
    const r = parseResponse(ex.reply.body).fields;
    const e = parseResponse(reply.payload).fields;
    observeEdge("real", ex.atMs, r);
    observeEdge("emu", ex.atMs, e);
    statusFields.realCount.add(r.length);
    statusFields.emuCount.add(e.length);
    r.forEach((f, j) => f !== "" && f !== "0" && statusFields.real.add(j));
    e.forEach((f, j) => f !== "" && f !== "0" && statusFields.emu.add(j));
  }
  if (ex.verb === "COMPUTEFILECRC") {
    guidMap.set(theirs.split(";")[0].replace(/^"|"$/g, ""), mine.split(";")[0].replace(/^"|"$/g, ""));
  }
  if (maskGuids(mine) === maskGuids(theirs)) tally(ex.verb, "exact");
  else {
    tally(ex.verb, "value");
    example(ex.verb, "value", ex.command, mine.slice(0, 400), theirs.slice(0, 400));
  }
}

// ---- report ------------------------------------------------------------------------------

const pad = (s, w) => String(s).padEnd(w);
const num = (n, w) => String(n).padStart(w);
console.log(`${capture}: device #${device}, ${exchanges.length} command/reply pairs on channel 1, ` +
  `${otherChannels} messages on other channels (not modelled, usb.md §4)`);
console.log(`emulator seeded with ${seededFiles} files the capture downloaded whole and ${seededNames} ` +
  `names it only listed or sized\n`);

console.log(`${pad("verb", 20)}${num("n", 6)}${num("exact", 7)}${num("value", 7)}${num("code", 6)}${num("shape", 7)}${num("bytes", 7)}${num("none", 6)}`);
const rows = [...perVerb].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
for (const [verb, r] of rows) {
  console.log(`${pad(verb, 20)}${num(r.n, 6)}${num(r.exact, 7)}${num(r.value, 7)}${num(r.code, 6)}${num(r.shape, 7)}${num(r.bytes, 7)}${num(r.unanswered, 6)}`);
}

const section = (title) => console.log(`\n${title}`);
if (rejected.size) {
  section("REJECTED by the emulator, accepted by the instrument — unimplemented, or stricter than the real thing:");
  for (const [verb, n] of rejected) {
    const ex = examples.get(`${verb}|code`)?.[0];
    console.log(`  ${pad(verb, 20)} ×${n}   ${ex.command.slice(0, 70)}\n${pad("", 26)}emulator ${ex.mine}   instrument ${ex.theirs}`);
  }
}
if (accepted.size) {
  section("ACCEPTED by the emulator, rejected by the instrument — the emulator is MORE PERMISSIVE here:");
  for (const [verb, n] of accepted) {
    const ex = examples.get(`${verb}|code`)?.[0];
    console.log(`  ${pad(verb, 20)} ×${n}   ${ex.command.slice(0, 70)}\n${pad("", 26)}emulator ${ex.mine}   instrument ${ex.theirs}`);
  }
}
for (const kind of ["shape", "unanswered", "bytes"]) {
  const hits = [...examples].filter(([k]) => k.endsWith(`|${kind}`));
  if (!hits.length) continue;
  section(`${kind.toUpperCase()} differs:`);
  for (const [key, list] of hits) {
    for (const ex of list) {
      console.log(`  ${pad(key.split("|")[0], 20)}${ex.command.slice(0, 70)}\n${pad("", 22)}emulator ${ex.mine}   instrument ${ex.theirs}`);
    }
  }
}
const valueHits = [...examples].filter(([k]) => k.endsWith("|value"));
if (valueHits.length) {
  section("VALUE differs (same shape, same code):");
  for (const [key, list] of valueHits) {
    const verb = key.split("|")[0];
    const why = expectedValueDifference(verb);
    for (const ex of list) {
      console.log(`  ${pad(verb, 20)}${ex.command.slice(0, 70)}${why ? `   [expected: ${why}]` : ""}\n` +
        `${pad("", 22)}emulator   ${ex.mine}\n${pad("", 22)}instrument ${ex.theirs}`);
    }
  }
}
if (statusFields.realCount.size) {
  const list = (s) => [...s].sort((a, b) => a - b).join(",");
  section("STATUS? fields:");
  console.log(`  field counts   instrument ${list(statusFields.realCount)}   emulator ${list(statusFields.emuCount)}`);
  console.log(`  ever populated instrument ${list(statusFields.real)}\n                 emulator   ${list(statusFields.emu)}`);
}
if (edges.real.length > 1 || edges.emu.length > 1) {
  section("STATUS? edges — step, cycle, descriptor, register; at capture seconds, with the run's elapsed:");
  const n = Math.max(edges.real.length, edges.emu.length);
  const cell = (e) => (e ? `${e.atS.toFixed(1).padStart(7)}s ${String(e.elapsed).padStart(7)}  ${e.key}` : "");
  console.log(`  ${pad("instrument", 64)}emulator`);
  for (let k = 0; k < n; k++) console.log(`  ${pad(cell(edges.real[k]), 64)}${cell(edges.emu[k])}`);
  const same = edges.real.map((e) => e.key).join("|") === edges.emu.map((e) => e.key).join("|");
  console.log(`  ${same ? "same edges in the same order" : "EDGES DIFFER"}`);
}

const edgesDiffer =
  edges.real.length > 1 && edges.real.map((e) => e.key).join("|") !== edges.emu.map((e) => e.key).join("|");
const drift =
  rejected.size + accepted.size + [...examples.keys()].filter((k) => /\|(shape|unanswered)$/.test(k)).length +
  (edgesDiffer ? 1 : 0);
process.exit(drift ? 1 : 0);
