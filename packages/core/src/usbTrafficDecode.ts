/**
 * The USB traffic log, explained — every byte of a `usb-traffic.bin` attributed to the field it
 * belongs to, and every message read as the instrument protocol it carries.
 *
 * **The problem.** {@link parseUsbTrafficLog} answers "what crossed the wire", and
 * {@link formatUsbTrafficLog} prints it one line per message. Neither answers the questions a
 * person reading a log actually has: *which* request did this reply answer (the protocol carries
 * no request ids, so that is an inference — `usb.md` §3), what do the twenty `;`-separated numbers
 * of a `STATUS?` reply mean, did that upload's checksum match, and what are these bytes of the
 * file itself. This module answers them, for the Raw files view's *Decoded* mode.
 *
 * Two layers, both pure functions of the file's bytes:
 *
 * 1. **Layout** (`usb-traffic.md` §3) — the container. Each item's type byte, flag bits, varint
 *    delta, channel, length and payload, at its own file offset, so the view accounts for every
 *    byte of the file. Walked independently of `usbTraffic.ts`'s reader so that a damaged tail
 *    is *shown* (as an undecodable remainder) rather than thrown; `usbTrafficDecode.test.ts`
 *    pins the two walks to the same records.
 * 2. **Meaning** (`usb.md` §2–§7) — the payload. Channel-1 requests are matched to replies in
 *    arrival order, exactly as `CfxDevice.dispatch` matches them, and each is read with the
 *    parsers the live client uses (`parseResponse`, `parseStatus`, `parseRtStatus`,
 *    `parseIdentity`, `parseRunDefinition`, `cfxFileCrc`) — one reading of the protocol, not a
 *    second one kept in step by hand.
 *
 * Strings here are shown to the person using the app, so they say things plainly and never cite
 * a repo document; the citations live in the comments beside them.
 */
import { USB_TRAFFIC_MAGIC, usbTrafficText, type UsbTrafficRecord } from "./usbTraffic.js";
import { parseResponse, type CfxResponse } from "./usb/commands.js";
import { parseIdentity, parseRtStatus, parseStatus, type CfxStatus } from "./usb/status.js";
import { cfxFileCrc, formatCfxFileCrc } from "./usb/crc.js";
import { MAX_MESSAGE_PAYLOAD } from "./usb/frame.js";
import { parseRunDefinition } from "./runDefinition.js";

// ---- types -----------------------------------------------------------------------------------

/** One field of the container: a byte range of the file and what it holds. */
export interface UsbTrafficByteField {
  /** Absolute offset in the file. */
  offset: number;
  length: number;
  name: string;
  /** The field's value, decoded. */
  value: string;
  /** What the value means, when that isn't obvious from it. */
  note?: string;
}

/** One labelled reading of something in a payload — a status field, an operand, a reply value. */
export interface UsbPayloadField {
  label: string;
  /** The text exactly as it appears in the payload, when the field is a piece of it. */
  raw?: string;
  /** What it means. */
  value: string;
}

/** What one message (or error) says, beyond its bytes. */
export interface UsbTrafficMeaning {
  /** One line, for the item's row. */
  summary: string;
  /** The command a request carries, or the one a reply answers — `STATUS?`, `GETFILE`, `LID`. */
  command?: string;
  /** For a reply: the item index of the request it answers. */
  replyTo?: number;
  /** For a request: the item indexes of the message(s) that answered it. */
  replies?: number[];
  /** The payload taken apart. */
  fields: UsbPayloadField[];
  /** Sentences of explanation, in reading order. */
  notes: string[];
  /** For a reply carrying a file (or part of one): the file's path on the instrument. */
  file?: string;
}

export type UsbTrafficItemKind = "header" | "segment" | "message" | "error" | "gap" | "invalid";

/** One item of the file, in file order — the 8-byte header counts as item 0. */
export interface UsbTrafficItem {
  index: number;
  kind: UsbTrafficItemKind;
  offset: number;
  length: number;
  /** Epoch ms — for messages and errors (from the running delta), and segments (their base). */
  at?: number;
  /** The record this item decodes to, as {@link parseUsbTrafficLog} returns it. */
  record?: UsbTrafficRecord;
  fields: UsbTrafficByteField[];
  meaning: UsbTrafficMeaning;
}

export interface DecodedUsbTrafficLog {
  items: UsbTrafficItem[];
  /** Why the walk stopped early, or `null` when every byte decoded. */
  error: string | null;
  totals: {
    bytes: number;
    messages: number;
    polls: number;
    errors: number;
    segments: number;
    dropped: number;
    first: number | null;
    last: number | null;
  };
}

// ---- layout ----------------------------------------------------------------------------------

/** Item type bytes and flag bits (`usb-traffic.md` §3, §3.2). Repeated rather than exported from
 * `usbTraffic.ts` so its constants stay private to the format's writer; the test pins the two
 * walks to the same records, which is what would catch a divergence. */
const ITEM_NAMES: Record<number, UsbTrafficItemKind> = {
  0x01: "segment",
  0x02: "message",
  0x03: "error",
  0x04: "gap",
};

const hex2 = (b: number): string => b.toString(16).padStart(2, "0");

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, hex2).join(" ");
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

function iso(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? `${ms} ms` : d.toISOString();
}

class Cursor {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("the file ends in the middle of an item");
    return this.buf[this.pos++]!;
  }
  varint(): number {
    let out = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      out += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return out;
      scale *= 128;
    }
  }
  u48(): number {
    let out = 0;
    let scale = 1;
    for (let i = 0; i < 6; i++) {
      out += this.byte() * scale;
      scale *= 256;
    }
    return out;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `the file ends ${n - (this.buf.length - this.pos)} bytes short of a ${n}-byte payload`,
      );
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Read one field off the cursor and record where it sat. */
function field<T>(
  c: Cursor,
  fields: UsbTrafficByteField[],
  name: string,
  read: (c: Cursor) => T,
  describe: (v: T) => { value: string; note?: string },
): T {
  const offset = c.pos;
  const v = read(c);
  fields.push({ offset, length: c.pos - offset, name, ...describe(v) });
  return v;
}

