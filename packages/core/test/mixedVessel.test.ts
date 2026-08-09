/**
 * A plate loaded with a mix of plastics — white tubes beside clear ones in the same block.
 *
 * The instrument runs such a block happily, but no CFX format can describe it: a `.pltd`/`.pcrd`
 * carries the vessel once, on the root element (`pltd.md` §2). Only zpcrweb's own `.plt.csv` can
 * state it per well, so these tests build one from the committed sample's real plate and attach
 * it back to the real archive — the whole path a user would take.
 *
 * What is asserted, and why each matters:
 *
 * - each vessel gets its **own** calibration matrix, and a clear well's numbers are untouched by
 *   a white well appearing elsewhere on the plate;
 * - thresholds stay **one per fluorophore, across both vessels** — the deliberate decision
 *   recorded in `calibration.md` §3.1, measured at ≤0.52 cycles of cost.
 */
import { describe, it, expect } from "vitest";
import {
  attachPlate,
  computeRunAnalysis,
  curveKey,
  parsePlateCsv,
  parseZpcrArchive,
  plateToCsv,
  plateTubeTypes,
  wellDyeSet,
  type FluorCalibration,
  type PlateDefinition,
} from "../src/index.js";
import { readMixedVesselPlateText, readSampleArchive } from "./sample.js";

/** The step the sample's amplification lives on. */
const STEP = 2;

/** The sample's own plate, with `vessel` set per well by `pick` — the wells it returns undefined
 * for say nothing and fall back to the plate's own value, which a mixed plate leaves empty. */
function mixedPlate(base: PlateDefinition, pick: (label: string) => string | undefined): PlateDefinition {
  return {
    ...base,
    plateName: "",
    wells: base.wells.map((w) => ({ ...w, vessel: pick(w.label) })),
  };
}

function analyze(plate: PlateDefinition | null) {
  const archive = readSampleArchive();
  const augmented = plate
    ? attachPlate(archive, {
        name: "mixed.plt.csv",
        bytes: new TextEncoder().encode(plateToCsv(plate)),
      })
    : archive;
  return computeRunAnalysis(parseZpcrArchive(augmented), {}, STEP);
}

describe("mixed-vessel plate", () => {
  const basePlate = (() => {
    const plate = computeRunAnalysis(parseZpcrArchive(readSampleArchive()), {}, STEP).plate;
    if (!plate) throw new Error("expected the sample to carry a plate");
    return plate;
  })();

  /** Loaded wells, split into two halves by column parity — the mixed plate's two vessels. */
  const loaded = basePlate.wells.filter((w) => w.loaded).map((w) => w.label);
  const whiteHalf = new Set(loaded.filter((_, i) => i % 2 === 0));

  it("reports every vessel the plate's wells sit in", () => {
    const allClear = analyze(mixedPlate(basePlate, () => "BR Clear"));
    expect(allClear.tubes).toEqual(["BR Clear"]);

    const mixed = analyze(mixedPlate(basePlate, (l) => (whiteHalf.has(l) ? "BR White" : "BR Clear")));
    expect([...mixed.tubes].sort()).toEqual(["BR Clear", "BR White"]);
  });

  it("solves each well against its own vessel's calibration", () => {
    const allClear = analyze(mixedPlate(basePlate, () => "BR Clear"));
    const mixed = analyze(mixedPlate(basePlate, (l) => (whiteHalf.has(l) ? "BR White" : "BR Clear")));

    const valuesFor = (run: typeof mixed, label: string) =>
      run.allFluorCurves.filter((c) => c.wellLabel === label).map((c) => c.mean);

    // A clear well is bit-identical whether or not white wells share the plate: one well's
    // plastic is nobody else's business, and the solve is per well.
    for (const label of loaded.filter((l) => !whiteHalf.has(l))) {
      expect(valuesFor(mixed, label)).toEqual(valuesFor(allClear, label));
    }
    // A white well genuinely moves — it is being unmixed against a different response.
    const moved = [...whiteHalf].filter(
      (label) => JSON.stringify(valuesFor(mixed, label)) !== JSON.stringify(valuesFor(allClear, label)),
    );
    expect(moved).toEqual([...whiteHalf]);
  });

  it("keeps one threshold per fluorophore across both vessels", () => {
    const mixed = analyze(mixedPlate(basePlate, (l) => (whiteHalf.has(l) ? "BR White" : "BR Clear")));
    // The threshold group is the fluorophore and nothing else — a mixed plate does not split a
    // dye's wells into per-vessel cohorts (`threshold.md` §5.2, `calibration.md` §3.1).
    for (const c of mixed.allFluorCurves) {
      expect(mixed.thresholdGroupOf(c.row, c.col, c.dye)).toBe(c.dye);
    }
    const thresholdsByDye = new Map<string, Set<number | null | undefined>>();
    for (const c of mixed.allFluorCurves) {
      const entry = mixed.cqTable.get(curveKey(c.row, c.col, c.dye));
      if (!entry) continue;
      const seen = thresholdsByDye.get(c.dye) ?? new Set();
      seen.add(entry.threshold);
      thresholdsByDye.set(c.dye, seen);
    }
    expect(thresholdsByDye.size).toBeGreaterThan(0);
    for (const seen of thresholdsByDye.values()) expect(seen.size).toBe(1);
  });

  it("leaves a single-vessel plate exactly as it was", () => {
    // The whole point of the per-well field being optional: every plate CFX can write, and every
    // plate written before it existed, goes down the identical path.
    const untouched = analyze(null);
    const restated = analyze(mixedPlate(basePlate, () => basePlate.plateName));
    expect(untouched.tubes).toEqual(["BR Clear"]);
    expect(restated.allFluorCurves.map((c) => c.mean)).toEqual(untouched.allFluorCurves.map((c) => c.mean));
  });
});

