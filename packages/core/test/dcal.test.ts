import { describe, it, expect } from "vitest";
import { findDcalBlock, isDcalName, parseDcal, parseZpcr } from "../src/index.js";
import { readSampleBytes } from "./sample.js";

function famClear() {
  const zpcr = parseZpcr(readSampleBytes());
  const entry = zpcr.calibrations().find((c) => c.name === "FAM_BR Clear.Dcal")!;
  return entry.dcal;
}

describe("isDcalName", () => {
  it("matches .Dcal case-insensitively", () => {
    expect(isDcalName("FAM_BR Clear.Dcal")).toBe(true);
    expect(isDcalName("fam_br clear.dcal")).toBe(true);
    expect(isDcalName("FAM_BR CLEAR.DCAL")).toBe(true);
    expect(isDcalName("FAM_BR Clear.pltd")).toBe(false);
  });
});

describe("zpcr.calibrations()", () => {
  it("finds every .Dcal entry in the archive", () => {
    const zpcr = parseZpcr(readSampleBytes());
    const calibrations = zpcr.calibrations();
    expect(calibrations).toHaveLength(28); // 14 dyes × {BR Clear, BR White}
    expect(calibrations.map((c) => c.name)).toContain("FAM_BR Clear.Dcal");
    // Unencrypted — every entry decodes with no password.
    for (const { dcal } of calibrations) {
      expect(dcal.dye.length).toBeGreaterThan(0);
    }
  });
});

describe("parseDcal — metadata", () => {
  const dcal = famClear();

  it("decodes the dye and plate identity", () => {
    expect(dcal.dye).toBe("FAM");
    expect(dcal.plate).toBe("BR Clear");
  });

  it("converts PRIMARYCHANNEL to a 0-based channel", () => {
    // FAM is channel 1 (1-based) on disk == channel 0 here.
    expect(dcal.primaryChannel).toBe(0);
  });

  it("decodes the plate geometry", () => {
    expect(dcal.channelCount).toBe(6);
    expect(dcal.wellCount).toBe(108); // 9 rows (incl. reference row) × 12 columns
  });

  it("decodes the factory/user flag consistent with a live-instrument snapshot", () => {
    // Live-instrument .Dcal snapshots (as opposed to CFX's shipped support files) are all
    // user calibrations.
    expect(dcal.factory).toBe(false);
  });

  it("decodes temperatures and serials", () => {
    expect(dcal.ambientTempC).toBeCloseTo(31.0, 1);
    expect(dcal.shuttleTempC).toBeCloseTo(44.74, 1);
    expect(dcal.serials.alpha).toBe("SG16130");
    expect(dcal.serials.head).toBe("785BR13647");
  });

  it("decodes notes as a raw string", () => {
    expect(dcal.notes).toMatch(/\|/);
  });
});

describe("parseDcal — payload blocks", () => {
  const dcal = famClear();

  it("has a dye and empty block at each of the four temperatures", () => {
    expect(dcal.blocks).toHaveLength(8);
    const key = (b: (typeof dcal.blocks)[number]) => `${b.kind}${b.rotationDeg}:${b.temperatureC}`;
    expect(new Set(dcal.blocks.map(key))).toEqual(
      new Set([
        "dye0:20",
        "dye0:40",
        "dye0:60",
        "dye0:80",
        "empty0:20",
        "empty0:40",
        "empty0:60",
        "empty0:80",
      ]),
    );
  });

  it("finds a block via findDcalBlock", () => {
    const block = findDcalBlock(dcal, "dye", 60)!;
    expect(block).toBeDefined();
    expect(block.channelCount).toBe(6);
    expect(block.wellCount).toBe(108);
    expect(block.values).toHaveLength(6 * 108);
  });

  it("returns undefined for a rotation/temperature not present", () => {
    expect(findDcalBlock(dcal, "dye", 60, 180)).toBeUndefined();
    expect(findDcalBlock(dcal, "dye", 99)).toBeUndefined();
  });

  it("is channel-major with a real FAM signal on channel 0 and near-zero on channel 5", () => {
    const block = findDcalBlock(dcal, "dye", 20)!;
    const well0 = (ch: number) => block.values[ch * block.wellCount]!;
    expect(well0(0)).toBeGreaterThan(1000); // strong FAM signal on its primary channel
    expect(well0(5)).toBe(0); // unused sixth channel is all zeros on CFX96
  });

  it("carries the same value across every well in a channel (observed in every sample file)", () => {
    const block = findDcalBlock(dcal, "dye", 60)!;
    for (let ch = 0; ch < block.channelCount; ch++) {
      const values = block.values.slice(ch * block.wellCount, (ch + 1) * block.wellCount);
      expect(new Set(values).size).toBe(1);
    }
  });
});

describe("parseDcal — raw field access", () => {
  it("exposes every ICFF field, including ones with no typed accessor", () => {
    const dcal = famClear();
    expect(dcal.fields.length).toBeGreaterThanOrEqual(33);
    expect(dcal.fields.some((f) => f.name === "WELLS")).toBe(true);
  });
});
