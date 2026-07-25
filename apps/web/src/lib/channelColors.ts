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
 * channel index, so no dye name is attached here. A channel is always just "C1"–"C6" in this
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

export function channelColor(index: number): string {
  return CHANNEL_INFO[index]?.color ?? "#8aa0c0";
}

/** Display label for a channel in channel-space views — always "C1"–"C6", never a dye guess. */
export function channelLabel(index: number): string {
  return `C${index + 1}`;
}