describe("the committed mixed-vessel sample plate", () => {
  const text = readMixedVesselPlateText();
  const plate = parsePlateCsv(text, { sourceName: "mixed-vessel-YouSeq-RVP.plt.csv" });

  it("is a real mixed-vessel plate, not a single-vessel one with a column", () => {
    expect([...plateTubeTypes(plate)].sort()).toEqual(["BR Clear", "BR White"]);
    // The whole point of the file: the plate level says nothing, the wells say it all.
    expect(plate.plateName).toBe("");
    expect(text).toContain("# vessel: 8x12\r\n");
    const byVessel = new Map<string, number>();
    for (const w of plate.wells) if (w.vessel) byVessel.set(w.vessel, (byVessel.get(w.vessel) ?? 0) + 1);
    expect(byVessel.get("BR White")).toBe(24);
    expect(byVessel.get("BR Clear")).toBe(8);
  });

  it("round-trips byte-for-byte", () => {
    expect(plateToCsv(plate)).toBe(text);
  });

  it("carries two dyes on one optical channel, in different wells", () => {
    // The point of the sample: the panel's ROX and the operator's own Tex 615 are both channel 2.
    // No well holds both — nothing could unmix that — but the plate holds both, which is legal
    // and which CFX has no way to write down.
    expect(plate.fluors.map((f) => f.fluor)).toEqual(["FAM", "VIC", "ROX", "Tex 615", "Cy5"]);
    const dyesIn = (vessel: string) =>
      new Set(plate.wells.filter((w) => w.vessel === vessel).flatMap((w) => w.fluors.map((f) => f.fluor)));
    expect(dyesIn("BR White")).toContain("ROX");
    expect(dyesIn("BR White")).not.toContain("Tex 615");
    expect(dyesIn("BR Clear")).toContain("Tex 615");
    expect(dyesIn("BR Clear")).not.toContain("ROX");
    for (const w of plate.wells) {
      const dyes = w.fluors.map((f) => f.fluor);
      expect(dyes.includes("ROX") && dyes.includes("Tex 615")).toBe(false);
    }
  });

  it("has both vessels sharing a dye, which is what makes it worth having", () => {
    // A plate whose vessels used disjoint dye sets would never exercise a threshold group that
    // spans both (`calibration.md` Appendix A) — FAM and Cy5 appear in each.
    const dyesIn = (vessel: string) =>
      new Set(plate.wells.filter((w) => w.vessel === vessel).flatMap((w) => w.fluors.map((f) => f.fluor)));
    const white = dyesIn("BR White");
    for (const shared of ["FAM", "Cy5"]) {
      expect(white).toContain(shared);
      expect(dyesIn("BR Clear")).toContain(shared);
    }
  });

  it("analyses without the channel collision poisoning the plate", () => {
    // The regression this sample exists for. Built with one matrix over the plate's whole dye
    // list, ROX and Tex 615 sit in the same matrix as 0.999+ collinear columns and the solve
    // blows up — ROX's threshold went to 8119 RFU against its usual 49, and Tex 615 got no Cq at
    // all. Per-well dye sets keep every threshold in the ordinary tens of RFU.
    const archive = readSampleArchive();
    const run = computeRunAnalysis(
      parseZpcrArchive(
        attachPlate(archive, {
          name: "mixed.plt.csv",
          bytes: new TextEncoder().encode(plateToCsv(plate)),
        }),
      ),
      {},
      STEP,
    );
    const thresholds = new Map<string, number>();
    for (const c of run.allFluorCurves) {
      const e = run.cqTable.get(curveKey(c.row, c.col, c.dye));
      if (e?.threshold != null) thresholds.set(c.dye, e.threshold);
    }
    expect(thresholds.size).toBeGreaterThan(0);
    for (const [dye, t] of thresholds) {
      expect(t, `${dye} threshold`).toBeGreaterThan(0);
      expect(t, `${dye} threshold`).toBeLessThan(500);
    }
  });

  it("never puts two same-channel dyes in one well's matrix", () => {
    const archive = readSampleArchive();
    const run = computeRunAnalysis(
      parseZpcrArchive(
        attachPlate(archive, {
          name: "mixed.plt.csv",
          bytes: new TextEncoder().encode(plateToCsv(plate)),
        }),
      ),
      {},
      STEP,
    );
    const byWell = new Map<string, string[]>();
    for (const c of run.allFluorCurves) {
      byWell.set(c.wellLabel, [...(byWell.get(c.wellLabel) ?? []), c.dye]);
    }
    expect(byWell.size).toBeGreaterThan(0);
    for (const [well, dyes] of byWell) {
      expect(dyes.includes("ROX") && dyes.includes("Tex 615"), `well ${well}`).toBe(false);
      // Each well still gets a full set — the free channels are filled in, so the "Unloaded"
      // display has something to draw for every channel the run scanned.
      expect(dyes.length, `well ${well}`).toBe(4);
    }
    // A well that carries the dye is always solved for it, never for its rival.
    const dyesAt = (label: string) => byWell.get(label) ?? [];
    expect(dyesAt("A4")).toContain("ROX");
    expect(dyesAt("A11")).toContain("Tex 615");
  });
});

