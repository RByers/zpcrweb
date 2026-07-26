import {
  buildCalibrationMatrix,
  buildDyeResponseCurve,
  preprocessChannelReadings,
  separateChannels,
  type CalibrationMatrix,
  type Dcal,
  type DcalEntry,
  type DyeResponseCurve,
  type NormalizationMode,
  type WellCurve,
} from "@zpcrweb/core";

/**
 * Applying channel→dye color separation (see `calibration.md`) to the curves view: matching
 * the plate's fluorophores to `.Dcal` calibration data, building one calibration matrix for the
 * whole plate/step, and running the solve for every well/cycle.
 */

/** The two physical tube/plate types Bio-Rad calibrates against — see `dcal.md`. */
export type TubeType = "BR Clear" | "BR White";

/**
 * A plate's tube type comes from `plateName` (see pltd.md "Vessel type"), compared
 * case-insensitively per that doc's warning. `MJ White` — the legacy MJ-lineage vessel — has no
 * calibration of its own and joins against the same `BR White` half of the archive's `.Dcal`
 * data as `BR White`. Anything else (including no plate data) defaults to Clear.
 */
export function resolveTubeType(plateName: string | undefined): TubeType {
  return plateName?.trim().toLowerCase().includes("white") ? "BR White" : "BR Clear";
}

/** One fluorophore present on the plate, with its calibration curve if a matching `.Dcal` was found. */
export interface FluorCalibration {
  fluor: string;
  /** Primary optical channel — used only for coloring/labeling, never fed into the solve itself. */
  channel: number;
  curve?: DyeResponseCurve;
}

/**
 * Match each of the plate's fluorophores (one per dye layer, see `pltd.md`) to the `.Dcal`
 * calibration for the given tube type. A fluor with no matching calibration file still appears,
 * with `curve` unset, so callers can show it as present-but-uncalibrated rather than silently
 * dropping it.
 */
export function matchFluorCalibrations(
  plateFluors: { fluor: string; channel: number }[],
  calibrations: DcalEntry[],
  tube: TubeType,
): FluorCalibration[] {
  // Case-insensitive: shipped .Dcal/calibrationCollection data is inconsistent between
  // display-cased ("BR White") and upper-cased ("BR WHITE") forms of the same tube type —
  // see pltd.md's vessel-type section.
  const wantedTube = tube.trim().toLowerCase();
  const byDye = new Map<string, Dcal>();
  for (const { dcal } of calibrations) {
    if (dcal.plate.trim().toLowerCase() === wantedTube) byDye.set(dcal.dye, dcal);
  }
  const seen = new Map<string, FluorCalibration>();
  for (const f of plateFluors) {
    if (seen.has(f.fluor)) continue; // a plate lists each fluor once per dye layer already
    const dcal = byDye.get(f.fluor);
    seen.set(f.fluor, {
      fluor: f.fluor,
      channel: f.channel,
      curve: dcal ? buildDyeResponseCurve(dcal) : undefined,
    });
  }
  return [...seen.values()];
}

/**
 * The per-cycle, per-well corrections `calibration.md` §4 applies to a raw reading before the
 * solve. All three parts are optional and independent: a run may carry any combination.
 */
export interface FluorCorrections {
  /**
   * Per-channel reference level per cycle — `referenceLevel[i][cycle]`, where `i` indexes the
   * `channels` array passed to {@link computeFluorCurves}. The pivot for the gain correction
   * (§4.1); with no `wellFactor` it has no effect, by design.
   */
  referenceLevel?: number[][];
  /**
   * Per-channel additive background per cycle, same indexing — subtracted outright (§4.2). The
   * plate read's LED-off `DARKDATA`, present only when the user-facing "Subtract dark" setting
   * is on; left undefined when it is off, which is the default.
   */
  backgroundLevel?: number[][];
  /** One well's gain factors across `channels`, or undefined when the run has none (§4.1). */
  wellFactor?: (row: number, col: number) => number[] | undefined;
}

/** Pull cycle `i`'s column out of a `[channel][cycle]` table, skipping non-finite entries. */
function columnAt(table: number[][] | undefined, i: number): number[] | undefined {
  if (!table) return undefined;
  const out = table.map((series) => series[i]);
  return out.every((v) => v !== undefined && Number.isFinite(v)) ? (out as number[]) : undefined;
}

/** One fluorophore's separated concentration curve for a single well — mirrors `WellCurve`. */
export interface FluorCurve {
  dye: string;
  /** The fluor's primary channel, carried through for consistent coloring only. */
  channel: number;
  row: number;
  col: number;
  wellLabel: string;
  isReference: boolean;
  cycles: number[];
  mean: number[];
}

/**
 * Run color separation for every well and cycle: build the raw per-channel vector (restricted
 * to `channels`, in that order), apply `calibration.md` §4's corrections, and solve against
 * `matrix`. `dyeChannels` gives each matrix column's primary channel, aligned with
 * `matrix.dyes`, purely for the returned curves' coloring.
 *
 * `corrections` carries the per-cycle reference/dark levels and per-well gain factors. Omitting
 * it skips §4 entirely, which is only right for a run that genuinely has none of that data —
 * the reference and dark levels are per-channel, so dropping them doesn't merely offset every
 * dye's baseline, it changes the channel proportions the solve unmixes.
 *
 * Unlike a raw channel reading (mean/std/min/max), a color-separated value has no direct
 * min/max/std of its own — those describe the pre-separation optical distribution within a
 * well, not the recovered dye concentration — so only a mean series is produced here.
 */
export function computeFluorCurves(
  wellCurves: WellCurve[],
  matrix: CalibrationMatrix,
  channels: number[],
  dyeChannels: number[],
  corrections: FluorCorrections = {},
): FluorCurve[] {
  const byWell = new Map<string, Map<number, WellCurve>>();
  for (const c of wellCurves) {
    const key = `${c.row},${c.col}`;
    const forWell = byWell.get(key) ?? new Map<number, WellCurve>();
    forWell.set(c.channel, c);
    byWell.set(key, forWell);
  }

  const out: FluorCurve[] = [];
  for (const byChannel of byWell.values()) {
    const first = [...byChannel.values()][0];
    if (!first) continue;
    const cycles = first.cycles;
    const perDye: number[][] = matrix.dyes.map(() => new Array<number>(cycles.length).fill(0));
    // Per well, not per cycle: the gain factors are a fixed property of the plate position.
    const wellFactor = corrections.wellFactor?.(first.row, first.col);

    for (let i = 0; i < cycles.length; i++) {
      const raw = channels.map((ch) => byChannel.get(ch)?.mean[i] ?? 0);
      const corrected = preprocessChannelReadings(raw, {
        referenceLevel: columnAt(corrections.referenceLevel, i),
        wellFactor,
        backgroundLevel: columnAt(corrections.backgroundLevel, i),
      });
      const { concentrations } = separateChannels(matrix, corrected);
      concentrations.forEach((v, d) => {
        perDye[d]![i] = v;
      });
    }

    matrix.dyes.forEach((dye, d) => {
      out.push({
        dye,
        channel: dyeChannels[d] ?? 0,
        row: first.row,
        col: first.col,
        wellLabel: first.wellLabel,
        isReference: first.isReference,
        cycles,
        mean: perDye[d]!,
      });
    });
  }
  return out;
}

export type { CalibrationMatrix, NormalizationMode };