const varintNote =
  "A variable-length integer: 7 bits per byte, low bits first; the top bit of every byte but the last is set.";

function describeMessageFlags(flags: number): { value: string; note: string } {
  const bits = [
    `bit 0 = ${flags & 1}: ${flags & 1 ? "in — instrument to computer" : "out — computer to instrument"}`,
    `bit 1 = ${(flags >> 1) & 1}: ${flags & 2 ? "unsolicited — no request was waiting for it" : "not unsolicited"}`,
    `bit 2 = ${(flags >> 2) & 1}: ${flags & 4 ? "status-poll chatter" : "not part of the status poll"}`,
    `bit 3 = ${(flags >> 3) & 1}: ${flags & 8 ? "recorded as binary — no text reading was offered" : "offered as text"}`,
  ];
  const rest = flags & 0xf0;
  if (rest) bits.push(`bits 4–7 = 0x${hex2(rest)}: not defined for a message`);
  return { value: `0x${hex2(flags)} (${flags.toString(2).padStart(8, "0")})`, note: bits.join("; ") };
}

function describeErrorFlags(flags: number): { value: string; note: string } {
  const bits = [
    `bit 0 = ${flags & 1}: ${flags & 1 ? "reading from the instrument" : "writing to the instrument"}`,
    `bit 4 = ${(flags >> 4) & 1}: ${flags & 0x10 ? "fatal — this failure ended something" : "retried"}`,
  ];
  const rest = flags & 0xee;
  if (rest) bits.push(`other bits = 0x${hex2(rest)}: not defined for an error`);
  return { value: `0x${hex2(flags)} (${flags.toString(2).padStart(8, "0")})`, note: bits.join("; ") };
}

const CHANNEL_NAMES: Record<number, string> = {
  0: "channel 0 — a binary auxiliary stream, rarely used",
  1: "channel 1 — the text command channel",
  2: "channel 2 — a binary auxiliary stream",
  3: "channel 3 — never seen in use",
};

/** Walk the file's items, attributing every byte. Never throws: a damaged tail becomes an
 * `invalid` item holding the bytes that couldn't be read. */
