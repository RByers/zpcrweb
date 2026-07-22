import type { CurveOptions, PlateRead, WellCurve } from "./types.js";
import { CHANNELS, COLUMNS, ROWS } from "./plateread.js";

/** Reference row index (row 8): holds real optical readings, not a sample row. */
export const REFERENCE_ROW = 8;

/** Human label for a well coordinate, e.g. `A3`; reference row uses `R3`. */
export function wellLabel(row: number, col: number): string {
  const rowLetter = row === REFERENCE_ROW ? "R" : String.fromCharCode(65 + row);
  return `${rowLetter}${col + 1}`;
}

/**
 * Pivot run-centric reads into well-centric amplification curves. Each curve is one
 * (channel, row, col) coordinate's mean fluorescence across all cycles, ready to plot.
 *
 * @param reads ordered plate reads (one per cycle)
 * @param options filter by channel and/or include the reference row
 */
export function toCurves(
  reads: PlateRead[],
  options: CurveOptions = {},
): WellCurve[] {
  const includeReference = options.includeReference ?? false;
  const cycles = reads.map((r) => r.cycle);

  const channels =
    options.channel === undefined
      ? Array.from({ length: CHANNELS }, (_, i) => i)
      : [options.channel];

  const curves: WellCurve[] = [];
  for (const channel of channels) {
    for (let row = 0; row < ROWS; row++) {
      const isReference = row === REFERENCE_ROW;
      if (isReference && !includeReference) continue;
      for (let col = 0; col < COLUMNS; col++) {
        const mean = reads.map((r) => r.get(channel, row, col).mean);
        curves.push({
          channel,
          row,
          col,
          wellLabel: wellLabel(row, col),
          isReference,
          cycles,
          mean,
        });
      }
    }
  }
  return curves;
}
