/**
 * Channel → color mapping.
 *
 * Color encodes the OPTICAL CHANNEL (6 categories), never the individual well — with up to
 * ~648 lines on screen, wells within a channel share a hue and are distinguished by
 * hover/selection emphasis instead.
 *
 * This palette is deliberately NOT colorblind-safe: a couple of hues sit close together and
 * cannot pass the CVD gate without losing the intuitive spectral ordering. That trade is
 * acceptable here only because identity never rests on color alone — the channel bar and the
 * hover tooltip always name the channel, and hovering isolates a single line.
 *
 * Channel space and dye space are deliberately kept apart (see `fluorCurves.ts`): which dye, if
 * any, is actually read on a given channel depends on the plate and its calibration, not on the
 * channel index, so no dye name is attached here. A channel is always just "Ch1"–"Ch6" in this
 * module; fluorophore names appear only once color separation has actually resolved them, in
 * the calibration ("Fluorophores") view.
 *
 * Channel 6 is a real sixth optical channel the CFX scans (ScanMask=63) — not the dark/reference
 * data (those are stored separately). It is off by default since standard 5-dye runs don't use
 * it; toggle it on to inspect it.
 */

export interface ChannelInfo {
  index: number;
  color: string;
}

export const CHANNEL_INFO: readonly ChannelInfo[] = [
  { index: 0, color: "#22c55e" }, // green
  { index: 1, color: "#eab308" }, // yellow
  { index: 2, color: "#f97316" }, // orange
  { index: 3, color: "#ef4444" }, // red
  { index: 4, color: "#a855f7" }, // purple
  { index: 5, color: "#3b82f6" }, // blue — sixth CFX channel
];

/** Neutral blue-grey (`--ink-2`) for anything that isn't one single channel — e.g. a target chip
 * whose wells load several fluorophores, where borrowing one of their channel hues would
 * misrepresent the group. */
export const NEUTRAL_COLOR = "#8aa0c0";

/** Color for a channel index, or {@link NEUTRAL_COLOR} for `null`/`undefined`/out-of-range —
 * no single channel, including a plate fluor whose channel isn't known (see `UNKNOWN_CHANNEL_LABEL`).
 * Neutral is deliberately not one of the six hues: an unknown channel must not read as a real one. */
export function channelColor(index: number | null | undefined): string {
  return (index != null && CHANNEL_INFO[index]?.color) || NEUTRAL_COLOR;
}

/**
 * What a fluor whose optical channel isn't known is labelled. A plate CSV names its fluor
 * columns by dye alone, and only the run's `.Dcal` set says which channel a dye is read on — so
 * a dye no calibration covers, or a plate CSV opened with no run, has no channel and is shown
 * as this rather than being assigned a plausible-looking one.
 */
export const UNKNOWN_CHANNEL_LABEL = "Ch?";

/**
 * Display label for a channel in channel-space views — always "Ch1"–"Ch6", never a dye guess,
 * and {@link UNKNOWN_CHANNEL_LABEL} when there is no channel to name. "Ch" rather than "C" to
 * avoid ambiguity with a well column/position.
 */
export function channelLabel(index: number | null | undefined): string {
  return index == null ? UNKNOWN_CHANNEL_LABEL : `Ch${index + 1}`;
}
