/**
 * The Calibration view's data derivation: turning a run's `.Dcal` set into the per-channel
 * response curves the view plots, and deciding which of them the run's own analysis actually
 * uses.
 *
 * The curves themselves are the library's ({@link buildDyeResponseCurve}, `calibration.md` §2):
 * `max(0, dyeReading − emptyReading)` per channel at each calibration temperature. Nothing is
 * re-derived here — this module only groups, labels and filters what the analysis already reads,
 * so what the chart shows is literally the input the color separation solves against.
 */

import {
  buildDyeReadingCurves,
  buildDyeResponseCurve,
  type DcalEntry,
  type ReadingKnot,
  type ResponseKnot,
  type TubeType,
} from "@zpcrweb/core";

/** Identity of one calibration file: a dye measured on one plate/tube type. Both halves are
 * needed — a run ships the same dye twice, once per tube type (see `dcal.md`). */
export function calKey(dye: string, plateType: string): string {
  return `${dye}|${plateType}`;
}

/** One `.Dcal` file, reduced to what the Calibration view draws and toggles. */
export interface CalibrationFile {
  /** {@link calKey} — the `FileSettings.calFiles` membership key. */
  key: string;
  /** Dye name, e.g. `FAM` (`Dcal.dye`). */
  dye: string;
  /** Plate/tube type the calibration was measured on, as the file spells it (`Dcal.plate`). */
  plateType: string;
  /** The dye's own optical channel (`Dcal.primaryChannel`) — the chip's color, and the one
   * channel whose response curve is the dye's signal rather than its crosstalk. */
  primaryChannel: number;
  /** Response knots per channel: `channels[channel]`, sorted by temperature. */
  channels: ResponseKnot[][];
  /** The raw dye-plate and empty-plate readings {@link channels} is the difference of, per
   * channel — what the view's absolute mode plots. The empty-plate half is used nowhere else:
   * subtracting it here is the algorithm's only use of it. */
  readings: ReadingKnot[][];
  /**
   * True when the run's own analysis reads this file: its plate type is the one the plate
   * resolves to, and its dye is a fluorophore the plate actually carries. Exactly the match
   * `matchFluorCalibrations` makes, on the same case-insensitive terms — these are the files
   * the view shows by default.
   */
  inUse: boolean;
}

/** Case/whitespace-insensitive, like every other dye and tube-type comparison in the app — a
 * hand-edited plate won't reproduce Bio-Rad's casing ("Tex 615"), and the shipped calibration
 * data itself mixes "BR White" with "BR WHITE" (see `@zpcrweb/core`'s `runAnalysis.ts`). */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Every calibration file in the run, with its response curves and whether the analysis uses it.
 * Sorted by plate type, then by the dye's own optical channel, then by name — so the view's two
 * chip groups come out in a stable order that runs along the spectrum, matching the channel bar
 * below them rather than cutting across it alphabetically.
 *
 * `plateFluors` is the plate's fluorophore list (empty when there's no plate, e.g. before a
 * password unlocks one) and `tube` the tube type it resolves to; together they decide `inUse`.
 */
export function calibrationFiles(
  entries: DcalEntry[],
  tube: TubeType,
  plateFluors: string[],
): CalibrationFile[] {
  const wantedTube = norm(tube);
  const wantedDyes = new Set(plateFluors.map(norm));
  return entries
    .map(({ dcal }) => {
      const curve = buildDyeResponseCurve(dcal);
      const readings = buildDyeReadingCurves(dcal);
      return {
        key: calKey(dcal.dye, dcal.plate),
        dye: dcal.dye,
        plateType: dcal.plate,
        primaryChannel: dcal.primaryChannel,
        channels: curve.channels,
        readings: readings.channels,
        inUse: norm(dcal.plate) === wantedTube && wantedDyes.has(norm(dcal.dye)),
      };
    })
    .sort(
      (a, b) =>
        a.plateType.localeCompare(b.plateType) ||
        a.primaryChannel - b.primaryChannel ||
        a.dye.localeCompare(b.dye),
    );
}

/**
 * The view's default selection: the files the analysis uses. When the plate is unknown (missing,
 * or still behind a password) nothing is "in use", so fall back to every file for the resolved
 * tube type — an unfiltered 28-line plot would be unreadable, and a blank one uninformative.
 */
export function defaultCalKeys(files: CalibrationFile[], tube: TubeType): Set<string> {
  const inUse = files.filter((f) => f.inUse);
  const chosen = inUse.length > 0 ? inUse : files.filter((f) => norm(f.plateType) === norm(tube));
  return new Set(chosen.map((f) => f.key));
}

/** Distinct plate types present, in the order {@link calibrationFiles} sorted them. */
export function calPlateTypes(files: CalibrationFile[]): string[] {
  return [...new Set(files.map((f) => f.plateType))];
}

/** Optical channels the calibration data covers — `0…channelCount-1`, from the widest file. */
export function calChannels(files: CalibrationFile[]): number[] {
  const count = files.reduce((max, f) => Math.max(max, f.channels.length), 0);
  return Array.from({ length: count }, (_, i) => i);
}
