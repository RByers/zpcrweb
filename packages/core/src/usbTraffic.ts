/**
 * The USB traffic log — a compact binary record of everything that crossed the wire, and the
 * text rendering of it that people actually read.
 *
 * **The problem.** Watching a run means watching thousands of messages: the status poll alone is
 * six messages every 1.5 s, so an hour of cycling is ~14 000 records before anything interesting
 * happens. Written as the obvious thing — one formatted line of text per message — that is several
 * megabytes for even a short run, held in browser memory for the whole session and then attached
 * to the run's `.zpcr`. The line is ~85 bytes of which the payload is 8; the rest is a re-printed
 * ISO timestamp, a hex expansion at three characters per byte, and the same words every time.
 *
 * So the log is *stored* as records — the bytes as framed, plus the few facts about each message
 * that can't be recovered later — and *rendered* to text on demand, by whoever displays or
 * downloads it ({@link formatUsbTrafficLog}). Nothing is lost: §4 of
 * [`usb-traffic.md`](../../../usb-traffic.md) shows the round trip is exact, line for line.
 *
 * **What can't be recovered, and so is stored.** Three things about a message are not in its
 * bytes: whether it was solicited (§2 of [`usb.md`](../../../usb.md) — an unsolicited channel-1
 * message and a reply look identical), whether the reader classified it as poll chatter (a reply
 * carries no copy of its request, so this is decided on arrival), and whether the device offered a
 * text decode at all (a `passThrough` reply is left as bytes even when every one of them is
 * printable). Each is one bit. Everything else — the direction arrow, the byte count, the text —
 * is derived at format time.
 *
 * The format itself is documented in [`usb-traffic.md`](../../../usb-traffic.md); this file is its
 * only reader and writer. {@link UsbTrafficRecorder} appends, {@link parseUsbTrafficLog} reads
 * back, {@link formatUsbTrafficLog} renders.
 */

/** The name a recorded log is stored under inside a run's `.zpcr` — binary records, per this
 * file's format. */
export const USB_TRAFFIC_LOG_NAME = "usb-traffic.bin";

/** The name the *text* rendering is downloaded as. Never an archive entry: a `.zpcr` carries the
 * records ({@link USB_TRAFFIC_LOG_NAME}) and the Raw files view renders them, so the two forms
 * can't drift. `.zpcr` files written before the binary format do hold a `usb-traffic.log` entry,
 * which is plain text and still reads as such. */
export const USB_TRAFFIC_TEXT_NAME = "usb-traffic.log";

/** `"ZUSBLOG1"` — magic and version in one, checked by {@link parseUsbTrafficLog}. */
export const USB_TRAFFIC_MAGIC = new Uint8Array([0x5a, 0x55, 0x53, 0x42, 0x4c, 0x4f, 0x47, 0x31]);

/** Item type bytes — see `usb-traffic.md` §3. */
const ITEM_SEGMENT = 0x01;
const ITEM_MESSAGE = 0x02;
const ITEM_ERROR = 0x03;
const ITEM_GAP = 0x04;

/** Flag bits within a message or error item's flags byte (`usb-traffic.md` §3.2). */
const FLAG_IN = 1 << 0;
const FLAG_UNSOLICITED = 1 << 1;
const FLAG_POLL = 1 << 2;
/** The payload was *not* offered as text (`CfxTrafficEvent.text === null`) — a binary message or
 * a `passThrough` reply. Stored because it can't be re-derived: the bytes of a passThrough reply
 * may be perfectly printable. */
const FLAG_BINARY = 1 << 3;
const FLAG_FATAL = 1 << 4;

/** One decoded message. The counterpart of `CfxTrafficEvent`, minus what the format derives. */
export interface UsbTrafficMessage {
  kind: "message";
  at: number;
  direction: "out" | "in";
  channel: number;
  unsolicited: boolean;
  poll: boolean;
  /** Payload bytes exactly as framed. */
  payload: Uint8Array;
  /** The payload as latin1 text, or `null` when it was recorded as binary. Derived on read (see
   * {@link usbTrafficText}), not stored. */
  text: string | null;
}

