import { describe, it, expect } from "vitest";
import { parseZpcr, wellLabel } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

describe("well-centric curves (pivot)", () => {
  const zpcr = parseZpcr(readSampleBytes());

  it("produces one curve per sample well/channel by default (no reference row)", () => {
    const curves = zpcr.curves();
    // 6 channels × 8 sample rows × 12 cols = 576
    expect(curves).toHaveLength(576);
    expect(curves.every((c) => !c.isReference)).toBe(true);
  });

  it("includes the reference row when asked", () => {
    const curves = zpcr.curves({ includeReference: true });
    // 6 channels × 9 rows × 12 cols = 648
    expect(curves).toHaveLength(648);
    expect(curves.some((c) => c.isReference)).toBe(true);
  });

  it("filters to a single channel", () => {
    const curves = zpcr.curves({ channel: 2 });
    expect(curves).toHaveLength(96); // 8 rows × 12 cols
    expect(curves.every((c) => c.channel === 2)).toBe(true);
  });

  it("aligns cycles and mean arrays, ascending across 45 cycles", () => {
    const curve = zpcr.curves({ channel: 2 }).find((c) => c.wellLabel === "A3")!;
    expect(curve.cycles).toHaveLength(45);
    expect(curve.mean).toHaveLength(45);
    expect(curve.cycles[0]).toBe(1);
    expect(curve.cycles[44]).toBe(45);
  });

  it("shows the A3/channel-2 amplification curve rising to plateau", () => {
    const curve = zpcr.curves({ channel: 2 }).find((c) => c.wellLabel === "A3")!;
    expect(curve.mean[0]).toBeCloseTo(4288.7, 0);
    expect(curve.mean[44]).toBeCloseTo(6852.1, 0);
    expect(curve.mean[44]!).toBeGreaterThan(curve.mean[0]!);
  });

  it("carries per-cycle stats (std/min/max) aligned with mean", () => {
    const curve = zpcr.curves({ channel: 2 }).find((c) => c.wellLabel === "A3")!;
    expect(curve.std).toHaveLength(45);
    expect(curve.min).toHaveLength(45);
    expect(curve.max).toHaveLength(45);
    // stats bracket the mean at each cycle
    for (let i = 0; i < curve.cycles.length; i++) {
      expect(curve.min[i]!).toBeLessThanOrEqual(curve.mean[i]!);
      expect(curve.max[i]!).toBeGreaterThanOrEqual(curve.mean[i]!);
      expect(curve.std[i]!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("wellLabel", () => {
  it("labels sample rows A–H with 1-based columns", () => {
    expect(wellLabel(0, 2)).toBe("A3");
    expect(wellLabel(7, 11)).toBe("H12");
  });

  it("labels the reference row with R", () => {
    expect(wellLabel(8, 0)).toBe("R1");
  });
});
