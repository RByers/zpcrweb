/**
 * Channel → color, for views whose subject really is the optical channel: raw `.Plateread`
 * tables, the reference-calibration panel, the calibration crosstalk chart, and per-channel curve
 * rows. **A dye's color does not come from here** — that is `fluorColors.ts`, which colors by the
 * dye's own name so it doesn't depend on a calibration being loaded. The two palettes are the
 * same hues, so a dye and the channel it is read on still match on screen.
 *
 * The palette itself, and the reasoning behind it, moved to `@zpcrweb/core`'s `colors.ts`: the
 * CLI (`tools/zpcr.mjs`) renders the same curves as this app and has to draw them in the same
 * colors, so the table can't live in the app. Re-exported here so this module stays the one
 * import path for anything channel-related in the app.
 *
 * What is still app-only is {@link crosstalkColor}, for the Calibration view: there a single dye
 * is plotted across all six channels at once, so the lines are coloured from the *dye's* channel
 * and only tinged toward the channel each was read on. Same palette, different question — see its
 * doc comment.
 */

import { channelColor } from "@zpcrweb/core";

export {
  CHANNEL_INFO,
  NEUTRAL_COLOR,
  channelColor,
  type ChannelInfo,
} from "@zpcrweb/core";

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

/** Display label for a channel in channel-space views — in `@zpcrweb/core` since the results
 * table/CSV need the identical label with no UI dependency; re-exported here for the same reason
 * the palette above is. */
export { channelLabel, UNKNOWN_CHANNEL_LABEL } from "@zpcrweb/core";