function walk(bytes: Uint8Array): { items: UsbTrafficItem[]; error: string | null } {
  const items: UsbTrafficItem[] = [];
  const empty = (): UsbTrafficMeaning => ({ summary: "", fields: [], notes: [] });

  const magicLen = Math.min(USB_TRAFFIC_MAGIC.length, bytes.length);
  const magic = bytes.subarray(0, magicLen);
  const magicOk = magicLen === USB_TRAFFIC_MAGIC.length && USB_TRAFFIC_MAGIC.every((b, i) => magic[i] === b);
  items.push({
    index: 0,
    kind: "header",
    offset: 0,
    length: magicLen,
    fields: [
      {
        offset: 0,
        length: magicLen,
        name: "Magic",
        value: JSON.stringify(new TextDecoder("latin1").decode(magic)),
        note: magicOk
          ? "Identifies a USB traffic log, version 1. Everything after it is a sequence of items, each opening with a type byte, until the file ends."
          : "Not the expected \"ZUSBLOG1\" — this is not a USB traffic log this app wrote.",
      },
    ],
    meaning: {
      summary: magicOk ? "File header — USB traffic log, version 1" : "Unrecognised file header",
      fields: [],
      notes: [],
    },
  });
  if (!magicOk) {
    if (bytes.length > magicLen) {
      items.push(invalidItem(1, bytes, magicLen, "not a USB traffic log"));
    }
    return { items, error: "The file does not start with the ZUSBLOG1 header." };
  }

  const c = new Cursor(bytes, magicLen);
  let last = 0;
  let segmentOpen = false;
  while (c.pos < bytes.length) {
    const start = c.pos;
    const fields: UsbTrafficByteField[] = [];
    try {
      const type = field(c, fields, "Item type", (c) => c.byte(), (t) => ({
        value: `0x${hex2(t)} — ${ITEM_NAMES[t] ?? "unknown"}`,
      }));
      const kind = ITEM_NAMES[type];
      if (!kind) throw new Error(`unknown item type 0x${hex2(type)}`);

      if (kind === "segment") {
        const base = field(c, fields, "Base time", (c) => c.u48(), (v) => ({
          value: iso(v),
          note: `${v} ms since 1970-01-01 UTC, as a 6-byte little-endian integer. Every item after this counts its time from here.`,
        }));
        last = base;
        segmentOpen = true;
        items.push({
          index: items.length,
          kind,
          offset: start,
          length: c.pos - start,
          at: base,
          fields,
          meaning: {
            summary: `Segment starts — times count from ${iso(base)}`,
            fields: [],
            notes: [
              "The recorder starts a new segment every 256 KB, each with its own absolute start time, so the oldest segment can be dropped whole if the recording outgrows its memory budget.",
            ],
          },
        });
        continue;
      }

      if (kind === "gap") {
        const dropped = field(c, fields, "Records dropped", (c) => c.varint(), (v) => ({
          value: v.toLocaleString("en-US"),
          note: varintNote,
        }));
        items.push({
          index: items.length,
          kind,
          offset: start,
          length: c.pos - start,
          record: { kind: "gap", dropped },
          fields,
          meaning: {
            summary: `${plural(dropped, "earlier record")} dropped — the recording buffer was full`,
            fields: [],
            notes: [
              "The recording keeps a bounded amount of traffic in memory. When it fills, the oldest segment is discarded and this note takes its place, so a missing stretch of time is marked rather than silent.",
            ],
          },
        });
        continue;
      }

      const flags = field(c, fields, "Flags", (c) => c.byte(), (f) =>
        kind === "message" ? describeMessageFlags(f) : describeErrorFlags(f),
      );
      const dtStart = c.pos;
      const dt = c.varint();
      const at = last + dt;
      fields.push({
        offset: dtStart,
        length: c.pos - dtStart,
        name: "Time since previous",
        value: `+${dt.toLocaleString("en-US")} ms`,
        note: `${varintNote} Added to the previous item's time: ${iso(at)}.${segmentOpen ? "" : " No segment has set a start time yet, so this counts from zero."}`,
      });
      last = at;
      const direction = flags & 1 ? ("in" as const) : ("out" as const);

      if (kind === "message") {
        const channel = field(c, fields, "Channel", (c) => c.byte(), (ch) => ({
          value: String(ch),
          note: CHANNEL_NAMES[ch] ?? "outside the 0–3 a message header can carry",
        }));
        const len = field(c, fields, "Payload length", (c) => c.varint(), (v) => ({
          value: plural(v, "byte"),
          note: varintNote,
        }));
        const payloadStart = c.pos;
        const payload = c.bytes(len);
        const text = flags & 8 ? null : usbTrafficText(payload);
        fields.push({
          offset: payloadStart,
          length: len,
          name: "Payload",
          value: plural(len, "byte"),
          note:
            "The message's bytes exactly as framed on the wire, without the 5-byte frame header (which the recording does not keep).",
        });
        items.push({
          index: items.length,
          kind,
          offset: start,
          length: c.pos - start,
          at,
          record: {
            kind: "message",
            at,
            direction,
            channel,
            unsolicited: (flags & 2) !== 0,
            poll: (flags & 4) !== 0,
            payload,
            text,
          },
          fields,
          meaning: empty(),
        });
      } else {
        const attempt = field(c, fields, "Attempt", (c) => c.varint(), (v) => ({
          value: String(v),
          note: "How many consecutive failures, including this one.",
        }));
        const len = field(c, fields, "Message length", (c) => c.varint(), (v) => ({
          value: plural(v, "byte"),
          note: varintNote,
        }));
        const msgStart = c.pos;
        const message = new TextDecoder().decode(c.bytes(len));
        fields.push({
          offset: msgStart,
          length: len,
          name: "Message",
          value: JSON.stringify(message),
          note: "The browser's error message, UTF-8.",
        });
        items.push({
          index: items.length,
          kind,
          offset: start,
          length: c.pos - start,
          at,
          record: { kind: "error", at, direction, message, attempt, fatal: (flags & 0x10) !== 0 },
          fields,
          meaning: empty(),
        });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      items.push(invalidItem(items.length, bytes, start, reason));
      return { items, error: `Decoding stopped at offset ${start}: ${reason}.` };
    }
  }
  return { items, error: null };
}

function invalidItem(index: number, bytes: Uint8Array, offset: number, reason: string): UsbTrafficItem {
  return {
    index,
    kind: "invalid",
    offset,
    length: bytes.length - offset,
    fields: [
      {
        offset,
        length: bytes.length - offset,
        name: "Undecodable",
        value: plural(bytes.length - offset, "byte"),
        note: `Could not be read as an item: ${reason}.`,
      },
    ],
    meaning: {
      summary: `${plural(bytes.length - offset, "byte")} that could not be decoded — ${reason}`,
      fields: [],
      notes: [],
    },
  };
}

// ---- meaning ---------------------------------------------------------------------------------

/**
 * What each channel-1 command is, in a sentence — the vocabulary of `usb.md` §3 (and §5, §7.3,
 * §7.8, §7.9 for the file and run-control verbs). Keyed by the command's first word. A verb not
 * listed still decodes; it is just described as unrecognised.
 */
const COMMANDS: Record<string, string> = {
  "*IDN?": "Identify the instrument: manufacturer, model, serial number and firmware version.",
  "SOFTWARE?": "Ask for the instrument's firmware version.",
  "FRONTENDSOFTWARE?": "Ask for the version of the instrument's front-end (touchscreen) software.",
  "BASESN?": "Ask for the base unit's serial number.",
  "ALPHASN?": "Ask for a second serial number, distinct from the base unit's.",
  "ALPHAID?": "Ask for the block/optical head type identifier (a CFX96 reports 4).",
  "BLOCKDESC?": "Ask for the block's description (the plate type it takes).",
  "BLOCKCOUNT?": "Ask how many thermal blocks the base carries.",
  "CPLD?": "Ask for a hardware revision letter.",
  "DEVICES?": "An identification query whose meaning is not established.",
  "VOLUME?": "Ask for the reaction volume last set, in µL.",
  "WORKING?": "Ask whether the instrument reports itself working.",
  "BOOTMODE?": "Ask whether the instrument is in boot mode.",
  "SELFTEST?": "Ask for the self-test result.",
  "ENABLERT?": "An identification query about real-time mode.",
  "ERRORS?": "Ask how many errors the instrument has recorded.",
  "ERRORLIST": "Ask for the block's error list (empty when there is nothing to report).",
  GETSIPOSTERRORS: "Ask for power-on self-test errors.",
  "SUPERLOCKDOWNMODE?": "Ask whether the instrument's lockdown mode is on.",
  GETFREESPACE: "Ask how many bytes of storage are free.",
  GETTOTALRAM: "Ask how many bytes of RAM the instrument has.",
  "NAME?": "Ask for the current run's name (empty while idle).",
  "LIDFORCE?": "Ask for the lid force setting.",
  "LIDVERSION?": "Ask for the lid controller's version.",
  "LIDBVERSION?": "Ask for a second lid version number.",
  "GETPOS?": "An unidentified position query.",
  "STATUS?":
    "Ask for the block's status: temperatures, the step and cycle being run, the run state, and the run's clocks.",
  "RTSTATUS?": "Ask for the optical head's status: its shuttle temperature, ambient temperature and any faults.",
  "PAUSE?": "Ask whether the running protocol is paused.",
  PROTOCOL: "Begin authoring a protocol under this label. The run's own name is given later, by RemoteRun.",
  METHOD: "Set how the block is controlled: CALC models the sample's temperature, BLOCK controls the block directly.",
  HOTLID: "Set the heated lid's temperature and its shutoff temperature.",
  VOLUME: "Set the reaction volume, which the CALC thermal model uses.",
  TEMP: "Add a hold step to the protocol being authored.",
  GRAD: "Add a gradient step to the protocol being authored.",
  MELT: "Add a melt step to the protocol being authored.",
  INC: "Modify the previous step: raise its temperature on each pass.",
  RATE: "Modify the previous step: limit its ramp rate.",
  EXT: "Modify the previous step: lengthen or shorten its hold on each pass.",
  BEEP: "Modify the previous step: beep when it completes.",
  PLATEREAD: "Add a plate read to the protocol being authored.",
  GOTO: "Add a loop to the protocol being authored.",
  END: "Close the protocol's step list.",
  ADDCYCLES: "Extend the running protocol's loop by this many cycles (0 is a no-op).",
  REMOTERUN: "Start the authored protocol as a run.",
  PROCEED: "Skip to the next step of the running protocol.",
  CANCEL:
    "End the run: on a finished run this acknowledges it and clears its name; on a run still cycling it aborts it.",
  PAUSE: "Suspend the running protocol (a no-op when nothing is running).",
  RESUME: "Continue a suspended protocol.",
  LID: "Drive the motorised lid.",
  FRONTENDLOCKED: "Lock or unlock the instrument's touchscreen.",
  TESTMODE: "Set a test mode.",
  BLOCKID: "Flash this block's indicator, so an operator can see which unit is being addressed.",
  SETAPILOGLEVEL: "Set the instrument's API logging level.",
  SETDATETIME: "Set the instrument's clock and time-zone offset.",
  GETFILESLEN:
    "Ask how long the directory's listing is, in bytes — and have the instrument buffer that listing for the LISTALLFILES that follows.",
  LISTALLFILES:
    "Fetch the directory listing the last GETFILESLEN buffered. (The instrument ignores this command's own path and returns whatever was buffered.)",
  GETFILESIZE: "Ask for a file's size in bytes.",
  GETFILE: "Download a file's bytes.",
  DELFILE: "Delete a file.",
  COMPUTEFILECRC:
    "Ask where the instrument stored the file just uploaded: it keeps each upload under a generated name and answers with that path.",
  GETFILECRC: "Ask for the instrument's checksum of a stored file.",
  CRCSENDFILE: "Upload a file: its checksum and destination path, then the file's bytes in the same message.",
};

/**
 * The binary replies that stand in for a value (`usb.md` §5, "Listing a directory"): four bytes,
 * the first naming the condition. Measured live on a CFX96.
 */
const BINARY_STATUS: Record<string, string> = {
  "07000900": "The directory exists but holds no files.",
  "04000900": "No such directory (or the path names a file).",
  "05000900": "No such file.",
};

/** A request waiting for its reply — the pairing queue `CfxDevice.dispatch` keeps. */
interface PendingRequest {
  item: UsbTrafficItem;
  verb: string;
  /** The command line, without its terminator; for `CRCSENDFILE` just the text before the file. */
  line: string;
  /** For `GETFILE` — the file's size, when an earlier `GETFILESIZE` said; lets a reply span parts. */
  expected?: number;
  received: number;
  path?: string;
}

/** State carried between messages: what earlier replies said, for later ones to be checked against. */
interface Context {
  queue: PendingRequest[];
  /** `GETFILESIZE` answers, by path. */
  sizes: Map<string, number>;
  /** `CRCSENDFILE` checksums, by destination path. */
  sentCrc: Map<string, number>;
  /** `COMPUTEFILECRC` answers: the stored (generated) path → the path it was uploaded to. */
  storedAs: Map<string, string>;
  /** The directory the last successful `GETFILESLEN` buffered, and how long it said the listing was. */
  buffered: { dir: string; length: number } | null;
  /** The last item index, so a failed write can retract the request it was sending. */
  lastOut: PendingRequest | null;
}

/** Strip the CR LF a command line ends with, saying so. */
function commandLine(text: string): { line: string; terminator: string } {
  const m = /(\r?\n)$/.exec(text);
  return m ? { line: text.slice(0, -m[1]!.length), terminator: m[1]! } : { line: text, terminator: "" };
}

function firstWord(line: string): string {
  return (line.split(" ")[0] ?? "").toUpperCase();
}

/** A path operand, with the quotes some commands put around it removed. */
function pathOperand(rest: string): string {
  return rest.trim().replace(/^"(.*)"$/, "$1");
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${n.toLocaleString("en-US")} bytes (${(n / 1024 / 1024).toFixed(1)} MB)`;
  if (n >= 1024) return `${n.toLocaleString("en-US")} bytes (${(n / 1024).toFixed(1)} KB)`;
  return plural(n, "byte");
}

function seconds(v: number | null): string {
  if (v === null) return "—";
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return m > 0 ? `${v} s (${m} min ${s.toFixed(0)} s)` : `${v} s`;
}

function bool(v: string): string {
  const t = v.toLowerCase();
  return t === "true" ? "yes" : t === "false" ? "no" : v;
}

function splitQuotedOperands(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|([^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]!.trim());
  return out;
}

/** Explain a channel-1 request: its verb, and its operands where they have a known shape. */
function explainRequest(line: string, terminator: string, payload: Uint8Array, ctx: Context): {
  pending: Omit<PendingRequest, "item" | "received">;
  meaning: UsbTrafficMeaning;
} {
  const verb = firstWord(line);
  const rest = line.slice(line.indexOf(" ") + 1 || line.length);
  const about = COMMANDS[verb];
  const fields: UsbPayloadField[] = [];
  const notes: string[] = [];
  let summary = line;
  let path: string | undefined;
  let expected: number | undefined;

  fields.push({ label: "Command", raw: line.split(" ")[0], value: about ?? "A command this decoder does not recognise." });

  switch (verb) {
    case "TEMP":
    case "GRAD":
    case "MELT":
    case "INC":
    case "RATE":
    case "EXT":
    case "BEEP":
    case "PLATEREAD":
    case "METHOD":
    case "HOTLID":
    case "VOLUME": {
      // The protocol language (`protocol.md`) — one directive per command, read by the same
      // parser a `ProtocolRunDefinition.txt` goes through.
      const d = parseRunDefinition(line).directives[0];
      if (d && d.description) {
        fields.push({ label: "Operands", raw: rest, value: d.description });
        summary = `${line} — ${d.description}`;
      }
      if (verb === "PLATEREAD" && d && "scanMask" in d && d.scanMask) {
        const m = d.scanMask;
        fields.push({
          label: "Scan mask",
          raw: rest,
          value: `0x${hex2(m.raw)} (${m.raw.toString(2).padStart(8, "0")}): bits 0–5 select channels ${m.channels.join(", ") || "none"}; bit 7 ${m.flyover ? "set — flyover (scan continuously)" : "clear — step-and-repeat (stop over each well)"}`,
        });
      }
      break;
    }
    case "GOTO": {
      const [step, count] = rest.split(",").map((s) => Number(s.trim()));
      if (Number.isFinite(step) && Number.isFinite(count)) {
        const value = `Go back to step ${step}, ${plural(count!, "more time")} (${count! + 1} passes in all)`;
        fields.push({ label: "Operands", raw: rest, value });
        summary = `${line} — ${value}`;
      }
      break;
    }
    case "PROTOCOL":
      fields.push({ label: "Label", raw: rest, value: pathOperand(rest.replace(/^'(.*)'$/, "$1")) });
      break;
    case "REMOTERUN": {
      // `usb.md` §7.3's eight operands.
      const names = [
        ["Block", (v: string) => `block ${v}`],
        ["Heated lid on", bool],
        ["Start at the instrument", (v: string) => (bool(v) === "yes" ? "yes — wait for Start on the touchscreen" : "no — start now")],
        ["Run name", (v: string) => v || "(empty)"],
        ["User", (v: string) => v || "(empty)"],
        ["Sample ID", (v: string) => v || "(empty)"],
        ["Autonomous (instrument drives its own optics)", bool],
        ["Method", (v: string) => v],
      ] as const;
      const ops = splitQuotedOperands(rest);
      ops.forEach((v, i) => {
        const n = names[i];
        fields.push(n ? { label: n[0], raw: `"${v}"`, value: n[1](v) } : { label: `Operand ${i + 1}`, raw: v, value: "not defined" });
      });
      summary = `RemoteRun — start "${ops[3] ?? ""}"`;
      break;
    }
    case "SETDATETIME": {
      const [date, time, ampm, tz] = rest.split(",");
      fields.push({ label: "Date", raw: date, value: "month/day/year" });
      fields.push({ label: "Time", raw: time, value: `${time ?? ""} ${ampm ?? ""} — the computer's local clock, 12-hour` });
      fields.push({
        label: "Zone offset",
        raw: tz,
        value: "from UTC — the instrument subtracts it to stamp its files in GMT, and assumes Pacific until told",
      });
      break;
    }
    case "LID":
    case "FRONTENDLOCKED":
    case "TESTMODE":
    case "BLOCKID":
    case "SETAPILOGLEVEL":
    case "ADDCYCLES":
    case "ERRORLIST":
      if (rest !== line) fields.push({ label: "Operand", raw: rest, value: verb === "ERRORLIST" || verb === "BLOCKID" ? `block ${rest}` : rest });
      break;
    case "GETFILESLEN":
    case "LISTALLFILES":
    case "GETFILESIZE":
    case "GETFILE":
    case "DELFILE":
    case "COMPUTEFILECRC":
    case "GETFILECRC": {
      path = pathOperand(rest);
      fields.push({ label: verb === "GETFILESLEN" || verb === "LISTALLFILES" ? "Directory" : "Path", raw: rest, value: path });
      if (verb === "GETFILE") {
        expected = ctx.sizes.get(path);
        if (expected !== undefined) notes.push(`The GETFILESIZE before this said ${formatBytes(expected)}.`);
      }
      if (verb === "LISTALLFILES" && ctx.buffered && ctx.buffered.dir !== path) {
        notes.push(`The listing last buffered is of ${ctx.buffered.dir}, so that is what will come back.`);
      }
      if (verb === "GETFILECRC") {
        const friendly = ctx.storedAs.get(path);
        if (friendly) notes.push(`This is where ${friendly} was stored when it was uploaded.`);
      }
      break;
    }
    case "CRCSENDFILE": {
      // `CRCSENDFILE "<crc>*<path>",<file bytes>` — no terminator (`usb.md` §5, §7.4).
      const m = /^CRCSENDFILE "(\d+)\*([^"]*)",/i.exec(line);
      if (m) {
        const prefixLen = m[0].length;
        const file = payload.subarray(prefixLen);
        const announced = Number(m[1]);
        const actual = cfxFileCrc(file);
        path = m[2]!;
        ctx.sentCrc.set(path, announced);
        fields.push({ label: "Checksum", raw: m[1], value: `${announced}, announced for the file that follows` });
        fields.push({ label: "Destination", raw: m[2], value: path });
        fields.push({
          label: "File",
          value: `${formatBytes(file.length)}, from payload offset ${prefixLen}${usbTrafficText(file) !== null ? " (text)" : " (binary)"}`,
        });
        fields.push({
          label: "Checksum check",
          value:
            actual === announced
              ? `matches — the file's bytes give ${formatCfxFileCrc(actual)}`
              : `does NOT match — the file's bytes give ${formatCfxFileCrc(actual)}`,
        });
        notes.push(
          "The checksum is an XOR of the file's bytes, even-indexed bytes into the high byte and odd-indexed into the low, written as five decimal digits. The instrument recomputes it over what it stored.",
          "Unlike every other command this one carries no CR LF: the file's bytes run to the end of the message.",
        );
        summary = `CRCSENDFILE — upload ${path} (${formatBytes(file.length)})`;
        return { pending: { verb, line: line.slice(0, prefixLen), path }, meaning: { summary, command: verb, fields, notes } };
      }
      break;
    }
  }

  if (terminator) {
    fields.push({
      label: "Terminator",
      raw: Array.from(terminator, (ch) => hex2(ch.charCodeAt(0))).join(" "),
      value: terminator === "\r\n" ? "CR LF — every command line ends with one" : "line feed",
    });
  }
  return { pending: { verb, line, path, expected }, meaning: { summary, command: verb, fields, notes } };
}

