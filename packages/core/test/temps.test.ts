import { describe, it, expect } from "vitest";
import { extractTemps, parseZpcr, tempLabel, tempRow } from "../src/index.js";
import type { PlatereadField } from "../src/index.js";
import { readMultistepBytes, readSampleBytes } from "./sample.js";

/** Build a minimal descriptor field for the label/decoding unit tests. */
function field(name: string, extra: Partial<PlatereadField> = {}): PlatereadField {
  return { name, offset: 1, length: 4, type: 1, hex: "", ...extra };
}

describe("plateread temperatures", () => {
  const zpcr = parseZpcr(readSampleBytes());
  const last = zpcr.reads.at(-1)!;

  it("extracts every temperature field in the file, in file order", () => {
    expect(last.temps.map((t) => t.key)).toEqual([
      "BLOCKTEMP",
      "AMBIENTTEMP",
      "SHUTTLETEMP",
      "SAMPLETEMP",
      "LIDTEMP",
      "FANOFFTEMP",
      "FANONTEMP",
    ]);
  });

  it("decodes measured temperatures as big-endian floats", () => {
    const by = new Map(last.temps.map((t) => [t.key, t]));
    expect(by.get("BLOCKTEMP")!.celsius).toBeCloseTo(59.99, 2);
    expect(by.get("AMBIENTTEMP")!.celsius).toBeCloseTo(32.0, 2);
    expect(by.get("SHUTTLETEMP")!.celsius).toBeCloseTo(45.08, 2);
    expect(by.get("SAMPLETEMP")!.celsius).toBeCloseTo(60.0, 2);
    expect(by.get("LIDTEMP")!.celsius).toBeCloseTo(105.1, 2);
  });

  it("decodes the fan thresholds as int set points, not measurements", () => {
    const fanOff = last.temps.find((t) => t.key === "FANOFFTEMP")!;
    const fanOn = last.temps.find((t) => t.key === "FANONTEMP")!;
    expect(fanOff).toMatchObject({ celsius: 35, kind: "setpoint" });
    expect(fanOn).toMatchObject({ celsius: 40, kind: "setpoint" });
    // These match RunInfo.xml's FanControl{Off,On}Temperature.
    expect(zpcr.metadata.raw["FanControlOffTemperature"]).toBe("35");
    expect(zpcr.metadata.raw["FanControlOnTemperature"]).toBe("40");
  });

  it("marks instrument readings as measured", () => {
    const measured = last.temps.filter((t) => t.kind === "measured");
    expect(measured.map((t) => t.key)).toEqual([
      "BLOCKTEMP",
      "AMBIENTTEMP",
      "SHUTTLETEMP",
      "SAMPLETEMP",
      "LIDTEMP",
    ]);
  });

  it("keeps blockTempC consistent with the BLOCKTEMP field", () => {
    for (const read of zpcr.reads) {
      const block = read.temps.find((t) => t.key === "BLOCKTEMP");
      expect(read.blockTempC).toBe(block?.celsius);
    }
  });
});

describe("temperature curves", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("yields one series per field, aligned with the cycles", () => {
    const curves = zpcr.temperatureCurves();
    expect(curves.map((c) => c.key)).toEqual([
      "BLOCKTEMP",
      "AMBIENTTEMP",
      "SHUTTLETEMP",
      "SAMPLETEMP",
      "LIDTEMP",
      "FANOFFTEMP",
      "FANONTEMP",
    ]);
    const block = curves[0]!;
    expect(block.cycles).toEqual(zpcr.reads.map((r) => r.cycle));
    expect(block.celsius).toHaveLength(zpcr.reads.length);
    // The plate read happens at the 60 °C step, so every cycle sits near 60.
    for (const v of block.celsius) expect(v).toBeGreaterThan(55);
    for (const v of block.celsius) expect(v).toBeLessThan(65);
  });

  it("carries the label and kind of each field", () => {
    const curves = zpcr.temperatureCurves();
    expect(curves.map((c) => c.label)).toEqual([
      "Block",
      "Ambient",
      "Shuttle",
      "Sample",
      "Lid",
      "Fan off at",
      "Fan on at",
    ]);
    expect(curves.at(-1)!.kind).toBe("setpoint");
  });

  it("filters to a single protocol step", () => {
    const multi = parseZpcr(readMultistepBytes());
    expect(multi.temperatureCurves(2)[0]!.cycles).toHaveLength(2);
    expect(multi.temperatureCurves(4)[0]!.cycles).toHaveLength(8);
  });

  it("tracks the block through a multi-step protocol's different hold temperatures", () => {
    const multi = parseZpcr(readMultistepBytes());
    const at = (step: number) =>
      multi.temperatureCurves(step).find((c) => c.key === "BLOCKTEMP")!.celsius;
    // The two PLATEREAD steps read at clearly different block temperatures.
    const meanOf = (v: (number | null)[]) =>
      v.reduce((a: number, b) => a + (b ?? 0), 0) / v.length;
    expect(Math.abs(meanOf(at(2)) - meanOf(at(4)))).toBeGreaterThan(1);
  });
});

describe("temperature field naming", () => {
  it("labels the known CFX fields", () => {
    expect(tempLabel("BLOCKTEMP")).toBe("Block");
    expect(tempLabel("LIDTEMP")).toBe("Lid");
    expect(tempLabel("FANONTEMP")).toBe("Fan on at");
  });

  it("derives labels for fields no CFX firmware here emits", () => {
    expect(tempLabel("HEATSINKTEMP")).toBe("Heatsink");
    expect(tempLabel("ROWTEMPA")).toBe("Row A");
    expect(tempLabel("BLOCKTEMP03")).toBe("Block 03");
    expect(tempLabel("TEMP")).toBe("Temp");
  });

  it("recognises per-row temperatures by their trailing row letter", () => {
    expect(tempRow("ROWTEMPA")).toBe("A");
    expect(tempRow("BLOCKTEMPH")).toBe("H");
    expect(tempRow("BLOCKTEMP")).toBeUndefined();
    expect(tempRow("BLOCKTEMP03")).toBeUndefined();
  });

  it("picks up hypothetical per-row block temperatures with no code change", () => {
    // Guards the generic path: any *TEMP* field is extracted, so a firmware emitting one
    // temperature per plate row (A–H) would plot without touching the decoder.
    const rows = "ABCDEFGH".split("").map((r, i) => field(`ROWTEMP${r}`, { float: 60 + i }));
    const temps = extractTemps([field("BLOCKTEMP", { float: 59.99 }), ...rows]);
    expect(temps).toHaveLength(9);
    expect(temps[1]).toMatchObject({ key: "ROWTEMPA", label: "Row A", row: "A", celsius: 60 });
    expect(temps.at(-1)).toMatchObject({ key: "ROWTEMPH", row: "H", celsius: 67 });
  });

  it("ignores non-temperature and implausible fields", () => {
    const temps = extractTemps([
      field("CYCLE", { int: 45 }),
      field("BLOCKTEMP", { float: 1e30, int: 1e9 }),
      field("DATETIME", { length: 30, text: "Tue, 21 Jul 2026 06:22:23 GMT" }),
    ]);
    expect(temps).toEqual([]);
  });
});
