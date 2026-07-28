import { describe, it, expect } from "vitest";
import {
  buildCalibrationMatrix,
  buildDyeReadingCurves,
  buildDyeResponseCurve,
  interpolateResponse,
  parseZpcr,
  preprocessChannelReadings,
  separateChannels,
  separateDyes,
  type CalibrationMatrix,
  type Dcal,
  type NormalizationMode,
  type ResponseKnot,
} from "../src/index.js";
import { findDcalBlock } from "../src/dcal.js";
import { readSampleBytes } from "./sample.js";

function calibrations(): Map<string, Dcal> {
  const zpcr = parseZpcr(readSampleBytes());
  return new Map(zpcr.calibrations().map((c) => [c.name, c.dcal]));
}

/**
 * A hand-written, unnormalized calibration matrix: `values` are taken as the raw per-dye
 * responses, so `columnScale` is 1 and `columnNorm` is each column's own L2 norm — the same
 * bookkeeping `buildCalibrationMatrix` does with `normalization: "none"`.
 */
function rawMatrix(dyes: string[], values: number[][]): CalibrationMatrix {
  return {
    dyes,
    channels: values.map((_, i) => i),
    channelCount: values.length,
    values,
    columnScale: dyes.map(() => 1),
    columnNorm: dyes.map((_, d) =>
      Math.sqrt(values.reduce((sum, row) => sum + row[d]! ** 2, 0)),
    ),
  };
}

/** The RFU `separateChannels` reports for a dye present at `concentration` in `matrix`. */
function expectedRfu(matrix: CalibrationMatrix, dye: number, concentration: number): number {
  return concentration * matrix.columnNorm[dye]!;
}

describe("buildDyeResponseCurve", () => {
  const dcal = calibrations().get("FAM_BR Clear.Dcal")!;
  const curve = buildDyeResponseCurve(dcal);

  it("has one channel of knots per optical channel, one knot per calibrated temperature", () => {
    expect(curve.dye).toBe("FAM");
    expect(curve.channels).toHaveLength(dcal.channelCount);
    for (const knots of curve.channels) {
      expect(knots.map((k) => k.temperatureC)).toEqual([20, 40, 60, 80]);
    }
  });

  it("matches max(0, dyeReading - emptyReading) against the source blocks directly", () => {
    for (const temperatureC of [20, 40, 60, 80]) {
      const dyeBlock = findDcalBlock(dcal, "dye", temperatureC)!;
      const emptyBlock = findDcalBlock(dcal, "empty", temperatureC)!;
      for (let channel = 0; channel < dcal.channelCount; channel++) {
        const expected = Math.max(
          0,
          dyeBlock.values[channel * dyeBlock.wellCount]! -
            emptyBlock.values[channel * emptyBlock.wellCount]!,
        );
        const knot = curve.channels[channel]!.find((k) => k.temperatureC === temperatureC)!;
        expect(knot.response).toBeCloseTo(expected, 6);
      }
    }
  });

  it("is never negative, even where the empty-plate reading exceeds the dye reading", () => {
    for (const knots of curve.channels) {
      for (const k of knots) expect(k.response).toBeGreaterThanOrEqual(0);
    }
  });

  it("shows a strong signal on FAM's primary channel and near-zero on the unused sixth", () => {
    expect(curve.channels[dcal.primaryChannel]!.every((k) => k.response > 1000)).toBe(true);
    expect(curve.channels[5]!.every((k) => k.response === 0)).toBe(true);
  });
});

describe("buildDyeReadingCurves", () => {
  const dcal = calibrations().get("FAM_BR Clear.Dcal")!;
  const readings = buildDyeReadingCurves(dcal);

  it("returns both source blocks' readings, on the response curve's own knot grid", () => {
    expect(readings.dye).toBe("FAM");
    expect(readings.channels).toHaveLength(dcal.channelCount);
    for (const knots of readings.channels) {
      expect(knots.map((k) => k.temperatureC)).toEqual([20, 40, 60, 80]);
    }
    for (const temperatureC of [20, 40, 60, 80]) {
      const dyeBlock = findDcalBlock(dcal, "dye", temperatureC)!;
      const emptyBlock = findDcalBlock(dcal, "empty", temperatureC)!;
      for (let channel = 0; channel < dcal.channelCount; channel++) {
        const knot = readings.channels[channel]!.find((k) => k.temperatureC === temperatureC)!;
        expect(knot.dye).toBeCloseTo(dyeBlock.values[channel * dyeBlock.wellCount]!, 6);
        expect(knot.empty).toBeCloseTo(emptyBlock.values[channel * emptyBlock.wellCount]!, 6);
      }
    }
  });

  it("is exactly what buildDyeResponseCurve clamps the difference of", () => {
    const curve = buildDyeResponseCurve(dcal);
    readings.channels.forEach((knots, channel) => {
      knots.forEach((k, i) => {
        const response = curve.channels[channel]![i]!;
        expect(response.temperatureC).toBe(k.temperatureC);
        expect(response.response).toBeCloseTo(Math.max(0, k.dye - k.empty), 6);
      });
    });
  });

  it("records a real empty-plate level — the readings are not just the response repeated", () => {
    const primary = readings.channels[dcal.primaryChannel]!;
    expect(primary.every((k) => k.empty > 0)).toBe(true);
    expect(primary.every((k) => k.dye > k.empty)).toBe(true);
  });
});

