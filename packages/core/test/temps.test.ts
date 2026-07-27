import { describe, it, expect } from "vitest";
import { extractTemps, parseZpcr, tempLabel } from "../src/index.js";
import type { IcffEntry } from "../src/index.js";
import { readGradientBytes, readMultistepBytes, readSampleBytes } from "./sample.js";

/** Build a minimal ICFF entry for the label/decoding unit tests. */
function field(name: string, extra: Partial<IcffEntry> = {}): IcffEntry {
  return { name, offset: 1, length: 4, flag: 1, hex: "", ...extra };
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

describe("a gradient run's temperatures", () => {
  // A gradient step holds each plate row at a different temperature, so if any run reported
  // per-row block temperatures it would be this one. It reports the same seven whole-block
  // fields as every other run — the gradient's span lives only in the protocol.
  const zpcr = parseZpcr(readGradientBytes());

  it("reports the same whole-block fields, none of them per-row", () => {
    expect(zpcr.reads.length).toBeGreaterThan(0);
    for (const read of zpcr.reads) {
      expect(read.temps.map((t) => t.key)).toEqual([
        "BLOCKTEMP",
        "AMBIENTTEMP",
        "SHUTTLETEMP",
        "SAMPLETEMP",
        "LIDTEMP",
        "FANOFFTEMP",
        "FANONTEMP",
      ]);
    }
  });

  it("carries the gradient's span in the protocol instead", () => {
    // `GRAD <low>,<high>,<hold>` — the only place the 55–65 °C spread is recorded.
    expect(zpcr.protocol()!.runDefinition).toContain("GRAD 55.0,65.0,30");
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
    expect(tempLabel("TEMP")).toBe("Temp");
  });

  it("extracts a temperature field it has never seen before", () => {
    // Guards the generic path: any *TEMP* field is extracted and labelled, so a firmware
    // reporting a temperature this decoder doesn't know about still plots.
    const temps = extractTemps([
      field("BLOCKTEMP", { float: 59.99 }),
      field("HEATSINKTEMP", { float: 41.5 }),
    ]);
    expect(temps).toHaveLength(2);
    expect(temps[1]).toMatchObject({
      key: "HEATSINKTEMP",
      label: "Heatsink",
      celsius: 41.5,
      kind: "measured",
    });
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
