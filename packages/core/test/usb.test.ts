import { describe, expect, it } from "vitest";
import {
  FrameReassembler,
  REQUEST_HEADER,
  decodeHeader,
  encodeCommand,
  encodeFrame,
  parseIdentity,
  parseResponse,
  parseStatus,
} from "../src/usb/index.js";

const hex = (s: string) => new Uint8Array(s.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16)));

describe("frame header", () => {
  // usb.md §2's worked example, byte-exact from the `usb-basic` capture.
  const IDN = hex("01 7f 0c 00 07  2a 49 44 4e 3f 0d 0a");

  it("decodes the documented *IDN? request", () => {
    const h = decodeHeader(IDN);
    expect(h).toMatchObject({
      handle: 0,
      channel: 1,
      newLine: true,
      charTimeout: 7,
      msgTimeout: 7,
      ascii: true,
      textPayload: true,
      passThrough: false,
      dummyAdded: false,
      payloadLength: 7,
    });
  });

  it("re-encodes it byte-for-byte", () => {
    const frame = encodeFrame({ ...REQUEST_HEADER, channel: 1 }, encodeCommand("*IDN?"));
    expect(Array.from(frame)).toEqual(Array.from(IDN));
  });

  it("reads the length big-endian", () => {
    // 0x0134 = 308 — the byte order that matters, since a `.Plateread`'s floats are the other way.
    expect(decodeHeader(hex("01 00 00 01 34")).payloadLength).toBe(308);
  });

  it("round-trips the channel and passThrough bits", () => {
    for (const channel of [0, 1, 2, 3]) {
      const f = encodeFrame({ ...REQUEST_HEADER, channel, passThrough: true }, new Uint8Array([1]));
      const h = decodeHeader(f);
      expect(h.channel).toBe(channel);
      expect(h.passThrough).toBe(true);
    }
  });
});

describe("FrameReassembler", () => {
  it("emits nothing until a message is complete", () => {
    const r = new FrameReassembler();
    expect(r.push(hex("01 7f 0c 00 07  2a 49"))).toEqual([]);
    expect(r.pending).toBe(7);
    const msg = r.push(hex("44 4e 3f 0d 0a"))[0]!;
    expect(msg.channel).toBe(1);
    expect(new TextDecoder().decode(msg.payload)).toBe("*IDN?\r\n");
    expect(r.pending).toBe(0);
  });

  it("splits several messages out of one chunk", () => {
    const a = encodeFrame({ ...REQUEST_HEADER, channel: 1 }, encodeCommand("*IDN?"));
    const b = encodeFrame({ ...REQUEST_HEADER, channel: 2 }, hex("04 00 00 04 64 00"));
    const both = new Uint8Array([...a, ...b]);
    const msgs = new FrameReassembler().push(both);
    expect(msgs.map((m) => m.channel)).toEqual([1, 2]);
  });

  it("treats continuation bytes as payload, not as a new header", () => {
    // The §8 bug: a large payload whose bytes happen to look like a valid header. Reassembly must
    // consume exactly `length` bytes and never re-parse inside them.
    const payload = new Uint8Array(200).fill(0x01);
    payload.set(hex("01 7f 0c 00 07"), 40); // a header-shaped run in the middle
    const frame = encodeFrame({ ...REQUEST_HEADER, channel: 1 }, payload);
    const r = new FrameReassembler();
    const msgs: number[] = [];
    // Deliver it in 64-byte USB-sized packets, as the wire would.
    for (let i = 0; i < frame.length; i += 64) {
      for (const m of r.push(frame.slice(i, i + 64))) msgs.push(m.payload.length);
    }
    expect(msgs).toEqual([200]);
  });
});

describe("parseResponse", () => {
  const of = (s: string) => parseResponse(new TextEncoder().encode(s));

  it("splits value from code", () => {
    const r = of("BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0;0000\r\n");
    expect(r.value).toBe("BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0");
    expect(r.code).toBe("0000");
    expect(r.ok).toBe(true);
  });

  it("reads an action command's bare code as having no value", () => {
    const r = of("0000");
    expect(r.value).toBeNull();
    expect(r.fields).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("keeps an empty value distinct from no value", () => {
    // `ERRORLIST A` with nothing to report still sends the separator.
    const r = of(";0000");
    expect(r.value).toBe("");
    expect(r.ok).toBe(true);
  });

  it("splits at the last semicolon, so a multi-field value survives", () => {
    const r = of("18.40;23.8;0;0;IDLE;0;\"\",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;18.40;CLOSED;0;0000");
    expect(r.code).toBe("0000");
    expect(r.fields).toHaveLength(19);
    expect(r.fields[0]).toBe("18.40");
  });

  it("preserves GETSIPOSTERRORS' real doubled separator", () => {
    const r = of("true;;0000");
    expect(r.fields).toEqual(["true", ""]);
    expect(r.ok).toBe(true);
  });

  it("reports a non-zero code as not ok", () => {
    const r = of("1234");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("1234");
  });
});

describe("parseStatus", () => {
  const of = (s: string) => parseStatus(parseResponse(new TextEncoder().encode(s)));

  it("reads an idle instrument (measured live)", () => {
    const s = of("18.40;23.8;0;0;IDLE;0;\"\",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;18.40;CLOSED;0;0000");
    expect(s.blockTempC).toBe(18.4);
    expect(s.lidTempC).toBe(23.8);
    expect(s.cycle).toBe(0);
    expect(s.stepText).toBe("IDLE");
    expect(s.runName).toBe("");
    expect(s.method).toBe("BLOCK");
    expect(s.realTime).toBe(false);
    expect(s.lid).toBe("CLOSED");
    expect(s.running).toBe(false);
  });

  it("reads a run in progress (usb.md §3)", () => {
    const s = of("60.25;104.9;2;2;TEMP 95.0,10;2;\"SINGLETE\",CALC,ON;96;110.22;0.00;75.15;2.10;0.00;0;0;6;55.61;CLOSED;0;0000");
    expect(s.blockTempC).toBe(60.25);
    expect(s.cycle).toBe(2);
    expect(s.step).toBe(2);
    expect(s.stepText).toBe("TEMP 95.0,10");
    expect(s.runName).toBe("SINGLETE");
    expect(s.method).toBe("CALC");
    expect(s.realTime).toBe(true);
    expect(s.sampleTempC).toBe(55.61);
    expect(s.running).toBe(true);
  });
});

describe("parseIdentity", () => {
  it("splits the four comma-separated fields", () => {
    const id = parseIdentity(
      parseResponse(new TextEncoder().encode("BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0;0000")),
    );
    expect(id).toMatchObject({
      manufacturer: "BIO-RAD LABORATORIES",
      model: "C1000",
      serial: "CT019138",
      firmware: "2.0.231.0",
    });
  });
});