describe("interpolateResponse", () => {
  const knots: ResponseKnot[] = [
    { temperatureC: 20, response: 100 },
    { temperatureC: 40, response: 80 },
    { temperatureC: 60, response: 40 },
    { temperatureC: 80, response: 20 },
  ];

  it("returns the exact knot value at a calibrated temperature", () => {
    for (const k of knots) expect(interpolateResponse(knots, k.temperatureC)).toBeCloseTo(k.response, 9);
  });

  it("linearly interpolates between two knots", () => {
    expect(interpolateResponse(knots, 50)).toBeCloseTo(60, 9); // midpoint of 80 and 40
  });

  it("linearly extrapolates below the first knot using its segment's slope", () => {
    // Slope from 20->40 is -1/°C; at 0°C that's 100 + 20 = 120.
    expect(interpolateResponse(knots, 0)).toBeCloseTo(120, 9);
  });

  it("linearly extrapolates above the last knot using its segment's slope", () => {
    // Slope from 60->80 is -1/°C; at 100°C that's 20 - 20 = 0.
    expect(interpolateResponse(knots, 100)).toBeCloseTo(0, 9);
  });

  it("returns 0 for an empty curve and the single value for a one-knot curve", () => {
    expect(interpolateResponse([], 50)).toBe(0);
    expect(interpolateResponse([{ temperatureC: 60, response: 42 }], 20)).toBe(42);
  });
});

describe("buildCalibrationMatrix", () => {
  const cal = calibrations();
  const dyeNames = ["FAM_BR Clear.Dcal", "HEX_BR Clear.Dcal", "Texas Red_BR Clear.Dcal"];
  const curves = dyeNames.map((n) => buildDyeResponseCurve(cal.get(n)!));

  it("has channel×dye shape with columns matching the interpolated curves", () => {
    const matrix = buildCalibrationMatrix(curves, 60, { normalization: "none" });
    expect(matrix.dyes).toEqual(["FAM", "HEX", "Texas Red"]);
    expect(matrix.values).toHaveLength(matrix.channelCount);
    for (let channel = 0; channel < matrix.channelCount; channel++) {
      for (let d = 0; d < curves.length; d++) {
        expect(matrix.values[channel]![d]!).toBeCloseTo(
          interpolateResponse(curves[d]!.channels[channel] ?? [], 60),
          6,
        );
      }
    }
  });

  it("'column' normalization gives every dye column unit L2 norm", () => {
    const matrix = buildCalibrationMatrix(curves, 60, { normalization: "column" });
    for (let d = 0; d < curves.length; d++) {
      let sumSquares = 0;
      for (const row of matrix.values) sumSquares += row[d]! ** 2;
      expect(Math.sqrt(sumSquares)).toBeCloseTo(1, 6);
    }
  });

  it("'global' normalization gives the whole matrix unit L2 norm", () => {
    const matrix = buildCalibrationMatrix(curves, 60, { normalization: "global" });
    let sumSquares = 0;
    for (const row of matrix.values) for (const v of row) sumSquares += v ** 2;
    expect(Math.sqrt(sumSquares)).toBeCloseTo(1, 6);
  });

  it("'none' normalization is idempotent with the raw interpolated values", () => {
    const raw = buildCalibrationMatrix(curves, 60, { normalization: "none" });
    const alsoRaw = buildCalibrationMatrix(curves, 60, { normalization: "none" });
    expect(raw.values).toEqual(alsoRaw.values);
  });

  it("records columnNorm from the raw responses, unaffected by the normalization mode", () => {
    const raw = buildCalibrationMatrix(curves, 60, { normalization: "none" });
    for (const mode of ["none", "column", "global"] as const) {
      const matrix = buildCalibrationMatrix(curves, 60, { normalization: mode });
      matrix.columnNorm.forEach((norm, d) => expect(norm).toBeCloseTo(raw.columnNorm[d]!, 6));
    }
  });

  it("restricts rows to the requested channels, normalizing over just those rows", () => {
    const matrix = buildCalibrationMatrix(curves, 60, {
      normalization: "column",
      channels: [0, 2],
    });
    expect(matrix.channels).toEqual([0, 2]);
    expect(matrix.channelCount).toBe(2);
    expect(matrix.values).toHaveLength(2);
    // Normalizing over only the kept rows is the point of passing `channels` rather than
    // slicing rows off a full-channel matrix afterwards.
    for (let d = 0; d < curves.length; d++) {
      let sumSquares = 0;
      for (const row of matrix.values) sumSquares += row[d]! ** 2;
      expect(Math.sqrt(sumSquares)).toBeCloseTo(1, 6);
    }
  });
});

