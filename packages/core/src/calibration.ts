/**
 * Channel→dye color separation: turning raw per-channel fluorescence readings into per-dye
 * concentration estimates, using the pure-dye/empty-plate measurements from `.Dcal` files. See
 * `calibration.md` for the full algorithm write-up; this module is its implementation.
 *
 * Pipeline: {@link buildDyeResponseCurve} turns one dye's calibration blocks into a
 * temperature→response curve per channel; {@link buildCalibrationMatrix} samples those curves
 * at a given block temperature (for several dyes at once) into a channel×dye matrix;
 * {@link preprocessChannelReadings} applies the same corrections a live plate read needs before
 * separation; {@link separateChannels} solves the matrix equation. {@link separateDyes} chains
 * all four for the common case.
 */

import type { Dcal } from "./dcal.js";
import { findDcalBlock } from "./dcal.js";
import { pseudoInverse } from "./linalg.js";

/** One (temperature, response) sample of a dye's calibration curve on a single channel. */
export interface ResponseKnot {
  temperatureC: number;
  /** `max(0, dyeReading − emptyReading)` at this temperature. */
  response: number;
}

/** A dye's fluorescence response curve, per channel, built from its `.Dcal` calibration. */
export interface DyeResponseCurve {
  /** Dye name, e.g. `FAM` (see {@link Dcal.dye}). */
  dye: string;
  /** Knots per channel: `channels[channel]` is that channel's curve, sorted by temperature. */
  channels: ResponseKnot[][];
}

/**
 * Build a dye's per-channel response curve from its `.Dcal` calibration: at each block
 * temperature that has both a dye-filled and an empty-plate block, the response is
 * `max(0, dyeReading − emptyReading)`. Uses well `well` (default `0`, i.e. A1) from each block —
 * calibration readings are uniform across wells in every file this library has decoded, see
 * `dcal.md`.
 */
export function buildDyeResponseCurve(dcal: Dcal, well = 0): DyeResponseCurve {
  const temperatures = [...new Set(dcal.blocks.map((b) => b.temperatureC))].sort((a, b) => a - b);
  const channels: ResponseKnot[][] = Array.from({ length: dcal.channelCount }, () => []);

  for (const temperatureC of temperatures) {
    const dyeBlock = findDcalBlock(dcal, "dye", temperatureC);
    const emptyBlock = findDcalBlock(dcal, "empty", temperatureC);
    if (!dyeBlock || !emptyBlock) continue;

    for (let channel = 0; channel < dcal.channelCount; channel++) {
      const dyeValue = dyeBlock.values[channel * dyeBlock.wellCount + well] ?? 0;
      const emptyValue = emptyBlock.values[channel * emptyBlock.wellCount + well] ?? 0;
      channels[channel]!.push({ temperatureC, response: Math.max(0, dyeValue - emptyValue) });
    }
  }

  return { dye: dcal.dye, channels };
}

/**
 * Sample a channel's response curve at an arbitrary block temperature: linear interpolation
 * between the two bracketing knots, or linear extrapolation past the first/last knot using that
 * end segment's slope (so any block temperature the instrument reports — not just the four
 * calibration points — has a defined response). Returns `0` for a curve with no knots.
 */
export function interpolateResponse(knots: ResponseKnot[], temperatureC: number): number {
  if (knots.length === 0) return 0;
  if (knots.length === 1) return knots[0]!.response;

  const lerp = (a: ResponseKnot, b: ResponseKnot): number => {
    const span = b.temperatureC - a.temperatureC;
    const t = span === 0 ? 0 : (temperatureC - a.temperatureC) / span;
    return a.response + t * (b.response - a.response);
  };

  if (temperatureC <= knots[0]!.temperatureC) return lerp(knots[0]!, knots[1]!);
  const last = knots.length - 1;
  if (temperatureC >= knots[last]!.temperatureC) return lerp(knots[last - 1]!, knots[last]!);

  for (let i = 0; i < last; i++) {
    if (temperatureC <= knots[i + 1]!.temperatureC) return lerp(knots[i]!, knots[i + 1]!);
  }
  return knots[last]!.response; // unreachable given the checks above
}

/**
 * How a calibration matrix's dye columns are scaled before the pseudo-inverse is taken. This is
 * a **numerical conditioning** choice only: {@link separateChannels} undoes whichever scaling was
 * applied, so all three modes report concentrations on the same fixed scale (see §3). The mode
 * still matters when the matrix is ill-conditioned or rank-deficient, because it changes which
 * directions fall under the pseudo-inverse's `rcond` floor.
 */
