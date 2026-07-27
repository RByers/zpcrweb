import type {
  CurveOptions,
  DarkCurve,
  PlateRead,
  PlateReadStep,
  PlateReadTemp,
  TemperatureCurve,
  WellCurve,
} from "./types.js";
import { CHANNELS, COLUMNS, ROWS } from "./plateread.js";

/**
 * Optical channel indices that hold data, from the reads' `CHANNELMASK` (low 6 bits, unioned
 * across reads). Falls back to all channels if no mask is present.
 */
export function toChannels(reads: PlateRead[]): number[] {
  let mask = 0;
  for (const r of reads) mask |= r.channelMask;
  const channels: number[] = [];
  for (let i = 0; i < CHANNELS; i++) if ((mask >> i) & 1) channels.push(i);
  return channels.length > 0 ? channels : Array.from({ length: CHANNELS }, (_, i) => i);
}

/** Distinct protocol steps (by the `STEP` field), in first-appearance order, with counts. */
export function toSteps(reads: PlateRead[]): PlateReadStep[] {
  const order: number[] = [];
  const counts = new Map<number, number>();
  for (const r of reads) {
    if (!counts.has(r.step)) order.push(r.step);
    counts.set(r.step, (counts.get(r.step) ?? 0) + 1);
  }
  return order.map((step) => ({ step, readCount: counts.get(step) as number }));
}

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
  allReads: PlateRead[],
  options: CurveOptions = {},
): WellCurve[] {
  const includeReference = options.includeReference ?? false;
  const reads =
    options.step === undefined
      ? allReads
      : allReads.filter((r) => r.step === options.step);
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
        const mean: number[] = [];
        const std: number[] = [];
        const min: number[] = [];
        const max: number[] = [];
        for (const read of reads) {
          const reading = read.wells[channel]![row]![col]!;
          mean.push(reading.mean);
          std.push(reading.std);
          min.push(reading.min);
          max.push(reading.max);
        }
        curves.push({
          channel,
          row,
          col,
          wellLabel: wellLabel(row, col),
          isReference,
          cycles,
          mean,
          std,
          min,
          max,
        });
      }
    }
  }
  return curves;
}

/**
 * Pivot the per-read DARKDATA into one curve per channel: the LED-off background reading
 * across cycles. Useful as a baseline reference or for background subtraction.
 */
export function toDarkCurves(allReads: PlateRead[], step?: number): DarkCurve[] {
  const reads =
    step === undefined ? allReads : allReads.filter((r) => r.step === step);
  const cycles = reads.map((r) => r.cycle);
  const curves: DarkCurve[] = [];
  for (let channel = 0; channel < CHANNELS; channel++) {
    const mean: number[] = [];
    const std: number[] = [];
    const min: number[] = [];
    const max: number[] = [];
    for (const read of reads) {
      const d = read.dark[channel];
      mean.push(d?.mean ?? NaN);
      std.push(d?.std ?? NaN);
      min.push(d?.min ?? NaN);
      max.push(d?.max ?? NaN);
    }
    curves.push({ channel, cycles, mean, std, min, max });
  }
  return curves;
}

/**
 * Pivot the per-read temperatures into one series per temperature field, in the order the
 * fields appear in the files. The key set is the union across reads, so a field missing from
 * some reads still yields a series (with `null` gaps) rather than being dropped.
 */
export function toTemperatureCurves(
  allReads: PlateRead[],
  step?: number,
): TemperatureCurve[] {
  const reads =
    step === undefined ? allReads : allReads.filter((r) => r.step === step);
  const cycles = reads.map((r) => r.cycle);

  // Union of keys in first-appearance order, keeping each key's label/kind metadata.
  const order: string[] = [];
  const info = new Map<string, PlateReadTemp>();
  for (const read of reads) {
    for (const t of read.temps) {
      if (!info.has(t.key)) order.push(t.key);
      info.set(t.key, t);
    }
  }

  return order.map((key) => {
    const meta = info.get(key) as PlateReadTemp;
    const celsius = reads.map((r) => r.temps.find((t) => t.key === key)?.celsius ?? null);
    return {
      key,
      label: meta.label,
      kind: meta.kind,
      cycles,
      celsius,
    };
  });
}
