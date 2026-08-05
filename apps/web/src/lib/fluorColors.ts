/**
 * Fluorophore → color mapping.
 *
 * A dye's color is a property of the **dye**, not of the instrument that read it. FAM is green
 * because FAM emits green; that is true of a plate typed into a spreadsheet, a plate from a
 * machine with no calibration loaded, and a Biomeme cartridge that has no optical channels of its
 * own to speak of. So dye chips, plate well dots and target chips color from this table and never
 * from an optical channel.
 *
 * That is a deliberate reversal. Coloring a dye by the channel it happens to be read on made the
 * UI's colors depend on the run's `.Dcal` calibration being present and covering that dye, which
 * meant a hand-authored plate, or one opened with no run beside it, rendered every dye a
 * featureless grey — an instrument fact standing in for something the dye name already answers.
 * `channelColors.ts` still owns color for genuine channel-space views (raw `.Plateread` tables,
 * the reference-calibration panel, per-channel curve rows), where the question really is "which
 * filter saw this?".
 *
 * **The palette is the channel palette**, dye by dye: each entry is the hue its channel already
 * used, so nothing on screen changes color and the spectral ordering (green → yellow → orange →
 * red → purple) still reads in dye order. Dyes sharing a channel therefore share a hue. That is
 * honest rather than lossy — they sit on one channel *because* they emit in one band, and a run
 * cannot use two of them at once and still be unmixable.
 *
 * The table is seeded from every dye the committed samples' calibration data names — 14 across
 * the `.zpcr`/`.pcrd` samples' `.Dcal` sets, all agreeing dye-for-dye on channel, plus the three
 * the Biomeme sample carries. It is an open set: an unrecognized dye is neutral (see
 * {@link fluorColor}), which is a plain "no color for this one", not a problem to report.
 */

import { NEUTRAL_COLOR, channelColor } from "./channelColors";

/**
 * Dye name → color. Grouped by the optical channel the dye is read on in every sample inspected,
 * which is where each hue comes from — the grouping is provenance, not a lookup key; nothing here
 * consults a channel at runtime.
 */
const FLUOR_COLORS: Record<string, string> = {
  // Channel 1 — green
  fam: "#22c55e",
  sybr: "#22c55e",
  // Channel 2 — yellow
  hex: "#eab308",
  vic: "#eab308",
  "cal gold 540": "#eab308",
  "cal orange 560": "#eab308",
  // Channel 3 — orange
  rox: "#f97316",
  "tex 615": "#f97316",
  "texas red": "#f97316",
  "cal red 610": "#f97316",
  texredx: "#f97316", // Biomeme's spelling of the same emission band
  // Channel 4 — red
  cy5: "#ef4444",
  "quasar 670": "#ef4444",
  "atto-647n": "#ef4444", // Biomeme
  // Channel 5 — purple
  "cy5-5": "#a855f7",
  "quasar 705": "#a855f7",
  // Channel 6 — blue. The CFX scans it (ScanMask=63) but no sample calibrates a dye for it, so
  // there is nothing to name here yet; #3b82f6 is reserved for whatever turns up.
};

/** Lookup key for a dye name: case and internal spacing vary between a `.pltd`, a hand-typed
 * `.plt.csv` and a Biomeme export, and none of that changes which dye is meant. */
function key(fluor: string): string {
  return fluor.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Color for a dye, or {@link NEUTRAL_COLOR} for one this table doesn't name.
 *
 * Neutral is deliberately not one of the palette hues: an unknown dye must not read as a known
 * one. It is not a warning either — the dye set is open, plenty of real dyes aren't listed here,
 * and "this app has no color for that name" is worth zero of the user's attention.
 */
export function fluorColor(fluor: string | null | undefined): string {
  return (fluor != null && FLUOR_COLORS[key(fluor)]) || NEUTRAL_COLOR;
}

/** Whether {@link fluorColor} has a color of its own for this dye — for the few places that
 * render a known dye and an unnamed one differently (a filled vs. hollow swatch), never to raise
 * an alarm about the latter. */
export function isKnownFluor(fluor: string | null | undefined): boolean {
  return fluor != null && FLUOR_COLORS[key(fluor)] !== undefined;
}

/**
 * Color for one plotted curve: the **dye's** color for a dye-space curve, the channel's for a
 * channel-space one. A channel-space curve is a channel's own readings before any unmixing — no
 * dye has been resolved out of it yet — so there the channel is genuinely the subject, and it
 * carries no `fluor` to ask about.
 */
export function curveColor(c: { fluor?: string | null; channel?: number | null }): string {
  return c.fluor != null ? fluorColor(c.fluor) : channelColor(c.channel);
}
