/**
 * Channel → color and dye label mapping.
 *
 * Color encodes the OPTICAL CHANNEL (6 categories), never the individual well — with up to
 * ~648 lines on screen, wells within a channel share a hue and are distinguished by
 * hover/selection emphasis instead.
 *
 * The colors follow the dyes' emission color (FAM green, HEX yellow, Texas Red orange, Cy5
 * red, Cy5.5 purple) — the Bio-Rad CFX convention users expect. This palette is deliberately
 * NOT colorblind-safe: warm dye colors collide (orange↔red; and channel 6's blue↔purple) and
 * cannot pass the CVD gate without abandoning the emission semantics. That trade is
 * acceptable here only because identity never rests on color alone — the channel bar and the
 * hover tooltip always name the channel and dye, and hovering isolates a single line.
 *
 * Channel 6 is a real sixth optical channel the CFX scans (ScanMask=63) — labelled FRET, the
 * CFX's sixth detector — not the dark/reference data (those are stored separately). It is
 * off by default since standard 5-dye runs don't use it; toggle it on to inspect it.
 */

export interface ChannelInfo {
  index: number;
  color: string;
  dye: string;
}

export const CHANNEL_INFO: readonly ChannelInfo[] = [
  { index: 0, color: "#22c55e", dye: "FAM" }, // green
  { index: 1, color: "#eab308", dye: "HEX" }, // yellow
  { index: 2, color: "#f97316", dye: "Texas Red" }, // orange
  { index: 3, color: "#ef4444", dye: "Cy5" }, // red
  { index: 4, color: "#a855f7", dye: "Cy5.5" }, // purple
  { index: 5, color: "#3b82f6", dye: "FRET" }, // blue — sixth CFX channel
];

export function channelColor(index: number): string {
  return CHANNEL_INFO[index]?.color ?? "#8aa0c0";
}

export function channelDye(index: number): string {
  return CHANNEL_INFO[index]?.dye ?? `Ch ${index + 1}`;
}
