import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  decodePlateRead,
  decodePlateReadSpec,
  encodePlateRead,
  isPlateReadName,
  plateReadNumber,
  unzipArchive,
  type PlateReadSpec,
  type WellReading,
} from "../src/index.js";
import {
  MELT_SAMPLE_PATH,
  RP_VALIDATION_SAMPLE_PATH,
  RT_S56_SAMPLE_PATH,
  SAMPLE_PATH,
} from "./sample.js";

/** Every `.Plateread` in a committed archive, in read order. */
function platereads(path: string): { name: string; bytes: Uint8Array }[] {
  const buf = readFileSync(path);
  const archive = unzipArchive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return Object.entries(archive)
    .filter(([name]) => isPlateReadName(name))
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => (plateReadNumber(a.name) ?? 0) - (plateReadNumber(b.name) ?? 0));
}

/**
 * The gate: re-encoding a real read reproduces it byte for byte. Nothing is carried over from
 * the source file — `decodePlateReadSpec` hands the encoder values, and the encoder computes
 * every offset, length and dictionary entry itself — so this is what says the writer knows the
 * format rather than knowing one file.
 */
describe("encodePlateRead — byte-identical re-encode of every committed .Plateread", () => {
  // Every `.zpcr` in `samples/`, not a hand-kept list: two 2026 runs off the second instrument,
  // a melt run, a gradient run and a 2019 run off the first one — 294 reads between them, and a
  // new sample archive joins the gate by being committed.
  const dir = dirname(SAMPLE_PATH);
  const archives = readdirSync(dir)
    .filter((name) => name.endsWith(".zpcr"))
    .sort();
  expect(archives).toContain(basename(RT_S56_SAMPLE_PATH));
  expect(archives).toContain(basename(RP_VALIDATION_SAMPLE_PATH));
  expect(archives).toContain(basename(MELT_SAMPLE_PATH));

  for (const name of archives) {
    it(`${name}`, () => {
      const reads = platereads(resolve(dir, name));
      expect(reads.length).toBeGreaterThan(0);
      for (const { name, bytes } of reads) {
        const encoded = encodePlateRead(decodePlateReadSpec(bytes));
        // Compared as lengths then contents: a whole-array mismatch prints 22 kB otherwise.
        expect(`${name}: ${encoded.length}`).toBe(`${name}: ${bytes.length}`);
        const at = encoded.findIndex((b, i) => b !== bytes[i]);
        expect(`${name}: ${at}`).toBe(`${name}: -1`);
      }
    });
  }
});

describe("encodePlateRead — a synthesized read", () => {
  /** A read built from scratch: one curve, in every well of every channel. */
  function synthetic(overrides: Partial<PlateReadSpec["header"]> = {}): PlateReadSpec {
    const template = decodePlateReadSpec(platereads(SAMPLE_PATH)[0]!.bytes);
    const reading = (channel: number): WellReading => ({
      mean: 1000 + channel * 100,
      std: 5,
      min: 900 + channel * 100,
      max: 1100 + channel * 100,
    });
    return {
      header: { ...template.header, cycle: 7, blockTempC: 59.5, lidTempC: 105, ...overrides },
      readings: (channel) => reading(channel),
      dark: (channel) => ({ mean: 2000 + channel, std: 1, min: 1990, max: 2010 }),
    };
  }

  it("reads back through the ordinary decoder with the values it was given", () => {
    const read = decodePlateRead(encodePlateRead(synthetic()), 7, "Read00007.Plateread");
    expect(read.cycle).toBe(7);
    expect(read.blockTempC).toBeCloseTo(59.5, 3);
    expect(read.wells[3]![0]![0]!.mean).toBeCloseTo(1300, 3);
    expect(read.wells[3]![8]![11]!.mean).toBeCloseTo(1300, 3);
    expect(read.dark[5]!.mean).toBeCloseTo(2005, 3);
    expect(read.temps.find((t) => t.key === "LIDTEMP")!.celsius).toBeCloseTo(105, 3);
    expect(read.fields).toHaveLength(42);
  });

  it("grows with a longer string field rather than shifting the data out from under it", () => {
    const shorter = encodePlateRead(synthetic({ runGuid: "CT1" }));
    const longer = encodePlateRead(synthetic({ runGuid: "CT1-and-then-some" }));
    expect(longer.length - shorter.length).toBe(14);
    expect(decodePlateRead(longer, 1, "Read00001.Plateread").cycle).toBe(7);
  });
});
