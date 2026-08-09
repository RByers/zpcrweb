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

  it("keeps one dye per optical channel, so the unmixing stays well-posed", () => {
    // Both halves of the plate are read in the same four channels, and two dyes sharing one
    // channel cannot be separated by a single reading in it — the panel's ROX and the operator's
    // own Tex 615 are both channel 2, which is exactly why the clear column here is the
    // FAM/Cy5 control column rather than that plate's Tex 615 multiplex.
    expect(plate.fluors.map((f) => f.fluor)).toEqual(["FAM", "VIC", "ROX", "Cy5"]);
  });

  it("has both vessels sharing a dye, which is what makes it worth having", () => {
    // A plate whose vessels used disjoint dye sets would never exercise a threshold group that
    // spans both (`calibration.md` Appendix A) — FAM and Cy5 have to appear in each.
    const dyesIn = (vessel: string) =>
      new Set(plate.wells.filter((w) => w.vessel === vessel).flatMap((w) => w.fluors.map((f) => f.fluor)));
    const white = dyesIn("BR White");
    const clear = dyesIn("BR Clear");
    expect([...clear].every((d) => white.has(d))).toBe(true);
    expect([...clear].sort()).toEqual(["Cy5", "FAM"]);
  });
});
