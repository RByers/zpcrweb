import type {
  CurveOptions,
  DarkCurve,
  LedCurve,
  PlateRead,
  PlateReadLed,
  PlateReadStep,
  PlateReadTemp,
  TemperatureCurve,
  WellCurve,
} from "./types.js";
import { CHANNELS, COLUMNS, ROWS } from "./plateread.js";
import { parseScanMask } from "./runDefinition.js";

/**
 * Optical channel indices that hold data, from the reads' `CHANNELMASK` (unioned across reads).
 * The mask is the same field a protocol's `PLATEREAD` operand carries, decoded by the one
 * {@link parseScanMask} (`usb.md` §3.1) — 1-based there, 0-based here, where it indexes the
 * channel arrays. Falls back to all channels if no mask is present.
 */
export function toChannels(reads: PlateRead[]): number[] {
  let mask = 0;
  for (const r of reads) mask |= r.channelMask;
  const channels = parseScanMask(mask).channels.map((c) => c - 1);
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

/** Map key for a well coordinate — unlike {@link wellLabel}, not for display, just a stable,
 * unambiguous key for `Map`/`Set`. */
export function wellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * The inverse of {@link wellLabel}: `A3` → row 0, col 2; `R3` → the reference row. Case
 * insensitive, and tolerant of surrounding whitespace. Returns null for anything that isn't a
 * well on a 96-well plate (a bad letter, a column outside 1–12, trailing junk), so a caller
 * parsing a list can skip a token instead of guessing at it.
 */
export function parseWellLabel(label: string): { row: number; col: number } | null {
  const m = /^([A-Za-z])(\d{1,2})$/.exec(label.trim());
  if (!m || !m[1] || !m[2]) return null;
  const letter = m[1].toUpperCase();
  // Sample rows are lettered A–H; the reference row is `R`, not the ninth letter. `I` is
  // rejected rather than quietly landing on the reference row by arithmetic, since no label
  // {@link wellLabel} writes has ever meant that.
  const sampleRow = letter.charCodeAt(0) - 65;
  if (letter !== "R" && (sampleRow < 0 || sampleRow >= REFERENCE_ROW)) return null;
  const row = letter === "R" ? REFERENCE_ROW : sampleRow;
  const col = Number(m[2]) - 1;
  if (col < 0 || col >= COLUMNS) return null;
  return { row, col };
}

/**
 * Parse a **well selector** — the human-writable form of a set of wells, e.g.
 * `A1,A2,C4-E8,R12` — into {@link wellKey}s.
 *
 * A token is either a single label or a `from-to` **rectangle**, whose corners bound the block
 * in both axes: `C4-E8` is rows C–E crossed with columns 4–8, 15 wells, and not the 53 wells
 * that lie between them in reading order. That is what a person drags on a plate, so it is what
 * the text form means. Corners may be given in either order (`E8-C4` is the same block).
 *
 * Separators are commas or whitespace, and unparseable tokens are **dropped** rather than
 * failing the whole selector: this is written by hand into a URL, where salvaging the wells that
 * do make sense beats discarding the lot. Callers that need to tell "nothing valid" from "no
 * selection" check for an empty result.
 *
 * Order is first-appearance, and duplicates collapse.
 */
export function parseWellSelection(spec: string): string[] {
  const keys = new Set<string>();
  for (const token of spec.split(/[,\s]+/)) {
    if (!token) continue;
    const dash = token.indexOf("-", 1);
    if (dash < 0) {
      const w = parseWellLabel(token);
      if (w) keys.add(wellKey(w.row, w.col));
      continue;
    }
    const from = parseWellLabel(token.slice(0, dash));
    const to = parseWellLabel(token.slice(dash + 1));
    if (!from || !to) continue;
    for (let row = Math.min(from.row, to.row); row <= Math.max(from.row, to.row); row++) {
      for (let col = Math.min(from.col, to.col); col <= Math.max(from.col, to.col); col++) {
        keys.add(wellKey(row, col));
      }
    }
  }
  return [...keys];
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

/**
 * Pivot the per-read LED drive currents into one series per field, in file order — the same
 * union-of-keys treatment {@link toTemperatureCurves} gives temperatures, so a field missing
 * from some reads yields a series with `null` gaps rather than being dropped.
 *
 * The values are DAC counts (see {@link PlateReadLed.dac}). They are calibration settings, so
 * on a healthy run they are constant across the whole series; a step in one of them means the
 * instrument re-drove that channel's LED mid-run, which is exactly what makes them worth
 * plotting against the curves.
 */
export function toLedCurves(allReads: PlateRead[], step?: number): LedCurve[] {
  const reads =
    step === undefined ? allReads : allReads.filter((r) => r.step === step);
  const cycles = reads.map((r) => r.cycle);

  const order: string[] = [];
  const info = new Map<string, PlateReadLed>();
  for (const read of reads) {
    for (const l of read.leds) {
      if (!info.has(l.key)) order.push(l.key);
      info.set(l.key, l);
    }
  }

  return order.map((key) => {
    const meta = info.get(key) as PlateReadLed;
    const dac = reads.map((r) => r.leds.find((l) => l.key === key)?.dac ?? null);
    return { key, label: meta.label, channel: meta.channel, cycles, dac };
  });
}
