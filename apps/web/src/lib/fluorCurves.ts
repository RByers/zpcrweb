import {
  buildCalibrationMatrix,
  buildDyeResponseCurve,
  preprocessChannelReadings,
  separateChannels,
  type CalibrationMatrix,
  type Dcal,
  type DcalEntry,
  type DarkCurve,
  type DyeResponseCurve,
  type NormalizationMode,
  type WellCurve,
} from "@zpcrweb/core";

/**
 * Applying channel→dye color separation (see `calibration.md`) to the curves view: matching
 * the plate's fluorophores to `.Dcal` calibration data, building one calibration matrix for the
 * whole plate/step, and running the solve for every well/cycle.
 */

/**
 * The two physical tube/plate types this UI offers — see `dcal.md`. `plateName` (`pltd.md`
 * §2) has a third legacy value, `MJ White`, not modeled here; a plate using it falls back to
 * `BR Clear` like any other unrecognized value.
 */
export type TubeType = "BR Clear" | "BR White";

/** A plate's tube type is usually exactly `plateName`; default to Clear when it isn't. */
export function resolveTubeType(plateName: string | undefined): TubeType {
  return plateName?.trim().toLowerCase() === "br white" ? "BR White" : "BR Clear";
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

/** Restrict a calibration matrix to a subset of channel rows (e.g. the run's scanned channels). */
export function restrictToChannels(matrix: CalibrationMatrix, channels: number[]): CalibrationMatrix {
  const zeroRow = matrix.dyes.map(() => 0);
  return {
    dyes: matrix.dyes,
    channelCount: channels.length,
    values: channels.map((ch) => matrix.values[ch] ?? zeroRow),
  };
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
 * to `channels`, in that order), optionally subtract each channel's dark-current reading (§4.2
 * of `calibration.md`), and solve against `matrix`. `dyeChannels` gives each matrix column's
 * primary channel, aligned with `matrix.dyes`, purely for the returned curves' coloring.
 *
 * Unlike a raw channel reading (mean/std/min/max), a color-separated value has no direct
 * min/max/std of its own — those describe the pre-separation optical distribution within a
 * well, not the recovered dye concentration — so only a mean series is produced here.
 */
export function computeFluorCurves(
  wellCurves: WellCurve[],
  darkCurves: DarkCurve[],
  matrix: CalibrationMatrix,
  channels: number[],
  dyeChannels: number[],
  options: { subtractDark: boolean },
): FluorCurve[] {
  const byWell = new Map<string, Map<number, WellCurve>>();
  for (const c of wellCurves) {
    const key = `${c.row},${c.col}`;
    const forWell = byWell.get(key) ?? new Map<number, WellCurve>();
    forWell.set(c.channel, c);
    byWell.set(key, forWell);
  }
  const darkByChannel = new Map(darkCurves.map((d) => [d.channel, d]));

  const out: FluorCurve[] = [];
  for (const byChannel of byWell.values()) {
    const first = [...byChannel.values()][0];
    if (!first) continue;
    const cycles = first.cycles;
    const perDye: number[][] = matrix.dyes.map(() => new Array<number>(cycles.length).fill(0));

    for (let i = 0; i < cycles.length; i++) {
      const raw = channels.map((ch) => byChannel.get(ch)?.mean[i] ?? 0);
      const darkLevel = options.subtractDark
        ? channels.map((ch) => darkByChannel.get(ch)?.mean[i] ?? 0)
        : undefined;
      const corrected = preprocessChannelReadings(raw, darkLevel ? { darkLevel } : {});
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
