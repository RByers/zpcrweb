/**
 * Temperature series → color.
 *
 * Temperatures live on the chart's right axis, alongside up to hundreds of fluorescence
 * lines that own the dye palette (see `channelColors.ts`). So they are deliberately kept
 * off those hues: a cool cyan→slate ramp that reads as instrument chrome rather than data
 * from the plate. Identity never rests on color alone — every temperature series is named
 * in the rail toggles and in the hover tooltip — and the lines are dashed, which separates
 * them from the solid well curves even at a glance.
 */

/** Cool ramp, ordered to match the fields' file order (block, ambient, shuttle, …). */
const TEMP_COLORS = [
  "#22d3ee", // cyan — block (the one users look at)
  "#7dd3fc", // sky
  "#818cf8", // indigo
  "#c4b5fd", // violet-grey
  "#94a3b8", // slate
  "#64748b", // dim slate
];

/** Set points are thresholds, not readings — flat, dim, and visually recessive. */
const SETPOINT_COLOR = "#475569";

/**
 * Stable color for a temperature series.
 *
 * @param index position of the series among the plotted temperatures
 * @param kind measured reading vs configured set point
 */
export function tempColor(index: number, kind: "measured" | "setpoint"): string {
  if (kind === "setpoint") return SETPOINT_COLOR;
  return TEMP_COLORS[index % TEMP_COLORS.length] as string;
}
