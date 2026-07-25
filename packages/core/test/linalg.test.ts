import { describe, it, expect } from "vitest";
import { multiply, multiplyVector, pseudoInverse, transpose } from "../src/linalg.js";

function approxEqual(a: number[][], b: number[][], digits = 6) {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i]!.length).toBe(b[i]!.length);
    for (let j = 0; j < a[i]!.length; j++) {
      expect(a[i]![j]!).toBeCloseTo(b[i]![j]!, digits);
    }
  }
}

describe("transpose / multiply / multiplyVector", () => {
  it("transposes a rectangular matrix", () => {
    expect(
      transpose([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
  });

  it("multiplies matrices", () => {
    const a = [
      [1, 2],
      [3, 4],
    ];
    const b = [
      [5, 6],
      [7, 8],
    ];
    expect(multiply(a, b)).toEqual([
      [19, 22],
      [43, 50],
    ]);
  });

  it("multiplies a matrix by a vector", () => {
    const m = [
      [1, 0],
      [0, 2],
      [3, 3],
    ];
    expect(multiplyVector(m, [5, 7])).toEqual([5, 14, 36]);
  });
});

describe("pseudoInverse", () => {
  it("inverts the identity matrix to itself", () => {
    const I = [
      [1, 0],
      [0, 1],
    ];
    approxEqual(pseudoInverse(I), I);
  });

  it("matches the analytic inverse of a well-conditioned square matrix", () => {
    const m = [
      [4, 7],
      [2, 6],
    ];
    // det = 24 - 14 = 10; inverse = 1/10 * [[6, -7], [-2, 4]]
    const expected = [
      [0.6, -0.7],
      [-0.2, 0.4],
    ];
    approxEqual(pseudoInverse(m), expected);
  });

  it("solves an exact, noiseless overdetermined (more rows than columns) system", () => {
    // 3 channels, 2 dyes, full column rank.
    const m = [
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const trueX = [3, 5];
    const b = multiplyVector(m, trueX); // lies exactly in the column space
    const inv = pseudoInverse(m);
    const recovered = multiplyVector(inv, b);
    expect(recovered[0]!).toBeCloseTo(trueX[0]!, 6);
    expect(recovered[1]!).toBeCloseTo(trueX[1]!, 6);
  });

  it("satisfies the Moore-Penrose pinv(A)*A*pinv(A) = pinv(A) identity for a rectangular matrix", () => {
    const m = [
      [2, 0],
      [0, 3],
      [1, 1],
    ];
    const inv = pseudoInverse(m);
    const roundTrip = multiply(multiply(inv, m), inv);
    approxEqual(roundTrip, inv);
  });

  it("does not blow up on a singular (rank-deficient) square matrix", () => {
    // Second row is a multiple of the first: rank 1, not invertible in the ordinary sense.
    const m = [
      [1, 2],
      [2, 4],
    ];
    const inv = pseudoInverse(m);
    for (const row of inv) for (const v of row) expect(Number.isFinite(v)).toBe(true);
  });

  it("returns an all-zero pseudo-inverse for an all-zero matrix", () => {
    const m = [
      [0, 0],
      [0, 0],
    ];
    approxEqual(pseudoInverse(m), m);
  });
});

describe("pseudoInverse scale invariance", () => {
  // A moderately ill-conditioned 6×6, the shape a 6-channel × 6-dye calibration matrix takes.
  const base = [
    [1, 0.9, 0.2, 0.1, 0.0, 0.3],
    [0.9, 1, 0.5, 0.2, 0.1, 0.2],
    [0.2, 0.5, 1, 0.8, 0.1, 0.1],
    [0.1, 0.2, 0.8, 1, 0.6, 0.05],
    [0.0, 0.1, 0.1, 0.6, 1, 0.4],
    [0.3, 0.2, 0.1, 0.05, 0.4, 1],
  ];

  // pinv(sA) = pinv(A)/s exactly, so scaling the input must not change the answer's shape.
  // A convergence test on absolute off-diagonal magnitude broke this: a small-magnitude matrix
  // met it before any rotation ran, and came back with its untouched diagonal.
  it("scales exactly as pinv(sA) = pinv(A)/s across ten orders of magnitude", () => {
    const reference = pseudoInverse(base);
    for (const s of [1e-6, 1e-4, 1e-2, 1, 1e2, 1e4]) {
      const scaled = pseudoInverse(base.map((row) => row.map((v) => v * s)));
      approxEqual(
        scaled.map((row) => row.map((v) => v * s)),
        reference,
      );
    }
  });

  it("still satisfies the Moore-Penrose round trip for a tiny-magnitude matrix", () => {
    const tiny = base.map((row) => row.map((v) => v * 1e-5));
    const inv = pseudoInverse(tiny);
    approxEqual(multiply(multiply(tiny, inv), tiny), tiny);
  });
});
