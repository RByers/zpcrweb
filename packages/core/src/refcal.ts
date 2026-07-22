import type { PlateRead } from "./types.js";
import { CHANNELS, COLUMNS } from "./plateread.js";
import { REFERENCE_ROW } from "./pivot.js";

/**
 * Factory calibration of the reference row and its comparison to the live reference
 * readings. `RunInfo.xml`'s `FactoryRefRowCal` stores the reference row as measured at the
 * factory; comparing it to the current reference readings shows the instrument's optical
 * drift (LED aging, filter/detector changes) since calibration, per channel and position.
 */

/** One factory-calibrated reference well/channel: four floats **(mean, min, max, std)**. */
export interface RefWellCal {
  /** Optical channel 0–5. */
  channel: number;
  /** Reference-row column 0–11 (plate columns 1–12). */
  col: number;
  mean: number;
  min: number;
  max: number;
  std: number;
}

/**
 * Parse the `FactoryRefRowCal` value (a comma-separated list of `(mean, min, max, std)`
 * tuples) into typed per-well records. The layout is **column-major**: for each column, the
 * `channels` channels. Trailing zero-padding tuples are ignored.
 *
 * Note the tuple order here is (mean, min, max, std) — different from WELLDATA's
 * (mean, std, min, max).
 */
export function parseFactoryRefRowCal(
  raw: string,
  channels = CHANNELS,
  columns = COLUMNS,
): RefWellCal[] {
  if (!raw) return [];
  const nums = raw.split(",").map((s) => Number(s));
  const out: RefWellCal[] = [];
  for (let col = 0; col < columns; col++) {
    for (let channel = 0; channel < channels; channel++) {
      const base = (col * channels + channel) * 4;
      if (base + 3 >= nums.length) return out;
      out.push({
        channel,
        col,
        mean: nums[base] as number,
        min: nums[base + 1] as number,
        max: nums[base + 2] as number,
        std: nums[base + 3] as number,
      });
    }
  }
  return out;
}

/** A factory-vs-live comparison for one reference well/channel. */
export interface RefCalComparison {
  channel: number;
  col: number;
  /** Factory-calibrated mean. */
  factoryMean: number;
  /** Live reference mean, averaged across all reads (it is nearly constant over a run). */
  liveMean: number;
  /** `liveMean / factoryMean` — 1.0 means unchanged from factory. */
  ratio: number;
  /** `liveMean − factoryMean`. */
  delta: number;
}

/**
 * Compare the live reference row (averaged across all reads) to the factory calibration,
 * per channel and column.
 */
export function compareRefToCal(
  reads: PlateRead[],
  cal: RefWellCal[],
): RefCalComparison[] {
  return cal.map((c) => {
    let sum = 0;
    for (const read of reads) sum += read.get(c.channel, REFERENCE_ROW, c.col).mean;
    const liveMean = reads.length > 0 ? sum / reads.length : 0;
    return {
      channel: c.channel,
      col: c.col,
      factoryMean: c.mean,
      liveMean,
      ratio: c.mean !== 0 ? liveMean / c.mean : 0,
      delta: liveMean - c.mean,
    };
  });
}