/** The value and result code every text reply carries (`usb.md` §3, "Response shape"). */
function responseFields(res: CfxResponse): UsbPayloadField[] {
  const out: UsbPayloadField[] = [];
  if (res.value === null) {
    out.push({ label: "Shape", value: "A bare result code — the command had no value to report" });
  } else {
    out.push({ label: "Value", raw: res.value, value: res.value === "" ? "(empty)" : "everything before the last ';'" });
  }
  out.push({
    label: "Result code",
    raw: res.code,
    value: res.ok ? "0000 — success" : "not 0000 — the instrument reported a failure",
  });
  return out;
}

function deg(v: number | null): string {
  return v === null ? "—" : `${v} °C`;
}

/** `STATUS?`'s nineteen fields, named (`usb.md` §3.2). */
function statusFields(s: CfxStatus): UsbPayloadField[] {
  const f = s.fields;
  const flag = s.flags;
  const flagBits = [
    [flag.atTarget, "at target"],
    [flag.paused, "paused"],
    [flag.fourthBlock, "fourth-block flag"],
    [flag.lidPreheating, "lid preheating"],
    [flag.incubating, "incubating"],
    [flag.protocolRunning, "protocol running"],
    [flag.blockActive, "block active"],
    [flag.cancelled, "protocol cancelled"],
  ] as const;
  const set = flagBits.filter(([on]) => on).map(([, name]) => name);
  const named: [string, string][] = [
    ["Block temperature", deg(s.blockTempC)],
    ["Lid temperature", deg(s.lidTempC)],
    ["Cycle count", String(s.cycleCount ?? "—")],
    ["Current cycle", s.cycle ? String(s.cycle) : "0 — none"],
    ["Current step", s.stepText],
    ["Step number", s.stepNumber ? `step ${s.stepNumber} of the run definition` : "0 — none"],
    [
      "Run",
      `name "${s.runName}", method ${s.method}, heated lid ${s.realTime === null ? "?" : s.realTime ? "on" : "off"}`,
    ],
    [
      "Status register",
      `0x${hex2(flag.raw)} (${flag.raw.toString(2).padStart(8, "0")}): ${set.length ? set.join(", ") : "no flags set"} → ${s.phase}`,
    ],
    ["Elapsed", seconds(s.elapsedS)],
    ["Step elapsed", seconds(s.stepElapsedS)],
    ["Remaining (estimate)", seconds(s.remainingS)],
    ["Ramp elapsed", seconds(s.rampElapsedS)],
    ["Hold elapsed", seconds(s.holdElapsedS)],
    ["Paused field", s.paused ? "1 — paused" : "0"],
    ["Errors", s.errors.length ? s.errors.join(", ") : "none"],
    ["Step count", String(s.stepCount ?? "—")],
    ["Sample temperature", deg(s.sampleTempC)],
    ["Lid position", s.lid],
    ["Sensor", `${s.sensor ?? "—"} (an unidentified reading)`],
  ];
  const out: UsbPayloadField[] = named.map(([label, value], i) => ({
    label: `${i} · ${label}`,
    raw: f[i] ?? "",
    value,
  }));
  // A base with more than one block repeats the record before the single code.
  for (let i = named.length; i < f.length; i++) {
    out.push({ label: `${i} · block ${Math.floor(i / 19) + 1}, field ${i % 19}`, raw: f[i], value: "" });
  }
  return out;
}

