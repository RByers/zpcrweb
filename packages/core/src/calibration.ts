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

/** How a calibration matrix's dye columns are scaled before use in {@link separateChannels}. */
export type NormalizationMode =
  | "none" // use the raw interpolated response values as-is
  | "column" // L2-normalize each dye's channel-response vector independently
  | "global"; // L2-normalize the whole matrix by one norm computed across every entry

/** A channel×dye calibration matrix at one block temperature, ready for color separation. */
export interface CalibrationMatrix {
  /** Dye names, column order. */
  dyes: string[];
  /** Row count. */
  channelCount: number;
  /** `values[channel][dye]` — column `d` is dye `d`'s (normalized) response across channels. */
  values: number[][];
}

function normalize(values: number[][], mode: NormalizationMode): number[][] {
  if (mode === "none") return values;
  const channelCount = values.length;
  const dyeCount = values[0]?.length ?? 0;

  if (mode === "column") {
    const out = values.map((row) => row.slice());
    for (let d = 0; d < dyeCount; d++) {
      let sumSquares = 0;
      for (let c = 0; c < channelCount; c++) sumSquares += out[c]![d]! ** 2;
      const scale = sumSquares > 0 ? 1 / Math.sqrt(sumSquares) : 1;
      for (let c = 0; c < channelCount; c++) out[c]![d]! *= scale;
    }
    return out;
  }

  // "global": one norm across every entry in the matrix.
  let sumSquares = 0;
  for (const row of values) for (const v of row) sumSquares += v ** 2;
  const scale = sumSquares > 0 ? 1 / Math.sqrt(sumSquares) : 1;
  return values.map((row) => row.map((v) => v * scale));
}

/**
 * Assemble a channel×dye calibration matrix by sampling each dye's response curve at
 * `temperatureC`, then normalizing the columns. Default normalization is `"global"` (one norm
 * across the whole matrix), matching the observed default behavior; `"column"` instead
 * normalizes each dye independently, and `"none"` skips normalization.
 */
export function buildCalibrationMatrix(
  curves: DyeResponseCurve[],
  temperatureC: number,
  options: { normalization?: NormalizationMode } = {},
): CalibrationMatrix {
  const channelCount = curves.reduce((max, c) => Math.max(max, c.channels.length), 0);
  const raw: number[][] = Array.from({ length: channelCount }, (_, channel) =>
    curves.map((curve) => interpolateResponse(curve.channels[channel] ?? [], temperatureC)),
  );
  return {
    dyes: curves.map((c) => c.dye),
    channelCount,
    values: normalize(raw, options.normalization ?? "global"),
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
  /** Estimated per-dye concentration/intensity, aligned with {@link dyes}. */
  concentrations: number[];
  /**
   * True if the calibration matrix had no usable signal at all (e.g. every entry zero) — the
   * concentrations are then all zero rather than a meaningless solve.
   */
  failed: boolean;
}

/**
 * Solve `matrix · concentrations = channelReadings` for the per-dye concentrations, via the
 * matrix's Moore-Penrose pseudo-inverse (see `linalg.ts`). This reduces to an ordinary matrix
 * solve when the matrix is square and well-conditioned (channel count == dye count), and to a
 * least-squares fit otherwise (e.g. more channels than dyes). `rcond` is the singular-value
 * cutoff passed through to the pseudo-inverse — raise it if a near-singular calibration matrix
 * (e.g. two near-identical dyes) is producing implausibly large concentrations.
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
  const concentrations = inverse.map((row) =>
    row.reduce((sum, x, i) => sum + x * (channelReadings[i] ?? 0), 0),
  );
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
    preprocess?: ChannelPreprocessOptions;
    rcond?: number;
  } = {},
): ColorSeparationResult {
  const curves = dcals.map((dcal) => buildDyeResponseCurve(dcal, options.well ?? 0));
  const matrix = buildCalibrationMatrix(curves, temperatureC, {
    normalization: options.normalization,
  });
  const channelReadings = preprocessChannelReadings(rawChannelReadings, options.preprocess);
  return separateChannels(matrix, channelReadings, { rcond: options.rcond });
}
