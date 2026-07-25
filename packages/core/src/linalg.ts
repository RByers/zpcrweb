/**
 * Minimal dense linear algebra for small matrices (at most a handful of optical channels ×
 * dyes) — just enough to compute a Moore-Penrose pseudo-inverse, used by `calibration.ts` for
 * channel→dye color separation. Not a general-purpose numerics library: matrices are plain
 * `number[][]` (row-major), and every routine is sized for the ~6×6 case this library needs.
 */

export type Matrix = number[][];

export function transpose(m: Matrix): Matrix {
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const out: Matrix = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[c]![r] = m[r]![c]!;
    }
  }
  return out;
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  const rows = a.length;
  const inner = a[0]?.length ?? 0;
  const cols = b[0]?.length ?? 0;
  const out: Matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    const outRow = out[r]!;
    for (let k = 0; k < inner; k++) {
      const v = a[r]![k]!;
      if (v === 0) continue;
      const bRow = b[k]!;
      for (let c = 0; c < cols; c++) {
        outRow[c] = outRow[c]! + v * bRow[c]!;
      }
    }
  }
  return out;
}

export function multiplyVector(m: Matrix, v: number[]): number[] {
  return m.map((row) => row.reduce((sum, x, i) => sum + x * (v[i] ?? 0), 0));
}

function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

/**
 * Eigen-decompose a real symmetric matrix via the classic cyclic Jacobi rotation method.
 * Converges quickly for the small (≤6×6) matrices this module handles. Returns eigenvalues and
 * their matching eigenvectors (as columns of `vectors`), unordered.
 *
 * `tolerance` is **relative**: sweeping stops once the off-diagonal magnitude falls below
 * `tolerance × ‖input‖_F`. It has to be relative — an absolute cutoff makes the whole routine
 * scale-dependent, since multiplying the input by `s` multiplies the off-diagonal sum of squares
 * by `s²`. A small-magnitude matrix would then satisfy an absolute test before a single rotation
 * ran and come back with its untouched diagonal as the "eigenvalues", which is exactly the
 * failure `buildCalibrationMatrix`'s normalization used to trigger (see `calibration.md` §3).
 */
export function symmetricEigenDecomposition(
  input: Matrix,
  maxSweeps = 100,
  tolerance = 1e-14,
): { eigenvalues: number[]; vectors: Matrix } {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v = identity(n);

  let frobeniusSquared = 0;
  for (const row of input) for (const x of row) frobeniusSquared += x * x;
  // Compare squared quantities against a squared threshold, so the test reads as
  // `sqrt(offDiagonal) <= tolerance * sqrt(frobeniusSquared)` without the square roots.
  const threshold = tolerance * tolerance * frobeniusSquared;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let offDiagonal = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) offDiagonal += a[p]![q]! * a[p]![q]!;
    }
    if (offDiagonal <= threshold) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;

        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let i = 0; i < n; i++) {
          const aip = a[i]![p]!;
          const aiq = a[i]![q]!;
          a[i]![p] = c * aip - s * aiq;
          a[i]![q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p]![i]!;
          const aqi = a[q]![i]!;
          a[p]![i] = c * api - s * aqi;
          a[q]![i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = v[i]![p]!;
          const viq = v[i]![q]!;
          v[i]![p] = c * vip - s * viq;
          v[i]![q] = s * vip + c * viq;
        }
      }
    }
  }

  return { eigenvalues: a.map((row, i) => row[i]!), vectors: v };
}

/**
 * Moore-Penrose pseudo-inverse of an `m × n` matrix, computed from the eigen-decomposition of
 * its Gram matrix (`Aᵀ·A`). This reduces to the ordinary inverse when `A` is square and
 * well-conditioned, and to a least-squares (or minimum-norm) solution otherwise.
 *
 * `rcond` is the singular-value cutoff, relative to the largest singular value: any singular
 * value at or below `rcond * maxSingularValue` is treated as zero rather than inverted. This is
 * what keeps a near-singular calibration matrix from blowing up — a naive direct inversion of
 * the singular values has no such floor and diverges on tiny ones.
 */
export function pseudoInverse(a: Matrix, rcond = 1e-6): Matrix {
  const m = a.length;
  const n = a[0]?.length ?? 0;
  const gram = multiply(transpose(a), a); // n × n, symmetric positive semi-definite
  const { eigenvalues, vectors } = symmetricEigenDecomposition(gram);

  const maxSingularValue = Math.sqrt(Math.max(0, ...eigenvalues));
  const threshold = rcond * maxSingularValue;

  const out: Matrix = Array.from({ length: n }, () => new Array(m).fill(0));
  if (maxSingularValue === 0) return out; // the all-zero matrix has an all-zero pseudo-inverse

  for (let i = 0; i < n; i++) {
    const singularValue = Math.sqrt(Math.max(0, eigenvalues[i]!));
    if (singularValue <= threshold) continue; // drop directions below the noise floor

    const eigenvector = vectors.map((row) => row[i]!); // column i of `vectors`
    const projected = multiplyVector(a, eigenvector); // A · v_i, length m
    for (let r = 0; r < n; r++) {
      const scale = eigenvector[r]! / singularValue;
      const outRow = out[r]!;
      for (let c = 0; c < m; c++) {
        outRow[c] = outRow[c]! + scale * (projected[c]! / singularValue);
      }
    }
  }
  return out;
}