export type NormalizationMode =
  | "none" // use the raw interpolated response values as-is
  | "column" // L2-normalize each dye's channel-response vector independently
  | "global"; // L2-normalize the whole matrix by one norm computed across every entry

/** A channel×dye calibration matrix at one block temperature, ready for color separation. */
export interface CalibrationMatrix {
  /** Dye names, column order. */
  dyes: string[];
  /** Optical channel index for each row of {@link values}, in row order. */
  channels: number[];
  /** Row count — `channels.length`. */
  channelCount: number;
  /** `values[row][dye]` — column `d` is dye `d`'s (scaled) response across {@link channels}. */
  values: number[][];
  /**
   * The factor each raw column was multiplied by to produce {@link values} (per
   * {@link NormalizationMode}). {@link separateChannels} divides it back out, so the reported
   * concentrations don't depend on the mode.
   */
  columnScale: number[];
  /**
   * L2 norm of each dye's **raw** (pre-scaling) response column, i.e. the RFU that dye produces
   * across {@link channels} at unit concentration. The unit conversion that puts
   * {@link separateChannels}'s output on an RFU scale — see §5.
   */
  columnNorm: number[];
}

/** The per-column factors `mode` scales the raw matrix by. Always finite and non-zero. */
function columnScales(values: number[][], mode: NormalizationMode): number[] {
  const dyeCount = values[0]?.length ?? 0;
  if (mode === "none") return new Array(dyeCount).fill(1);

  if (mode === "column") {
    return Array.from({ length: dyeCount }, (_, d) => {
      let sumSquares = 0;
      for (const row of values) sumSquares += row[d]! ** 2;
      return sumSquares > 0 ? 1 / Math.sqrt(sumSquares) : 1;
    });
  }

  // "global": one norm across every entry in the matrix, shared by all columns.
  let sumSquares = 0;
  for (const row of values) for (const v of row) sumSquares += v ** 2;
  const scale = sumSquares > 0 ? 1 / Math.sqrt(sumSquares) : 1;
  return new Array(dyeCount).fill(scale);
}

/**
 * Assemble a channel×dye calibration matrix by sampling each dye's response curve at
 * `temperatureC`. `channels` restricts the rows to the optical channels actually scanned (the
 * run's `CHANNELMASK`), defaulting to every channel the curves cover — pass it rather than
 * slicing rows afterwards, since the column norms this matrix carries have to be computed over
 * the same rows the solve will use.
 *
 * `normalization` is a conditioning choice with no effect on the reported concentration scale;
 * see {@link NormalizationMode}. The default is `"column"`, which equilibrates the columns of a
 * matrix whose dyes differ several-fold in brightness.
 */
export function buildCalibrationMatrix(
  curves: DyeResponseCurve[],
  temperatureC: number,
  options: { normalization?: NormalizationMode; channels?: number[] } = {},
): CalibrationMatrix {
  const curveChannelCount = curves.reduce((max, c) => Math.max(max, c.channels.length), 0);
  const channels =
    options.channels ?? Array.from({ length: curveChannelCount }, (_, i) => i);

  const raw: number[][] = channels.map((channel) =>
    curves.map((curve) => interpolateResponse(curve.channels[channel] ?? [], temperatureC)),
  );

  const scale = columnScales(raw, options.normalization ?? "column");
  const columnNorm = curves.map((_, d) =>
    Math.sqrt(raw.reduce((sum, row) => sum + row[d]! ** 2, 0)),
  );

  return {
    dyes: curves.map((c) => c.dye),
    channels,
    channelCount: channels.length,
    values: raw.map((row) => row.map((v, d) => v * scale[d]!)),
    columnScale: scale,
    columnNorm,
  };
}

/** Per-channel corrections applied to a raw reading before color separation (see §4). */
export interface ChannelPreprocessOptions {
  /**
   * Per-channel reference level — one position from the plate's reference row, read with the
   * LED on (§4.1). The pivot for {@link wellFactor}'s gain correction, not a value subtracted
   * on its own: with no `wellFactor` supplied it has no effect. Missing/omitted channels
   * default to `0`.
   */
  referenceLevel?: number[];
  /**
   * Per-channel gain correction factor (§4.1). When present for a channel, that channel's
   * reading is corrected as `(raw − referenceLevel) / wellFactor + referenceLevel` — the factor
   * **divides**, and only the portion of the signal above the reference level is scaled. A
   * channel with no factor here is left as-is.
   */
  wellFactor?: number[];
  /**
   * Per-channel dark-current level to subtract (§4.2) — an LED-off background reading (e.g. a
   * `.Plateread`'s `DARKDATA`), genuinely additive and unrelated to the reference level. Applied
   * after the gain correction. A channel with no level here is left as-is; omit entirely for a
   * plate read with no dark record rather than passing zeros.
   */
  darkLevel?: number[];
}

