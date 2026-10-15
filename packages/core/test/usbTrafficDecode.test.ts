/**
 * The traffic log explained (`usbTrafficDecode.ts`): every byte attributed, and every message read
 * as the protocol it carries.
 *
 * Two properties carry the weight. The layout walk must agree with the format's own reader
 * record for record — it is a second walk of the same bytes, kept separate only so a damaged file
 * can be shown rather than thrown — and it must account for every byte, since a raw view that
 * silently skipped some would be lying about the file. The rest pins the readings a person relies
 * on: which request a reply answers, and what the checks (sizes, checksums) conclude.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cfxFileCrc, formatCfxFileCrc } from "../src/usb/crc.js";
import { MAX_MESSAGE_PAYLOAD } from "../src/usb/frame.js";
import { UsbTrafficRecorder, isUsbTrafficName, parseUsbTrafficLog } from "../src/usbTraffic.js";
import { decodeUsbTrafficLog, type UsbTrafficItem } from "../src/usbTrafficDecode.js";
import { parseZpcr } from "../src/zpcr.js";
import { RT_S56_SAMPLE_PATH } from "./sample.js";

const enc = (s: string) => new TextEncoder().encode(s);
const T0 = Date.UTC(2026, 7, 7, 23, 0, 0);

/** A recorder fed a scripted exchange: each `[dir, text]` one message, 10 ms apart. */
function record(script: ([ "out" | "in", string | Uint8Array ] | ["err-out"])[]): Uint8Array {
  const rec = new UsbTrafficRecorder();
  let t = T0;
  for (const step of script) {
    t += 10;
    if (step[0] === "err-out") {
      rec.error({ at: t, direction: "out", message: "transferOut failed", attempt: 1, fatal: true });
      continue;
    }
    const [direction, body] = step;
    const payload = typeof body === "string" ? enc(body) : body;
    const text = typeof body === "string" ? body : null;
    rec.message({ at: t, direction, channel: 1, payload, text, unsolicited: false, poll: false });
  }
  return rec.bytes();
}

const messages = (items: UsbTrafficItem[]) => items.filter((i) => i.kind === "message");

describe("usb traffic decode — layout", () => {
  const z = parseZpcr(new Uint8Array(readFileSync(RT_S56_SAMPLE_PATH)));
  const bytes = z.archive.bytes(z.archive.entries.find(isUsbTrafficName)!);
  const decoded = decodeUsbTrafficLog(bytes);

  it("reads the same records as the format's own reader", () => {
    const records = decoded.items.flatMap((i) => (i.record ? [i.record] : []));
    expect(decoded.error).toBeNull();
    expect(records).toEqual(parseUsbTrafficLog(bytes));
  });

  it("accounts for every byte of the file, items and fields alike, with no overlap", () => {
    let at = 0;
    for (const item of decoded.items) {
      expect(item.offset).toBe(at);
      let f = item.offset;
      for (const field of item.fields) {
        expect(field.offset).toBe(f);
        f += field.length;
      }
      expect(f).toBe(item.offset + item.length);
      at += item.length;
    }
    expect(at).toBe(bytes.length);
  });

  it("pairs every channel-1 request in a real session with a reply", () => {
    const requests = messages(decoded.items).filter((i) => i.record!.kind === "message" && i.record!.direction === "out");
    const unanswered = requests.filter((i) => (i.meaning.replies ?? []).length === 0);
    expect(requests.length).toBeGreaterThan(5000);
    expect(unanswered.length).toBeLessThanOrEqual(1); // a session can end with a request in flight
  });

  it("names STATUS? fields and decodes the status register", () => {
    const reply = decoded.items.find((i) => i.meaning.command === "STATUS?" && i.meaning.replyTo !== undefined)!;
    const labels = reply.meaning.fields.map((f) => f.label);
    expect(labels).toContain("0 · Block temperature");
    expect(labels).toContain("7 · Status register");
    expect(labels).toContain("Result code");
  });

  it("confirms each real upload's checksum, both as announced and as the instrument stored it", () => {
    const uploads = decoded.items.filter((i) => i.meaning.command === "CRCSENDFILE" && i.meaning.replyTo === undefined);
    expect(uploads.length).toBe(3);
    for (const u of uploads) {
      expect(u.meaning.fields.find((f) => f.label === "Checksum check")!.value).toMatch(/^matches/);
    }
    const checks = decoded.items.filter((i) => i.meaning.fields.some((f) => f.label === "Upload check"));
    expect(checks.length).toBe(3);
    for (const c of checks) expect(c.meaning.fields.find((f) => f.label === "Upload check")!.value).toMatch(/^matches/);
  });
});

