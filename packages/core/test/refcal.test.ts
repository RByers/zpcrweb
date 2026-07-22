import { describe, it, expect } from "vitest";
import { parseZpcr, parseFactoryRefRowCal } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("parseFactoryRefRowCal", () => {
  it("parses a small column-major (mean,min,max,std) blob", () => {
    // 1 column, 2 channels: ch0=(10,9,11,0.5), ch1=(20,19,21,0.6)
    const cal = parseFactoryRefRowCal("10,9,11,0.5,20,19,21,0.6", 2, 1);
    expect(cal).toHaveLength(2);
    expect(cal[0]).toEqual({ channel: 0, col: 0, mean: 10, min: 9, max: 11, std: 0.5 });
    expect(cal[1]).toEqual({ channel: 1, col: 0, mean: 20, min: 19, max: 21, std: 0.6 });
  });

  it("stops at trailing zero-padding / short input", () => {
    expect(parseFactoryRefRowCal("", 6, 12)).toEqual([]);
  });
});

describe("factoryRefCal (from the sample)", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("decodes 72 reference wells (12 columns × 6 channels)", () => {
    expect(zpcr.factoryRefCal()).toHaveLength(72);
  });

  it("matches known factory values (column-major layout)", () => {
    const cal = zpcr.factoryRefCal();
    const at = (channel: number, col: number) =>
      cal.find((c) => c.channel === channel && c.col === col)!;
    // column 1 / channel 1 ≈ 2008.7; bright column 10 / channel 0 ≈ 44251
    expect(at(1, 0).mean).toBeCloseTo(2008.74, 1);
    expect(at(0, 9).mean).toBeCloseTo(44251.01, 0);
  });
});

describe("refCalComparison", () => {
  const zpcr = parseZpcr(readSampleBytes());
  const cmp = zpcr.refCalComparison();
  const at = (channel: number, col: number) =>
    cmp.find((c) => c.channel === channel && c.col === col)!;

  it("shows the bright reference positions have dimmed since calibration", () => {
    // column 10, channel 0: factory ~44251, live ~39000 → ratio < 1 (LED aging)
    const c = at(0, 9);
    expect(c.factoryMean).toBeCloseTo(44251.01, 0);
    expect(c.ratio).toBeGreaterThan(0.85);
    expect(c.ratio).toBeLessThan(0.95);
    expect(c.delta).toBeLessThan(0);
  });

  it("shows some mid-level red-channel positions read higher than factory", () => {
    // column 2, channel 4 (Cy5): factory ~3997, live ~4880 → ratio > 1.15
    const c = at(4, 1);
    expect(c.ratio).toBeGreaterThan(1.15);
  });

  it("leaves dark background reference positions essentially unchanged", () => {
    // column 1 is dark background (~2000) in every channel → ratio ≈ 1
    for (let ch = 0; ch < 6; ch++) {
      expect(at(ch, 0).ratio).toBeGreaterThan(0.95);
      expect(at(ch, 0).ratio).toBeLessThan(1.05);
    }
  });
});