describe("normalization mode does not change the reported RFU scale", () => {
  const cal = calibrations();
  const dyeNames = ["FAM_BR Clear.Dcal", "HEX_BR Clear.Dcal", "Cy5_BR Clear.Dcal"];
  const curves = dyeNames.map((n) => buildDyeResponseCurve(cal.get(n)!));
  const reading = [2269.1, 2022.2, 1934.8, 1975.6, 2332.1, 2137.1];

  it("gives identical concentrations for 'none', 'column' and 'global' on a full-rank matrix", () => {
    const solve = (normalization: NormalizationMode): number[] =>
      separateChannels(buildCalibrationMatrix(curves, 60, { normalization }), reading)
        .concentrations;
    const none = solve("none");
    for (const mode of ["column", "global"] as const) {
      const other = solve(mode);
      for (let d = 0; d < curves.length; d++) expect(other[d]!).toBeCloseTo(none[d]!, 6);
    }
  });

  it("reports RFU on the same order of magnitude as the raw channel readings", () => {
    const result = separateChannels(buildCalibrationMatrix(curves, 60), reading);
    for (const c of result.concentrations) {
      expect(c).toBeGreaterThan(100);
      expect(c).toBeLessThan(10_000);
    }
  });

  it("stays finite with far more dyes than channels, where the solve is underdetermined", () => {
    const many = [...cal.values()]
      .filter((d) => d.plate.trim().toLowerCase() === "br clear")
      .map((d) => buildDyeResponseCurve(d));
    expect(many.length).toBeGreaterThan(6);
    for (const normalization of ["none", "column", "global"] as const) {
      const result = separateChannels(
        buildCalibrationMatrix(many, 60, { normalization }),
        reading,
      );
      for (const c of result.concentrations) {
        expect(Number.isFinite(c)).toBe(true);
        // Before the eigensolver's convergence test was made scale-relative, `global` here
        // produced concentrations around 1e9 — see calibration.md §3.
        expect(Math.abs(c)).toBeLessThan(1e5);
      }
    }
  });
});

