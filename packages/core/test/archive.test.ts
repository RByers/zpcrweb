import { describe, it, expect } from "vitest";
import { parseZpcr } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("archive (low-level file access)", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("lists all archive entries including RunInfo.xml and 45 platereads", () => {
    const { entries } = zpcr.archive;
    expect(entries).toContain("RunInfo.xml");
    const platereads = entries.filter((n) => /Read\d+\.Plateread$/.test(n));
    expect(platereads).toHaveLength(45);
  });

  it("returns raw bytes for an entry", () => {
    const bytes = zpcr.archive.bytes("Read00001.Plateread");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(22037);
  });

  it("decodes text entries", () => {
    const text = zpcr.archive.text("ProtocolName.txt");
    expect(text.trim()).toBe("Luna_noRT");
  });

  it("produces a hex dump with offsets and ascii gutter", () => {
    const dump = zpcr.archive.hexDump("ProtocolName.txt");
    expect(dump).toMatch(/^00000000 /);
    expect(dump).toContain("Luna_noRT");
  });

  it("honors maxBytes and reports truncation", () => {
    const dump = zpcr.archive.hexDump("Read00001.Plateread", { maxBytes: 32 });
    expect(dump).toContain("more bytes (truncated)");
  });

  it("throws for a missing entry", () => {
    expect(() => zpcr.archive.bytes("nope.txt")).toThrow(/No such entry/);
  });
});