/** One transfer failure, retried or not. The counterpart of `CfxTransferErrorEvent`. */
export interface UsbTrafficError {
  kind: "error";
  at: number;
  direction: "out" | "in";
  message: string;
  attempt: number;
  fatal: boolean;
}

/** A note that records were dropped to stay inside a recorder's memory budget — written in their
 * place so a log never silently skips time (see {@link UsbTrafficRecorder}). */
export interface UsbTrafficGap {
  kind: "gap";
  /** How many records were discarded. `at` is unknown by construction — the times went with the
   * records — so a gap carries only the count. */
  dropped: number;
}

export type UsbTrafficRecord = UsbTrafficMessage | UsbTrafficError | UsbTrafficGap;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("latin1");

/**
 * The payload as text, or `null` when it holds anything unprintable — the same test
 * `CfxDevice.asText` applies when it decides what to put in a traffic event, kept in step with it
 * deliberately so a record read back renders the line the live console showed.
 */
export function usbTrafficText(payload: Uint8Array): string | null {
  for (const b of payload) {
    if (b !== 0x09 && b !== 0x0a && b !== 0x0d && (b < 0x20 || b > 0x7e)) return null;
  }
  return TEXT_DECODER.decode(payload);
}

// ---- writing ---------------------------------------------------------------------------------

/** A growable byte sink. Doubling rather than `Uint8Array` concatenation per record: a recorder
 * takes tens of thousands of them, and each concat would copy everything written so far. */