describe("usb traffic decode — meaning", () => {
  it("reads a binary DELFILE reply as 'no such file'", () => {
    const { items } = decodeUsbTrafficLog(
      record([
        ["out", "DELFILE \\Storage Card\\CurrentRun\\x.txt\r\n"],
        ["in", new Uint8Array([5, 0, 9, 0])],
      ]),
    );
    const [req, reply] = messages(items);
    expect(reply!.meaning.replyTo).toBe(req!.index);
    expect(reply!.meaning.summary).toMatch(/No such file/);
  });

  it("follows a file larger than one message across its parts", () => {
    const size = MAX_MESSAGE_PAYLOAD + 10;
    const { items } = decodeUsbTrafficLog(
      record([
        ["out", "GETFILESIZE \\a.bin\r\n"],
        ["in", `${size};0000`],
        ["out", "GETFILE \\a.bin\r\n"],
        ["in", new Uint8Array(MAX_MESSAGE_PAYLOAD).fill(0xff)],
        ["in", new Uint8Array(10).fill(0xff)],
        ["out", "STATUS?\r\n"],
        ["in", "IDLE;0000"],
      ]),
    );
    const m = messages(items);
    expect(m[3]!.meaning.replyTo).toBe(m[2]!.index);
    expect(m[4]!.meaning.replyTo).toBe(m[2]!.index);
    expect(m[4]!.meaning.fields.find((f) => f.label === "Size check")!.value).toMatch(/^complete/);
    expect(m[6]!.meaning.replyTo).toBe(m[5]!.index);
  });

  it("drops a request whose write failed, so the next reply pairs correctly", () => {
    const { items } = decodeUsbTrafficLog(
      record([["out", "BASESN?\r\n"], ["err-out"], ["out", "CPLD?\r\n"], ["in", "B;0000\r\n"]]),
    );
    const m = messages(items);
    expect(m[2]!.meaning.replyTo).toBe(m[1]!.index);
    expect(m[0]!.meaning.replies).toEqual([]);
  });

  it("flags an upload whose announced checksum does not match its bytes", () => {
    const file = enc("hello");
    const wrong = formatCfxFileCrc((cfxFileCrc(file) + 1) & 0xffff);
    const payload = new Uint8Array([...enc(`CRCSENDFILE "${wrong}*\\x.txt",`), ...file]);
    const { items } = decodeUsbTrafficLog(record([["out", payload]]));
    expect(messages(items)[0]!.meaning.fields.find((f) => f.label === "Checksum check")!.value).toMatch(/NOT match/);
  });

  it("shows a truncated file as far as it reads, and the rest as undecodable", () => {
    const full = record([["out", "STATUS?\r\n"]]);
    const cut = full.subarray(0, full.length - 3);
    const decoded = decodeUsbTrafficLog(cut);
    expect(decoded.error).toMatch(/offset/);
    const last = decoded.items.at(-1)!;
    expect(last.kind).toBe("invalid");
    expect(last.offset + last.length).toBe(cut.length);
  });

  it("does not throw on a file that is not a traffic log", () => {
    const decoded = decodeUsbTrafficLog(enc("not a log at all"));
    expect(decoded.error).toMatch(/ZUSBLOG1/);
    expect(decoded.items.map((i) => i.kind)).toEqual(["header", "invalid"]);
  });
});
