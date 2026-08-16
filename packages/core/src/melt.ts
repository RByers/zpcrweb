/**
 * Recognizing a **melt curve** — the temperature ramp a protocol runs after amplification, where
 * the plate is read every fraction of a degree while the product dissociates.
 *
 * The question this module answers is "which of a run's plate-read steps is a melt, and what
 * temperature was each of its reads taken at". That is the whole of the detection problem: once a
 * step is known to be a melt and its temperature axis is in hand, `meltAnalysis.ts` does the rest.
 *
 * The rule is read from the **data**, not from the protocol (`melt.md` §2): a melt step's reads
 * sweep temperature, an amplification step's repeat one. Nothing else is needed — no `.prcl`
 * (which is encrypted and usually unavailable), no `MELT` directive (no stored protocol here
 * contains one; the melt is spelled the long way, `protocol.md` §6), and no password.
 *
 * See `melt.md` for the measurements behind the constants below.
 */

import type { PlateRead, WellCurve, Zpcr } from "./types.js";

/**
 * Where a melt's temperature axis came from — a per-read header field, or the source file
 * stating the axis outright (a Biomeme export's `meltTemperatures`).
 */
export type MeltAxisSource = "SAMPLETEMP" | "BLOCKTEMP" | "file";

/**
 * The per-read temperature fields a melt axis is taken from, in preference order (`melt.md` §3).
 *
 * `SAMPLETEMP` first because it is the temperature the melt was *programmed* in and lands on an
 * exact uniform grid (measured: 65.0 → 95.0 in 0.5 °C steps, with no other spacing present),
 * which is what makes the derivative of §4 well conditioned. `BLOCKTEMP` is the block's measured
 * value — real, but noisy and unevenly spaced (64.98, 65.34, 65.83, …) — and is the fallback for
 * a run whose reads carry no sample temperature.
 */
const MELT_AXIS_KEYS = ["SAMPLETEMP", "BLOCKTEMP"] as const;

/**
 * Fewest reads a temperature sweep must have to be called a melt. A melt is a curve, and a curve
 * needs enough points to have a shape: below this the derivative of §4 has nothing to smooth and
 * a "peak" would be an artifact of two or three readings.
 */
export const MELT_MIN_POINTS = 8;

/**
 * Least total temperature span, °C, of a melt (`melt.md` §2).
 *
 * **Measured**, and the reason this needs no tuning: on the committed two-step run the
 * amplification step spans **0.01 °C** across its 40 reads and the melt step spans **29.88 °C**
 * across its 61. Any constant between the two separates them; 5 °C sits three orders of magnitude
 * clear of the first and well clear of the shortest melt worth plotting.
 */
export const MELT_MIN_SPAN_C = 5;

/** Least median step between consecutive reads, °C. Measured: 0.000 amplification, 0.500 melt. */
export const MELT_MIN_INCREMENT_C = 0.05;

/**
 * How far a melt's temperature may go *backwards* between reads, °C, and still count as a ramp.
 *
 * Not zero, because `BLOCKTEMP` is a measurement: a block climbing 0.5 °C a rung can read a
 * hundredth low on one of them without the ramp having stopped. Far below
 * {@link MELT_MIN_INCREMENT_C}, so a step that genuinely holds one temperature can't drift its
 * way over the line.
 */
const MELT_MAX_DECREASE_C = 0.2;

/**
 * One plate-read step whose reads sweep temperature — a melt curve, and the unit every other
 * melt function is keyed on.
 */
export interface MeltSegment {
  /**
   * The `PlateRead.step` value this step's reads carry — the value `Zpcr.curves({ step })`
   * filters on, and the one `Zpcr.steps()` reports. Note this is the instrument's own `STEP`
   * field and **not** the protocol's step number (`melt.md` §2.1).
   */
  step: number;
  /**
   * Ascending temperature, °C, one entry per read — aligned index-for-index with the `mean` of
   * the curves `Zpcr.curves({ step })` returns for the same step. The melt's x axis.
   */
  temperaturesC: number[];
  /** Which of {@link MeltAxisSource}'s sources {@link temperaturesC} was taken from. */
  source: MeltAxisSource;
  /** First temperature of the ramp, °C. */
  startTempC: number;
  /** Last temperature of the ramp, °C. */
  endTempC: number;
  /** Median step between consecutive reads, °C — the ramp's increment. */
  incrementC: number;
  /** How many reads the ramp is made of. */
  pointCount: number;
}

