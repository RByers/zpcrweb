/**
 * The USB traffic log's binary record format (`usb-traffic.md`).
 *
 * The property that matters is that the compaction is *free*: what a session records and what a
 * reader renders must be the same log, line for line, or the format has traded away the thing it
 * exists to preserve. So the round trip is tested against the text rendering rather than against
 * field-by-field equality — that is what someone reading a downloaded log actually compares.
 */
import { describe, expect, it } from "vitest";
import { deflateSync } from "fflate";
import {
  UsbTrafficRecorder,
  formatUsbTrafficBytes,
  formatUsbTrafficLog,
  isUsbTrafficLog,
  isUsbTrafficName,
  parseUsbTrafficLog,
  usbTrafficText,
  type UsbTrafficMessage,
  USB_PREVIEW_UNITS,
} from "../src/usbTraffic.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const T0 = Date.UTC(2026, 7, 2, 12, 0, 0);

/** One poll cycle as the real client produces it: three queries, three replies, all classified as
 * poll chatter. `at` advances the way a 1.5 s poll does. */
function pollCycle(rec: UsbTrafficRecorder, at: number): number {
  const queries = ["STATUS?\n", "RTSTATUS?\n", "ERRORLIST A\n"];
  const replies = ["OK IDLE 25.0\n", "OK 25.1 24.9 105.0\n", "OK NONE\n"];
  let t = at;
  for (let i = 0; i < queries.length; i++) {
    rec.message({
      at: t,
      direction: "out",
      channel: 1,
      payload: bytes(queries[i]!),
      text: queries[i]!,
      unsolicited: false,
      poll: true,
    });
    t += 4;
    rec.message({
      at: t,
      direction: "in",
      channel: 1,
      payload: bytes(replies[i]!),
      text: replies[i]!,
      unsolicited: false,
      poll: true,
    });
    t += 6;
  }
  return at + 1500;
}