function statusSummary(s: CfxStatus): string {
  const parts = [`block ${deg(s.blockTempC)}`, `lid ${deg(s.lidTempC)}`];
  if (s.running) {
    parts.push(`step ${s.stepNumber ?? "?"}/${s.stepCount ?? "?"} ${s.stepText}`, `cycle ${s.cycle ?? "?"}`);
  }
  parts.push(s.phase);
  if (s.runName) parts.push(`"${s.runName}"`);
  return parts.join(" · ");
}

/** Explain a reply in light of the request it answers. */
function explainReply(msg: UsbTrafficRecord & { kind: "message" }, req: PendingRequest | null, ctx: Context): UsbTrafficMeaning {
  const fields: UsbPayloadField[] = [];
  const notes: string[] = [];
  const verb = req?.verb;
  const lead = req ? `${req.line.length > 60 ? req.line.slice(0, 60) + "…" : req.line} → ` : "";

  // A binary stand-in for a value — four bytes naming a condition.
  const hex = hexOf(msg.payload).replace(/ /g, "");
  if (msg.text === null && BINARY_STATUS[hex] && verb !== "GETFILE") {
    const meaning = BINARY_STATUS[hex]!;
    fields.push({ label: "Status", raw: hexOf(msg.payload), value: meaning });
    notes.push("Sent as raw bytes rather than text: the instrument answers this way when it has no value to give.");
    if (verb === "DELFILE") notes.push("Deleting a file that is not there is harmless — a client clearing a destination before an upload expects this.");
    if (verb === "GETFILESLEN") notes.push("Nothing was buffered, so a LISTALLFILES now would return the previous directory's listing.");
    return { summary: `${lead}${meaning}`, command: verb, fields, notes };
  }

  if (verb === "GETFILE" && req) {
    const path = req.path ?? "";
    const part = req.received > 0 || (req.expected !== undefined && msg.payload.length < req.expected);
    req.received += msg.payload.length;
    fields.push({ label: "File", value: path });
    fields.push({ label: "Bytes", value: formatBytes(msg.payload.length) + (part ? `, ${req.received.toLocaleString("en-US")} received so far` : "") });
    if (req.expected !== undefined) {
      fields.push({
        label: "Size check",
        value:
          req.received === req.expected
            ? `complete — ${formatBytes(req.expected)}, as GETFILESIZE said`
            : req.received < req.expected
              ? `${(req.expected - req.received).toLocaleString("en-US")} bytes still to come of ${formatBytes(req.expected)}`
              : `${(req.received - req.expected).toLocaleString("en-US")} bytes more than GETFILESIZE said`,
      });
    }
    notes.push(
      msg.text === null
        ? "The file's own bytes, with no value/result-code wrapping. Shown below as bytes."
        : "The file's own bytes, with no value/result-code wrapping — it happens to be text.",
    );
    if (part) notes.push(`A message carries at most ${MAX_MESSAGE_PAYLOAD.toLocaleString("en-US")} bytes, so a larger file arrives in parts.`);
    const name = path.replace(/^.*\\/, "");
    return { summary: `${lead}${name}, ${formatBytes(msg.payload.length)}`, command: verb, fields, notes, file: path };
  }

  if (msg.text === null) {
    notes.push(
      "Binary, and not one of the known four-byte status replies. Shown below as bytes.",
    );
    return { summary: `${lead}${plural(msg.payload.length, "byte")} of binary`, command: verb, fields, notes };
  }

  const res = parseResponse(msg.payload);
  const value = res.value ?? "";
  let summary = `${lead}${res.raw}`;

  switch (verb) {
    case "STATUS?": {
      const s = parseStatus(res);
      fields.push(...statusFields(s));
      summary = `${lead}${statusSummary(s)}`;
      break;
    }
    case "RTSTATUS?": {
      const r = parseRtStatus(res);
      fields.push(
        { label: "0 · Shuttle temperature", raw: r.fields[0], value: `${deg(r.shuttleTempC)} — the optical head's heated shuttle` },
        { label: "1 · Ambient temperature", raw: r.fields[1], value: `${deg(r.ambientTempC)} — at the upper board` },
      );
      r.fields.slice(2).forEach((raw, i) =>
        fields.push({ label: `${i + 2} · Fault`, raw, value: raw === "" ? "none — an empty list is the healthy reading" : `code ${raw}` }),
      );
      summary = `${lead}shuttle ${deg(r.shuttleTempC)} · ambient ${deg(r.ambientTempC)} · ${r.faults.length ? plural(r.faults.length, "fault") : "no faults"}`;
      break;
    }
    case "*IDN?": {
      const id = parseIdentity(res);
      fields.push(
        { label: "Manufacturer", raw: id.manufacturer, value: "" },
        { label: "Model", raw: id.model, value: "" },
        { label: "Serial number", raw: id.serial, value: "" },
        { label: "Firmware", raw: id.firmware, value: "" },
      );
      break;
    }
    case "GETFILESLEN": {
      const n = Number(value);
      if (Number.isFinite(n) && req?.path !== undefined) {
        ctx.buffered = { dir: req.path, length: n };
        fields.push({ label: "Listing length", raw: value, value: `${plural(n, "character")} of comma-separated names, now buffered for LISTALLFILES` });
      }
      break;
    }
    case "LISTALLFILES": {
      const names = value === "" ? [] : value.split(",");
      fields.push({ label: `Files (${names.length})`, raw: value, value: names.join("\n") || "(none)" });
      if (ctx.buffered) {
        fields.push({
          label: "Listing of",
          value:
            `${ctx.buffered.dir} — ` +
            (ctx.buffered.length === value.length
              ? `${plural(value.length, "character")}, as GETFILESLEN said`
              : `${plural(value.length, "character")}, but GETFILESLEN said ${ctx.buffered.length}`),
        });
      }
      summary = `${lead}${plural(names.length, "file")}`;
      break;
    }
    case "GETFILESIZE": {
      const n = Number(value);
      if (Number.isFinite(n) && req?.path !== undefined) {
        ctx.sizes.set(req.path, n);
        fields.push({ label: "Size", raw: value, value: formatBytes(n) });
      }
      break;
    }
    case "COMPUTEFILECRC": {
      if (req?.path !== undefined && value) {
        ctx.storedAs.set(value, req.path);
        fields.push({ label: "Stored as", raw: value, value: `the generated name the upload of ${req.path} was kept under` });
        notes.push("Despite its name this command does not return a checksum; GETFILECRC on this path does.");
      }
      break;
    }
    case "GETFILECRC": {
      const n = Number(value);
      const friendly = req?.path !== undefined ? ctx.storedAs.get(req.path) : undefined;
      const sent = friendly !== undefined ? ctx.sentCrc.get(friendly) : undefined;
      fields.push({ label: "Checksum", raw: value, value: Number.isFinite(n) ? formatCfxFileCrc(n) : value });
      if (sent !== undefined) {
        fields.push({
          label: "Upload check",
          value: sent === n ? `matches the ${formatCfxFileCrc(sent)} announced when ${friendly} was uploaded — it arrived intact` : `differs from the ${formatCfxFileCrc(sent)} announced when ${friendly} was uploaded`,
        });
      }
      break;
    }
    case "GETFREESPACE":
    case "GETTOTALRAM": {
      const n = Number(value);
      if (Number.isFinite(n)) fields.push({ label: "Bytes", raw: value, value: formatBytes(n) });
      break;
    }
    case "VOLUME?":
      fields.push({ label: "Volume", raw: value, value: `${value} µL` });
      break;
  }
  fields.push(...responseFields(res));
  const trailing = /(\r?\n)$/.exec(msg.text)?.[1];
  if (trailing) fields.push({ label: "Terminator", raw: trailing === "\r\n" ? "0d 0a" : "0a", value: "line end — some replies carry one, some don't" });
  return { summary, command: verb, fields, notes };
}