class ByteSink {
  private buf: Uint8Array;
  private len = 0;

  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
  }

  get length(): number {
    return this.len;
  }

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.need(1);
    this.buf[this.len++] = b & 0xff;
  }

  /** LEB128, 7 bits per byte, low group first (`usb-traffic.md` §3.1). */
  varint(v: number): void {
    let n = Math.max(0, Math.floor(v));
    for (;;) {
      const group = n & 0x7f;
      n = Math.floor(n / 128);
      if (n === 0) {
        this.byte(group);
        return;
      }
      this.byte(group | 0x80);
    }
  }

  /** A little-endian unsigned 48-bit integer — enough for epoch milliseconds until the year
   * 10889, and three bytes cheaper than the 64-bit field it replaces. */
  u48(v: number): void {
    let n = Math.max(0, Math.floor(v));
    for (let i = 0; i < 6; i++) {
      this.byte(n % 256);
      n = Math.floor(n / 256);
    }
  }

  bytes(b: Uint8Array): void {
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Records traffic as it arrives, in segments, inside a fixed memory budget.
 *
 * **Segments** are what make the budget affordable. Timestamps are stored as deltas, so a stream
 * can only be read from its start — which would make dropping the oldest records mean rewriting
 * everything. Instead the recorder closes the current segment every {@link SEGMENT_BYTES} and
 * starts another with its own absolute base time, so the oldest *segment* can simply be dropped:
 * every remaining one is still self-contained, and the file is their concatenation behind one
 * header. A dropped segment leaves a `gap` record in its place, so a reader sees that records are
 * missing rather than a suspiciously quiet hour.
 *
 * The budget exists because recording is unconditional (the app records always and only *saving*
 * is a choice), so an instrument left connected overnight must not grow without bound. At the
 * default 24 MB it holds roughly a day of idle polling, or a very long run in full.
 */
export class UsbTrafficRecorder {
  /** How much a segment holds before the next record starts a new one. Small enough that the
   * budget is enforced at a fine granularity, large enough that the per-segment base timestamp is
   * noise. */
  static readonly SEGMENT_BYTES = 256 * 1024;

  private readonly maxBytes: number;
  private readonly segments: Uint8Array[] = [];
  private current = new ByteSink(4096);
  private currentBase = 0;
  private lastAt = 0;
  private currentEmpty = true;
  private droppedRecords = 0;
  private closedBytes = 0;
  private records = 0;

  constructor({ maxBytes = 24 * 1024 * 1024 }: { maxBytes?: number } = {}) {
    this.maxBytes = maxBytes;
  }

  /** How many records have been recorded and not dropped. */
  get length(): number {
    return this.records;
  }

  /** Total size of {@link bytes}, without building it. */
  get byteLength(): number {
    return USB_TRAFFIC_MAGIC.length + this.closedBytes + this.current.length;
  }

  /** True while nothing has been recorded — what decides whether a run's `.zpcr` gets an entry at
   * all (an empty log is worth no entry, not an 8-byte header). */
  get isEmpty(): boolean {
    return this.records === 0 && this.droppedRecords === 0;
  }

  private beginSegment(at: number): void {
    if (!this.currentEmpty) this.closeSegment();
    this.currentBase = at;
    this.lastAt = at;
    this.currentEmpty = false;
    this.current.byte(ITEM_SEGMENT);
    this.current.u48(at);
  }

  private closeSegment(): void {
    const seg = this.current.take();
    this.segments.push(seg);
    this.closedBytes += seg.length;
    this.current = new ByteSink(4096);
    this.currentEmpty = true;
    this.trim();
  }

  /** Drop whole segments from the front until the budget is met, noting what went. */
  private trim(): void {
    while (this.byteLength > this.maxBytes && this.segments.length > 1) {
      const gone = this.segments.shift()!;
      this.closedBytes -= gone.length;
      const dropped = countRecords(gone);
      this.droppedRecords += dropped;
      this.records -= dropped;
    }
  }

  /** Start the item for a record at `at`, opening a segment if one is due, and return the delta
   * to write. Deltas are clamped at zero: `Date.now()` can step backwards, and a log that stays
   * readable through a clock adjustment is worth more than one that records it. */
  private prepare(at: number): number {
    if (this.currentEmpty || this.current.length >= UsbTrafficRecorder.SEGMENT_BYTES) {
      this.beginSegment(at);
      return 0;
    }
    const dt = Math.max(0, at - this.lastAt);
    this.lastAt = at;
    return dt;
  }

  /** Record one framed message. `text: null` marks a payload the device declined to decode. */
  message(m: {
    at: number;
    direction: "out" | "in";
    channel: number;
    payload: Uint8Array;
    text: string | null;
    unsolicited: boolean;
    poll: boolean;
  }): void {
    const dt = this.prepare(m.at);
    let flags = 0;
    if (m.direction === "in") flags |= FLAG_IN;
    if (m.unsolicited) flags |= FLAG_UNSOLICITED;
    if (m.poll) flags |= FLAG_POLL;
    if (m.text === null) flags |= FLAG_BINARY;
    this.current.byte(ITEM_MESSAGE);
    this.current.byte(flags);
    this.current.varint(dt);
    this.current.byte(m.channel & 0xff);
    this.current.varint(m.payload.length);
    this.current.bytes(m.payload);
    this.records++;
  }

  /** Record one `transferIn`/`transferOut` failure. */
  error(e: {
    at: number;
    direction: "out" | "in";
    message: string;
    attempt: number;
    fatal: boolean;
  }): void {
    const dt = this.prepare(e.at);
    let flags = 0;
    if (e.direction === "in") flags |= FLAG_IN;
    if (e.fatal) flags |= FLAG_FATAL;
    const msg = TEXT_ENCODER.encode(e.message);
    this.current.byte(ITEM_ERROR);
    this.current.byte(flags);
    this.current.varint(dt);
    this.current.varint(e.attempt);
    this.current.varint(msg.length);
    this.current.bytes(msg);
    this.records++;
  }

  /** The complete log as bytes — header, the gap note if anything was dropped, then every
   * segment. Built on demand (a download, or a run's final `.zpcr`), not maintained. */
  bytes(): Uint8Array {
    const head = new ByteSink(16 + USB_TRAFFIC_MAGIC.length);
    head.bytes(USB_TRAFFIC_MAGIC);
    if (this.droppedRecords > 0) {
      head.byte(ITEM_GAP);
      head.varint(this.droppedRecords);
    }
    const parts = [head.take(), ...this.segments, this.current.take()];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Records inside one already-written segment — used only to keep the recorder's count honest
 * when it drops one. */
function countRecords(segment: Uint8Array): number {
  let n = 0;
  for (const r of readItems(segment, 0)) if (r.kind !== "gap") n++;
  return n;
}

// ---- reading ---------------------------------------------------------------------------------

class ByteReader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("usb traffic log: truncated");
    return this.buf[this.pos++]!;
  }
  varint(): number {
    let out = 0;
    let shift = 1;
    for (;;) {
      const b = this.byte();
      out += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return out;
      shift *= 128;
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
    if (this.pos + n > this.buf.length) throw new Error("usb traffic log: truncated");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Walk the items of `bytes` from `start`, which must be an item boundary. Generator so a caller
 * that only wants a count doesn't materialize the records. */
function* readItems(bytes: Uint8Array, start: number): Generator<UsbTrafficRecord> {
  const r = new ByteReader(bytes, start);
  // The running timestamp: set absolutely by each segment header, advanced by each record's delta.
  let last = 0;
  while (!r.done) {
    const type = r.byte();
    if (type === ITEM_SEGMENT) {
      last = r.u48();
      continue;
    }
    if (type === ITEM_GAP) {
      yield { kind: "gap", dropped: r.varint() };
      continue;
    }
    if (type === ITEM_MESSAGE) {
      const flags = r.byte();
      last += r.varint();
      const channel = r.byte();
      const payload = r.bytes(r.varint());
      yield {
        kind: "message",
        at: last,
        direction: flags & FLAG_IN ? "in" : "out",
        channel,
        unsolicited: (flags & FLAG_UNSOLICITED) !== 0,
        poll: (flags & FLAG_POLL) !== 0,
        payload,
        text: flags & FLAG_BINARY ? null : usbTrafficText(payload),
      };
      continue;
    }
    if (type === ITEM_ERROR) {
      const flags = r.byte();
      last += r.varint();
      const attempt = r.varint();
      const message = new TextDecoder().decode(r.bytes(r.varint()));
      yield {
        kind: "error",
        at: last,
        direction: flags & FLAG_IN ? "in" : "out",
        message,
        attempt,
        fatal: (flags & FLAG_FATAL) !== 0,
      };
      continue;
    }
    throw new Error(`usb traffic log: unknown item type 0x${type.toString(16)}`);
  }
}

/** True when `bytes` opens with this format's magic — what tells a `usb-traffic.bin` entry from
 * the plain-text `usb-traffic.log` older `.zpcr` files carry. */
export function isUsbTrafficLog(bytes: Uint8Array): boolean {
  if (bytes.length < USB_TRAFFIC_MAGIC.length) return false;
  return USB_TRAFFIC_MAGIC.every((b, i) => bytes[i] === b);
}

/** True for either name a traffic log is stored under — the binary entry, or the plain-text one
 * written before the binary format existed. */
export function isUsbTrafficName(name: string): boolean {
  const base = name.replace(/^.*[\\/]/, "").toLowerCase();
  return base === USB_TRAFFIC_LOG_NAME || base === USB_TRAFFIC_TEXT_NAME;
}

/** Decode a whole log. Throws on a bad magic or a truncated item — a log is written in one piece
 * by this library, so either means the bytes aren't what the caller thinks they are. */
export function parseUsbTrafficLog(bytes: Uint8Array): UsbTrafficRecord[] {
  if (!isUsbTrafficLog(bytes)) throw new Error("usb traffic log: not a ZUSBLOG1 record stream");
  return [...readItems(bytes, USB_TRAFFIC_MAGIC.length)];
}

// ---- rendering -------------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

/**
 * A response's hex (in bytes) or decoded text (in characters) beyond this is elided.
 *
 * One hexdump line's worth, deliberately: a `GETFILE` reply is a whole ~50 KB file, and rendering
 * it in full turns "one line per record" into one line the size of a screen's scrollback — which
 * swamps the very view the log exists to make readable, and does it in exactly the case (a big
 * transfer) where the surrounding lines matter most. A single line is enough to recognise a
 * payload by its opening bytes and no more, which is all this rendering is for; the record keeps
 * every byte either way.
 *
 * Requests aren't elided: everything the client sends is a short command, so the cutoff only ever
 * bites the replies it's aimed at.
 */
export const USB_PREVIEW_UNITS = 16;

/** `s`, or its first {@link USB_PREVIEW_UNITS} units plus how many were left out — used for
 * both the hex (units = bytes) and the decoded text (units = characters) of a long response. */
function elide(s: string, total: number): string {
  return total <= USB_PREVIEW_UNITS ? s : `${s} … (+${total - USB_PREVIEW_UNITS} more elided)`;
}

/**
 * The hex and decoded text of one message as a log line shows them — whole for anything short,
 * previewed for a long response (see {@link USB_PREVIEW_UNITS}).
 *
 * Exported because there are two renderings of the same traffic and they must cut in the same
 * place: {@link formatUsbTrafficLog} below, and the app's live console, which builds its lines as
 * messages arrive rather than from stored records (`state/useCfxDevice.ts`). Eliding at that end
 * also keeps the whole of a fetched file out of React state, where a few of them would otherwise
 * sit in the display buffer as megabytes of hex nobody can read.
 */
export function usbTrafficPreview(msg: {
  direction: "in" | "out";
  payload: Uint8Array;
  /** The device's own decode, or null when there isn't one. A trailing newline is trimmed. */
  text: string | null;
}): { hex: string; text: string | null } {
  const long = msg.direction === "in" && msg.payload.length > USB_PREVIEW_UNITS;
  const hex = long
    ? elide(toHex(msg.payload.subarray(0, USB_PREVIEW_UNITS)), msg.payload.length)
    : toHex(msg.payload);
  if (msg.text === null) return { hex, text: null };
  const trimmed = msg.text.replace(/\r?\n$/, "");
  return { hex, text: long ? elide(trimmed.slice(0, USB_PREVIEW_UNITS), trimmed.length) : trimmed };
}

/**
 * Render records as one line each, in wire order — the form the console's download button writes
 * and the Raw files view shows, and the only text form of a log there is.
 *
 * A message line always carries `[<n>B] <hex>` — the exact payload bytes — even when it's also
 * shown decoded as `text=...`: the decode is a best-effort guess ({@link usbTrafficText}, latin1,
 * "every byte printable or not") and a trailing `\r`/`\n` is trimmed from it, so for a payload
 * this is meant to help *decode*, the raw bytes are the ground truth and the text is a convenience
 * alongside them, never a replacement for them. A response longer than {@link USB_PREVIEW_UNITS}
 * has its hex and text previewed rather than spelled out in full ({@link usbTrafficPreview}) — the
 * byte count at the front of the line still says how much was left out, and the complete bytes are
 * always still in the archived record, only this rendering of them is shortened.
 */
export function formatUsbTrafficLog(records: readonly UsbTrafficRecord[]): string {
  const rows = records.map((l) => {
    if (l.kind === "gap") {
      return `!! ${l.dropped} earlier records dropped (recording buffer full)`;
    }
    const at = new Date(l.at).toISOString();
    if (l.kind === "error") {
      const status = l.fatal ? "fatal" : "retrying";
      return `${at} !! transfer error (${l.direction}, attempt ${l.attempt}, ${status}): ${l.message}`;
    }
    const dir = l.direction === "out" ? "->" : "<-";
    const flag = l.unsolicited ? " (unsolicited)" : "";
    const { hex, text } = usbTrafficPreview(l);
    const decoded = text === null ? "" : ` text=${JSON.stringify(text)}`;
    return `${at} ${dir} ch${l.channel}${flag} [${l.payload.length}B] ${hex}${decoded}`;
  });
  return rows.length === 0 ? "" : rows.join("\n") + "\n";
}

/** {@link formatUsbTrafficLog} straight from stored bytes — what a viewer holding an archive
 * entry has. */
export function formatUsbTrafficBytes(bytes: Uint8Array): string {
  return formatUsbTrafficLog(parseUsbTrafficLog(bytes));
}