describe("preprocessChannelReadings", () => {
  it("pivots the gain correction on the reference level (dividing by wellFactor), then subtracts the background level", () => {
    const raw = [110, 220, 330];
    const result = preprocessChannelReadings(raw, {
      referenceLevel: [10, 20, 30],
      wellFactor: [2, 1, 0.5],
      backgroundLevel: [1, 2, 3],
    });
    // ch0: (110-10)/2+10 - 1 = 59; ch1: (220-20)/1+20 - 2 = 218; ch2: (330-30)/0.5+30 - 3 = 627
    expect(result).toEqual([59, 218, 627]);
  });

  it("has no effect from the reference level alone when no wellFactor is supplied", () => {
    const raw = [100, 200];
    expect(preprocessChannelReadings(raw, { referenceLevel: [10, 20] })).toEqual(raw);
  });

  it("divides by wellFactor rather than multiplying", () => {
    // With referenceLevel 0 (default), (raw - 0) / factor + 0 == raw / factor.
    expect(preprocessChannelReadings([10], { wellFactor: [2] })).toEqual([5]);
  });

  it("is a no-op with no options", () => {
    expect(preprocessChannelReadings([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("applies background subtraction independently of gain correction, per channel", () => {
    expect(preprocessChannelReadings([10, 10], { backgroundLevel: [3] })).toEqual([7, 10]);
  });

  it("applies gain correction independently per channel, leaving channels with no factor untouched", () => {
    expect(preprocessChannelReadings([20, 20], { wellFactor: [2] })).toEqual([10, 20]);
  });
});

describe("separateChannels", () => {
  it("exactly recovers known concentrations from a square, well-conditioned matrix", () => {
    const matrix = rawMatrix(
      ["A", "B"],
      [
        [1, 0.2],
        [0.1, 1],
      ],
    );
    const trueConcentrations = [50, 30];
    const channelReadings = matrix.values.map((row) =>
      row.reduce((sum, v, i) => sum + v * trueConcentrations[i]!, 0),
    );
    const result = separateChannels(matrix, channelReadings);
    expect(result.failed).toBe(false);
    expect(result.dyes).toEqual(["A", "B"]);
    // Reported in RFU — the recovered concentration times that dye's own response magnitude.
    expect(result.concentrations[0]!).toBeCloseTo(expectedRfu(matrix, 0, 50), 4);
    expect(result.concentrations[1]!).toBeCloseTo(expectedRfu(matrix, 1, 30), 4);
  });

  it("exactly recovers known concentrations from an overdetermined (more channels than dyes) matrix", () => {
    const matrix = rawMatrix(
      ["A", "B"],
      [
        [1, 0],
        [0, 1],
        [0.3, 0.3],
      ],
    );
    const trueConcentrations = [12, 7];
    const channelReadings = matrix.values.map((row) =>
      row.reduce((sum, v, i) => sum + v * trueConcentrations[i]!, 0),
    );
    const result = separateChannels(matrix, channelReadings);
    expect(result.concentrations[0]!).toBeCloseTo(expectedRfu(matrix, 0, 12), 4);
    expect(result.concentrations[1]!).toBeCloseTo(expectedRfu(matrix, 1, 7), 4);
  });

  it("reports failed with all-zero concentrations for a matrix with no signal at all", () => {
    const matrix = rawMatrix(
      ["A", "B"],
      [
        [0, 0],
        [0, 0],
      ],
    );
    const result = separateChannels(matrix, [10, 10]);
    expect(result.failed).toBe(true);
    expect(result.concentrations).toEqual([0, 0]);
  });

  it("does not blow up on a near-singular matrix (two near-duplicate dyes)", () => {
    const matrix = rawMatrix(
      ["A", "A-dup"],
      [
        [1, 1.0000001],
        [0.5, 0.5000001],
      ],
    );
    const result = separateChannels(matrix, [10, 5]);
    for (const c of result.concentrations) expect(Number.isFinite(c)).toBe(true);
  });

  it("is unchanged by scaling the whole matrix, since the solve undoes the scaling", () => {
    const values = [
      [1, 0.2],
      [0.1, 1],
    ];
    const base = rawMatrix(["A", "B"], values);
    // The same matrix, scaled down by 1e-4 and told so via columnScale — the shape
    // `buildCalibrationMatrix` produces for `global` normalization.
    const scaled: CalibrationMatrix = {
      ...base,
      values: values.map((row) => row.map((v) => v * 1e-4)),
      columnScale: [1e-4, 1e-4],
    };
    const reading = [10, 5];
    const a = separateChannels(base, reading).concentrations;
    const b = separateChannels(scaled, reading).concentrations;
    expect(b[0]!).toBeCloseTo(a[0]!, 6);
    expect(b[1]!).toBeCloseTo(a[1]!, 6);
  });
});

describe("separateDyes — end-to-end with real calibration files", () => {
  it("recovers known concentrations when the raw reading is synthesized from the same matrix", () => {
    const cal = calibrations();
    const dcals = [
      cal.get("FAM_BR Clear.Dcal")!,
      cal.get("HEX_BR Clear.Dcal")!,
      cal.get("Texas Red_BR Clear.Dcal")!,
      cal.get("Cy5_BR Clear.Dcal")!,
      cal.get("Quasar 705_BR Clear.Dcal")!,
    ];
    const temperatureC = 60;
    const curves = dcals.map((d) => buildDyeResponseCurve(d));
    const matrix = buildCalibrationMatrix(curves, temperatureC, { normalization: "none" });

    const trueConcentrations = [500, 300, 150, 80, 40];
    const channelReadings = matrix.values.map((row) =>
      row.reduce((sum, v, i) => sum + v * trueConcentrations[i]!, 0),
    );

    const result = separateDyes(dcals, channelReadings, temperatureC, {
      normalization: "none",
    });
    expect(result.dyes).toEqual(["FAM", "HEX", "Texas Red", "Cy5", "Quasar 705"]);
    for (let i = 0; i < trueConcentrations.length; i++) {
      // Reported in RFU: concentration × that dye's response magnitude across the channels.
      expect(result.concentrations[i]! / matrix.columnNorm[i]!).toBeCloseTo(
        trueConcentrations[i]!,
        2,
      );
    }
  });
});