describe("wellDyeSet", () => {
  /** A calibration stub — only the fields the rule reads. */
  const cal = (fluor: string, primaryChannel: number | undefined) =>
    ({ fluor, channel: primaryChannel, primaryChannel }) as FluorCalibration;

  /** FAM ch0, VIC ch1, ROX ch2, Tex 615 ch2, Cy5 ch3 — the committed sample's shape. */
  const CALS = [cal("FAM", 0), cal("VIC", 1), cal("ROX", 2), cal("Tex 615", 2), cal("Cy5", 3)];
  const names = (out: FluorCalibration[]) => out.map((f) => f.fluor);

  it("gives a plate with one dye per channel every dye, in every well", () => {
    // The no-collision case — every plate CFX can write. Nothing is dropped, so results are
    // identical to building one matrix for the whole plate.
    const cals = [cal("FAM", 0), cal("HEX", 1), cal("Cy5", 3)];
    expect(names(wellDyeSet(new Set(["FAM"]), cals))).toEqual(["FAM", "HEX", "Cy5"]);
    expect(names(wellDyeSet(new Set(), cals))).toEqual(["FAM", "HEX", "Cy5"]);
  });

  it("keeps the dye the well actually carries when two contest a channel", () => {
    expect(names(wellDyeSet(new Set(["FAM", "ROX", "Cy5"]), CALS))).toEqual([
      "FAM", "VIC", "ROX", "Cy5",
    ]);
    expect(names(wellDyeSet(new Set(["FAM", "Tex 615", "Cy5"]), CALS))).toEqual([
      "FAM", "VIC", "Tex 615", "Cy5",
    ]);
  });

  it("fills the free channels, so a well can still be shown against dyes it lacks", () => {
    // The well carries only FAM; VIC and Cy5 are free channels and come along, which is what
    // the app's "Unloaded" toggle draws. Only the contested channel is resolved to one dye.
    const out = names(wellDyeSet(new Set(["FAM"]), CALS));
    expect(out).toContain("VIC");
    expect(out).toContain("Cy5");
    expect(out.filter((d) => d === "ROX" || d === "Tex 615")).toHaveLength(1);
  });

  it("never returns two dyes on the same channel", () => {
    for (const own of [[], ["FAM"], ["ROX"], ["Tex 615"], ["FAM", "Tex 615", "Cy5"]]) {
      const out = wellDyeSet(new Set(own), CALS);
      const channels = out.map((f) => f.primaryChannel);
      expect(new Set(channels).size).toBe(channels.length);
    }
  });

  it("breaks a tie by rank, for a well that carries neither rival", () => {
    const rank = (f: string) => (f === "Tex 615" ? 10 : 0);
    expect(names(wellDyeSet(new Set(["FAM"]), CALS, rank))).toContain("Tex 615");
    expect(names(wellDyeSet(new Set(["FAM"]), CALS, (f) => (f === "ROX" ? 10 : 0)))).toContain("ROX");
  });

  it("returns the caller's order, not rank order", () => {
    // The matrix's columns and a well's curves come out in plate fluor order whatever the
    // tie-break decided.
    const out = names(wellDyeSet(new Set(), CALS, (f) => (f === "Tex 615" ? 10 : 0)));
    expect(out).toEqual(["FAM", "VIC", "Tex 615", "Cy5"]);
  });

  it("includes a dye whose channel is unknown rather than guessing", () => {
    const cals = [cal("FAM", 0), cal("Mystery", undefined)];
    expect(names(wellDyeSet(new Set(["FAM"]), cals))).toEqual(["FAM", "Mystery"]);
  });
});