describe("usb traffic log — round trip", () => {
  it("renders a read-back log identically to the records that were written", () => {
    const rec = new UsbTrafficRecorder();
    const written: Parameters<UsbTrafficRecorder["message"]>[0][] = [
      {
        at: T0,
        direction: "out",
        channel: 1,
        payload: bytes("STATUS?\n"),
        text: "STATUS?\n",
        unsolicited: false,
        poll: true,
      },
      {
        at: T0 + 7,
        direction: "in",
        channel: 1,
        payload: bytes("OK RUNNING 3\n"),
        text: "OK RUNNING 3\n",
        unsolicited: false,
        poll: true,
      },
      {
        at: T0 + 900,
        direction: "in",
        channel: 2,
        payload: new Uint8Array([0x00, 0x01, 0xff, 0x7f]),
        text: null,
        unsolicited: true,
        poll: false,
      },
    ];
    for (const m of written) rec.message(m);
    rec.error({
      at: T0 + 1200,
      direction: "in",
      message: "device disconnected",
      attempt: 3,
      fatal: true,
    });

    const back = parseUsbTrafficLog(rec.bytes());
    expect(back).toHaveLength(4);
    // Every stored fact survives, including the three that aren't in the payload bytes.
    const m0 = back[0] as UsbTrafficMessage;
    expect(m0.poll).toBe(true);
    const m2 = back[2] as UsbTrafficMessage;
    expect(m2.unsolicited).toBe(true);
    expect(m2.channel).toBe(2);
    expect(m2.text).toBeNull();
    expect(Array.from(m2.payload)).toEqual([0x00, 0x01, 0xff, 0x7f]);
    expect(back[3]).toMatchObject({ kind: "error", attempt: 3, fatal: true });

    expect(formatUsbTrafficLog(back)).toBe(
      [
        `${new Date(T0).toISOString()} -> ch1 [8B] 53 54 41 54 55 53 3f 0a text="STATUS?"`,
        `${new Date(T0 + 7).toISOString()} <- ch1 [13B] 4f 4b 20 52 55 4e 4e 49 4e 47 20 33 0a text="OK RUNNING 3"`,
        `${new Date(T0 + 900).toISOString()} <- ch2 (unsolicited) [4B] 00 01 ff 7f`,
        `${new Date(T0 + 1200).toISOString()} !! transfer error (in, attempt 3, fatal): device disconnected`,
        "",
      ].join("\n"),
    );
  });

  it("keeps a printable payload the device declined to decode as bytes", () => {
    // A `passThrough` reply: every byte printable, but the device offered no text, and a reader
    // must not invent one. This is the one fact `usbTrafficText` alone would get wrong.
    const rec = new UsbTrafficRecorder();
    const payload = bytes("OK");
    expect(usbTrafficText(payload)).toBe("OK");
    rec.message({
      at: T0,
      direction: "in",
      channel: 1,
      payload,
      text: null,
      unsolicited: false,
      poll: false,
    });
    expect((parseUsbTrafficLog(rec.bytes())[0] as UsbTrafficMessage).text).toBeNull();
    expect(formatUsbTrafficBytes(rec.bytes())).not.toContain("text=");
  });

  it("holds timestamps across a segment boundary", () => {
    // Deltas are per segment, so a log longer than one segment is where a base-time bug shows up.
    const rec = new UsbTrafficRecorder();
    let t = T0;
    while (rec.byteLength < UsbTrafficRecorder.SEGMENT_BYTES * 2) t = pollCycle(rec, t);
    const back = parseUsbTrafficLog(rec.bytes());
    expect(back.length).toBeGreaterThan(1000);
    const last = back[back.length - 1] as UsbTrafficMessage;
    expect(last.at).toBe(t - 1500 + 4 + 6 + 4 + 6 + 4);
    expect(back.every((r) => r.kind === "gap" || r.at >= T0)).toBe(true);
  });

  it("is empty until something is recorded", () => {
    const rec = new UsbTrafficRecorder();
    expect(rec.isEmpty).toBe(true);
    expect(formatUsbTrafficBytes(rec.bytes())).toBe("");
    rec.message({
      at: T0,
      direction: "out",
      channel: 1,
      payload: bytes("STATUS?\n"),
      text: "STATUS?\n",
      unsolicited: false,
      poll: true,
    });
    expect(rec.isEmpty).toBe(false);
  });

  it("drops whole segments to stay in budget, and says so", () => {
    const rec = new UsbTrafficRecorder({ maxBytes: UsbTrafficRecorder.SEGMENT_BYTES * 2 });
    let t = T0;
    for (let i = 0; i < 20000; i++) t = pollCycle(rec, t);
    expect(rec.byteLength).toBeLessThanOrEqual(UsbTrafficRecorder.SEGMENT_BYTES * 3);
    const back = parseUsbTrafficLog(rec.bytes());
    const gap = back[0];
    expect(gap).toMatchObject({ kind: "gap" });
    expect((gap as { dropped: number }).dropped).toBeGreaterThan(0);
    // The count the recorder reports is the count a reader finds — a dropped segment doesn't
    // leave the tally behind.
    expect(back.filter((r) => r.kind !== "gap")).toHaveLength(rec.length);
    expect(formatUsbTrafficBytes(rec.bytes())).toContain("earlier records dropped");
  });

  it("refuses bytes that aren't a record stream", () => {
    expect(isUsbTrafficLog(bytes("2026-08-02T12:00:00.000Z -> ch1"))).toBe(false);
    expect(() => parseUsbTrafficLog(bytes("not a log"))).toThrow(/ZUSBLOG1/);
  });

  it("elides a long response's hex and text, but never a request's", () => {
    const rec = new UsbTrafficRecorder();
    const bigText = "OK " + "x".repeat(100) + "\n";
    const bigPayload = bytes(bigText);
    rec.message({
      at: T0,
      direction: "out",
      channel: 1,
      payload: bigPayload,
      text: bigText,
      unsolicited: false,
      poll: false,
    });
    rec.message({
      at: T0 + 1,
      direction: "in",
      channel: 1,
      payload: bigPayload,
      text: bigText,
      unsolicited: false,
      poll: false,
    });
    const lines = formatUsbTrafficBytes(rec.bytes()).split("\n");
    const out = lines[0] ?? "";
    const inLine = lines[1] ?? "";
    const trimmedLen = bigText.trim().length;
    expect(out).toContain(`[${bigPayload.length}B]`);
    expect(out).not.toContain("elided");
    expect(out).toContain(bigText.trim());
    expect(inLine).toContain(`[${bigPayload.length}B]`);
    // Both the hex and the decoded text are shortened, not just one — the hex elision note comes
    // before `text=`, the text elision note inside its quoted value.
    expect(inLine).toContain(`+${bigPayload.length - USB_PREVIEW_UNITS} more elided) text=`);
    expect(inLine).toContain(`+${trimmedLen - USB_PREVIEW_UNITS} more elided)"`);
    // One hexdump line and no more: the cut is what keeps a `GETFILE` reply from filling the
    // view it is being read in.
    const hexRun = inLine.split("] ")[1]?.split(" …")[0]?.split(" ") ?? [];
    expect(hexRun).toHaveLength(USB_PREVIEW_UNITS);
  });

  it("knows both names a log is stored under", () => {
    expect(isUsbTrafficName("usb-traffic.bin")).toBe(true);
    expect(isUsbTrafficName("usb-traffic.log")).toBe(true); // pre-binary `.zpcr` files
    expect(isUsbTrafficName("runlog.xml")).toBe(false);
  });
});

describe("usb traffic log — size", () => {
  /** An hour of a real run: the 1.5 s status poll, which is what a log is overwhelmingly made of. */
  function anHourOfPolling(): UsbTrafficRecorder {
    const rec = new UsbTrafficRecorder();
    let t = T0;
    for (let i = 0; i < 2400; i++) t = pollCycle(rec, t);
    return rec;
  }

  it("stores a message in a fraction of its rendered line", () => {
    const rec = anHourOfPolling();
    const text = formatUsbTrafficBytes(rec.bytes());
    // The claim `usb-traffic.md` §5 makes about why this format exists. Text is what the previous
    // implementation held in memory and wrote into the `.zpcr`.
    expect(rec.byteLength).toBeLessThan(text.length / 4);
    // …and it still wins after the `.zpcr`'s own deflate, which is the number that decides
    // whether attaching a log costs anything worth thinking about.
    const zippedRecords = deflateSync(rec.bytes()).length;
    const zippedText = deflateSync(new TextEncoder().encode(text)).length;
    expect(zippedRecords).toBeLessThan(zippedText);
  });
});