/** Median of a copy of `values`; `values` is left alone. NaN for an empty list. */
function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
}

/**
 * The temperature axis a set of reads implies, or undefined if none of them carry one.
 *
 * Exported for `pivot.ts`, which fills every curve's `WellCurve.temperaturesC` from it — that is
 * simply "the temperature each point was read at" and involves no melt judgement, which is what
 * keeps this module out of the pivot's decisions (and out of an import cycle).
 */
export function readTemperatureAxis(
  reads: PlateRead[],
): { temperaturesC: number[]; source: MeltAxisSource } | undefined {
  for (const key of MELT_AXIS_KEYS) {
    const temperaturesC: number[] = [];
    for (const read of reads) {
      const temp = read.temps.find((t) => t.key === key);
      if (temp === undefined || !Number.isFinite(temp.celsius)) break;
      temperaturesC.push(temp.celsius);
    }
    // Every read or none: an axis with holes in it would put the curve's points at the wrong
    // temperatures rather than merely at fewer of them.
    if (temperaturesC.length === reads.length && reads.length > 0) {
      return { temperaturesC, source: key };
    }
  }
  return undefined;
}

/**
 * Decide whether a temperature axis is a melt ramp, and describe it if so.
 *
 * Exported so a caller holding an axis from somewhere other than a run's reads (a test, a source
 * that states its own) can apply exactly the shipped rule rather than a re-implementation of it.
 */
export function meltSegmentFromAxis(
  step: number,
  temperaturesC: number[],
  source: MeltAxisSource,
): MeltSegment | undefined {
  if (temperaturesC.length < MELT_MIN_POINTS) return undefined;

  const deltas: number[] = [];
  for (let i = 1; i < temperaturesC.length; i++) {
    const delta = (temperaturesC[i] as number) - (temperaturesC[i - 1] as number);
    if (delta < -MELT_MAX_DECREASE_C) return undefined; // not a ramp: it went back down
    deltas.push(delta);
  }

  const startTempC = temperaturesC[0] as number;
  const endTempC = temperaturesC[temperaturesC.length - 1] as number;
  if (endTempC - startTempC < MELT_MIN_SPAN_C) return undefined;

  const incrementC = median(deltas);
  if (!(incrementC >= MELT_MIN_INCREMENT_C)) return undefined;

  return {
    step,
    temperaturesC,
    source,
    startTempC,
    endTempC,
    incrementC,
    pointCount: temperaturesC.length,
  };
}

/**
 * The temperature axis a step's curves state for themselves, for a source that has no per-read
 * headers to take one from. Only a Biomeme export fills this today (its `Zpcr.reads` is empty by
 * design — the run arrives pre-pivoted into curves).
 */
function axisFromCurves(curves: WellCurve[]): number[] | undefined {
  for (const curve of curves) {
    if (curve.temperaturesC && curve.temperaturesC.length > 0) return curve.temperaturesC;
  }
  return undefined;
}

/**
 * Every plate-read step of a run that is a melt, in the order `Zpcr.steps()` reports them.
 *
 * Empty for an ordinary amplification run, which is the answer for most files and costs one pass
 * over the reads' temperature fields.
 */
export function meltSegments(zpcr: Zpcr): MeltSegment[] {
  const segments: MeltSegment[] = [];
  for (const { step } of zpcr.steps()) {
    // Reads first: they are the richer source, and they cover `.zpcr` and `.pcrd` alike with no
    // format-specific code. A source with no reads states its axis on the curves instead.
    const reads = zpcr.reads.filter((r) => r.step === step);
    if (reads.length > 0) {
      const axis = readTemperatureAxis(reads);
      if (!axis) continue;
      const segment = meltSegmentFromAxis(step, axis.temperaturesC, axis.source);
      if (segment) segments.push(segment);
      continue;
    }
    const stated = axisFromCurves(zpcr.curves({ step }));
    if (!stated) continue;
    const segment = meltSegmentFromAxis(step, stated, "file");
    if (segment) segments.push(segment);
  }
  return segments;
}

/**
 * The melt segment for one step, or undefined if that step isn't a melt — the question a view
 * asks when the operator selects a step and it has to decide which mode to render.
 */
export function meltSegmentFor(zpcr: Zpcr, step: number | undefined): MeltSegment | undefined {
  if (step === undefined) return undefined;
  return meltSegments(zpcr).find((s) => s.step === step);
}