/**
 * Apply the same corrections a live reading needs before color separation (§4), in order:
 * raw mean fluorescence → gain correction pivoted on the reference level (if a well factor is
 * given for that channel) → subtract dark current (if given for that channel). Both corrections
 * are independently optional, per channel.
 */
export function preprocessChannelReadings(
  raw: number[],
  options: ChannelPreprocessOptions = {},
): number[] {
  return raw.map((value, channel) => {
    let v = value;
    const factor = options.wellFactor?.[channel];
    if (factor !== undefined) {
      const reference = options.referenceLevel?.[channel] ?? 0;
      v = (v - reference) / factor + reference;
    }
    const dark = options.darkLevel?.[channel];
    if (dark !== undefined) v -= dark;
    return v;
  });
}

/** The result of solving a calibration matrix against a channel reading. */
export interface ColorSeparationResult {
  /** Dye names, aligned with {@link concentrations}. */
  dyes: string[];
  /**
   * Estimated per-dye intensity in **RFU**, aligned with {@link dyes}: the magnitude of that
   * dye's own contribution to the channel vector, on the same scale as the raw channel readings
   * that went in. Independent of the matrix's {@link NormalizationMode} — see §5.
   */
  concentrations: number[];
  /**
   * True if the calibration matrix had no usable signal at all (e.g. every entry zero) — the
   * concentrations are then all zero rather than a meaningless solve.
   */
  failed: boolean;
}

/**
 * Solve `matrix · concentrations = channelReadings` for the per-dye intensities, via the
 * matrix's Moore-Penrose pseudo-inverse (see `linalg.ts`). This reduces to an ordinary matrix
 * solve when the matrix is square and well-conditioned (channel count == dye count), and to a
 * least-squares fit otherwise (e.g. more channels than dyes). `rcond` is the singular-value
 * cutoff passed through to the pseudo-inverse — raise it if a near-singular calibration matrix
 * (e.g. two near-identical dyes) is producing implausibly large concentrations.
 *
 * The raw solve is against the matrix as {@link buildCalibrationMatrix} scaled it, so its output
 * is in whatever units that scaling implies. Two factors put the result back on a fixed scale
 * (see §5): `columnScale` undoes the normalization, leaving a concentration relative to the pure
 * calibration dye, and `columnNorm` converts that into the RFU the dye contributes. The reported
 * value therefore does not depend on the {@link NormalizationMode} the matrix was built with.
 */
export function separateChannels(
  matrix: CalibrationMatrix,
  channelReadings: number[],
  options: { rcond?: number } = {},
): ColorSeparationResult {
  const hasSignal = matrix.values.some((row) => row.some((v) => v !== 0));
  if (!hasSignal) {
    return { dyes: matrix.dyes, concentrations: matrix.dyes.map(() => 0), failed: true };
  }

  const inverse = pseudoInverse(matrix.values, options.rcond);
  const concentrations = inverse.map((row, d) => {
    const solved = row.reduce((sum, x, i) => sum + x * (channelReadings[i] ?? 0), 0);
    return solved * (matrix.columnScale[d] ?? 1) * (matrix.columnNorm[d] ?? 1);
  });
  return { dyes: matrix.dyes, concentrations, failed: false };
}

/**
 * Convenience wrapper chaining the full pipeline for the common case: build each dye's
 * response curve, assemble the calibration matrix at `temperatureC`, preprocess the raw channel
 * readings, and solve. Equivalent to calling {@link buildDyeResponseCurve},
 * {@link buildCalibrationMatrix}, {@link preprocessChannelReadings}, and
 * {@link separateChannels} directly — use those instead if you want to reuse a calibration
 * matrix across many wells/cycles rather than rebuilding it every call.
 */
export function separateDyes(
  dcals: Dcal[],
  rawChannelReadings: number[],
  temperatureC: number,
  options: {
    well?: number;
    normalization?: NormalizationMode;
    channels?: number[];
    preprocess?: ChannelPreprocessOptions;
    rcond?: number;
  } = {},
): ColorSeparationResult {
  const curves = dcals.map((dcal) => buildDyeResponseCurve(dcal, options.well ?? 0));
  const matrix = buildCalibrationMatrix(curves, temperatureC, {
    normalization: options.normalization,
    channels: options.channels,
  });
  const channelReadings = preprocessChannelReadings(rawChannelReadings, options.preprocess);
  return separateChannels(matrix, channelReadings, { rcond: options.rcond });
}