function annotate(items: UsbTrafficItem[]): void {
  const ctx: Context = {
    queue: [],
    sizes: new Map(),
    sentCrc: new Map(),
    storedAs: new Map(),
    buffered: null,
    lastOut: null,
  };
  for (const item of items) {
    const r = item.record;
    if (!r || r.kind === "gap") continue;

    if (r.kind === "error") {
      item.meaning = {
        summary: `Transfer error ${r.direction === "in" ? "reading from" : "writing to"} the instrument (attempt ${r.attempt}, ${r.fatal ? "fatal" : "retrying"}): ${r.message}`,
        fields: [
          { label: "Direction", value: r.direction === "in" ? "in — reading from the instrument" : "out — writing to the instrument" },
          { label: "Attempt", value: String(r.attempt) },
          { label: "Outcome", value: r.fatal ? "fatal — this failure ended the read loop or the command being sent" : "retried" },
          { label: "Message", value: r.message },
        ],
        notes: [],
      };
      // A write that failed was never sent, and `CfxDevice` drops the request it belonged to —
      // so the next reply must not be matched against it.
      if (r.direction === "out" && r.fatal && ctx.lastOut) {
        const i = ctx.queue.indexOf(ctx.lastOut);
        if (i >= 0) {
          ctx.queue.splice(i, 1);
          item.meaning.notes.push(`The request it was sending (item ${ctx.lastOut.item.index}) never went out, so no reply is expected for it.`);
        }
        ctx.lastOut = null;
      }
      continue;
    }

    if (r.channel !== 1) {
      item.meaning = {
        summary: `${plural(r.payload.length, "byte")} on binary channel ${r.channel}`,
        fields: [{ label: "Channel", value: CHANNEL_NAMES[r.channel] ?? String(r.channel) }],
        notes: [
          "The instrument's auxiliary binary channels have a short fixed-format layout that is not understood byte by byte, so this is shown as bytes only.",
        ],
      };
      continue;
    }

    if (r.direction === "out") {
      const text = r.text ?? new TextDecoder("latin1").decode(r.payload);
      const { line, terminator } = commandLine(text);
      const { pending, meaning } = explainRequest(line, terminator, r.payload, ctx);
      const req: PendingRequest = { ...pending, item, received: 0 };
      if (r.poll) meaning.notes.push("Part of the regular status poll.");
      meaning.replies = [];
      item.meaning = meaning;
      ctx.queue.push(req);
      ctx.lastOut = req;
      continue;
    }

    if (r.unsolicited) {
      const m = explainReply(r, null, ctx);
      m.summary = `Unsolicited: ${m.summary}`;
      m.notes.unshift(
        "No request was waiting for this. It is most often a reply the instrument wrote for an earlier connection, still in the pipe when this one opened.",
      );
      item.meaning = m;
      continue;
    }

    // Replies carry no request id: the oldest request still waiting is the one this answers,
    // which is how `CfxDevice.dispatch` matches them.
    const req = ctx.queue[0] ?? null;
    const m = explainReply(r, req, ctx);
    if (req) {
      m.replyTo = req.item.index;
      req.item.meaning.replies!.push(item.index);
      if (r.poll) m.notes.push("Part of the regular status poll.");
      // A file larger than one message arrives as full messages and a shorter remainder; the
      // request stays at the head of the queue until it has all of them (`CfxDevice.dispatch`).
      const more =
        req.verb === "GETFILE" &&
        req.expected !== undefined &&
        req.received < req.expected &&
        r.payload.length >= MAX_MESSAGE_PAYLOAD;
      if (!more) ctx.queue.shift();
    } else {
      m.notes.unshift("No request was waiting for this reply.");
    }
    item.meaning = m;
  }
}

/**
 * Decode a `usb-traffic.bin` for display: every item with its byte layout and its meaning.
 *
 * Never throws. A file that is not a traffic log, or one cut short, decodes as far as it can, the
 * rest becomes one `invalid` item, and {@link DecodedUsbTrafficLog.error} says why — a raw view
 * shows what a file holds, damaged or not.
 */
export function decodeUsbTrafficLog(bytes: Uint8Array): DecodedUsbTrafficLog {
  const { items, error } = walk(bytes);
  annotate(items);
  let messages = 0;
  let polls = 0;
  let errors = 0;
  let segments = 0;
  let dropped = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const it of items) {
    const r = it.record;
    if (it.kind === "segment") segments++;
    if (!r) continue;
    if (r.kind === "gap") {
      dropped += r.dropped;
      continue;
    }
    if (r.kind === "message") {
      messages++;
      if (r.poll) polls++;
    } else errors++;
    first ??= r.at;
    last = r.at;
  }
  return {
    items,
    error,
    totals: { bytes: bytes.length, messages, polls, errors, segments, dropped, first, last },
  };
}
