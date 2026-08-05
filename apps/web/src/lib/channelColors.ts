/**
 * Channel → color mapping, for views whose subject really is the optical channel: raw
 * `.Plateread` tables, the reference-calibration panel, the calibration crosstalk chart, and
 * per-channel curve rows. **A dye's color does not come from here** — that is `fluorColors.ts`,
 * which colors by the dye's own name so it doesn't depend on a calibration being loaded. The two
 * palettes are the same hues, so a dye and the channel it is read on still match on screen.
 *
 * Color encodes the OPTICAL CHANNEL (6 categories), never the individual well — with up to
 * ~648 lines on screen, wells within a channel share a hue and are distinguished by
 * hover/selection emphasis instead.
 *
 * The one departure is {@link crosstalkColor}, for the Calibration view: there a single dye is
 * plotted across all six channels at once, so the lines are coloured from the *dye's* channel and
 * only tinged toward the channel each was read on. Same palette, different question — see its
 * doc comment.
 *
 * This palette is deliberately NOT colorblind-safe: a couple of hues sit close together and
 * cannot pass the CVD gate without losing the intuitive spectral ordering. That trade is
 * acceptable here only because identity never rests on color alone — the channel bar and the
 * hover tooltip always name the channel, and hovering isolates a single line.
 *
 * Channel space and dye space are deliberately kept apart (see `fluorCurves.ts`): which dye, if
 * any, is actually read on a given channel depends on the plate and its calibration, not on the
 * channel index, so no dye name is attached here. A channel is always just "Ch1"–"Ch6" in this
 * module; dye names, and the colors that go with them, live in `fluorColors.ts`.
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
 * whose wells load several fluorophores, where borrowing one of their hues would misrepresent
 * the group. Shared with `fluorColors.ts`, which needs the same "no color for this one" grey. */
export const NEUTRAL_COLOR = "#8aa0c0";

/** Color for a channel index, or {@link NEUTRAL_COLOR} for `null`/`undefined`/out-of-range.
 * Neutral is deliberately not one of the six hues: an unknown channel must not read as a real one. */
export function channelColor(index: number | null | undefined): string {
  return (index != null && CHANNEL_INFO[index]?.color) || NEUTRAL_COLOR;
}

/** How much of the read channel's hue is mixed into a crosstalk line — see
 * {@link crosstalkColor}. Enough to separate one dye's six channels from each other, small
 * enough that they still read as one dye's family of lines. */
const CROSSTALK_TINT = 0.35;

/** Blend two `#rrggbb` colors in sRGB: `t` of `b` mixed into `a`. */
function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a) as [number, number, number];
  const [br, bg, bb] = parse(b) as [number, number, number];
  const chan = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${chan(ar, br)}${chan(ag, bg)}${chan(ab, bb)}`;
}

/**
 * Color for one dye's response measured on one channel: mostly the hue of the dye's **own**
 * channel, tinged with the hue of the channel it was read on.
 *
 * The Calibration view plots one dye across all six channels at once, so the question the color
 * has to answer is "whose signal is this?" before "which filter saw it?" — colouring purely by
 * read channel (what every channel-space view does, and what this view used to do) scatters one
 * dye's lines across the whole palette and makes a rainbow of a single measurement. Keeping the
 * dye's hue dominant clusters its lines together; the tint is what still tells FAM-on-Ch2 from
 * FAM-on-Ch4 within that cluster. On its own channel the two hues coincide, so a primary line is
 * exactly its channel color and matches the rail chip.
 */
export function crosstalkColor(
  primaryChannel: number | null | undefined,
  channel: number | null | undefined,
): string {
  const base = channelColor(primaryChannel);
  const read = channelColor(channel);
  return base === read ? base : mixHex(base, read, CROSSTALK_TINT);
}

/** Display label for a channel in channel-space views — moved to `@zpcrweb/core` since the
 * results table/CSV need the identical label with no UI dependency; re-exported here so this
 * module stays the one import path for anything channel-related in the app. */
export { channelLabel, UNKNOWN_CHANNEL_LABEL } from "@zpcrweb/core";
