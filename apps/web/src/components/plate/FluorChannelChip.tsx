import { channelLabel } from "../../lib/channelColors";
import { fluorColor } from "../../lib/fluorColors";

/**
 * One `FAM Ch1` chip: the dye, a swatch in the dye's own color, and the optical channel it's read
 * on when that's known.
 *
 * The swatch comes from the dye name (`fluorColors.ts`), so it is right whether or not a
 * calibration is loaded — a dye is the color it emits. The channel is a separate fact and is
 * simply omitted when unknown: it says which filter saw the dye, which a plate on its own has no
 * way to know and no need to.
 *
 * Neither an unknown channel nor a dye the color table doesn't name is a **problem** — the dye set
 * is open and plenty of real dyes aren't listed — so neither gets warning styling. They render as
 * what they are: no channel shown, a neutral swatch.
 *
 * `compact` drops the channel entirely, for the dense per-well lists where a `Ch<n>` on every chip
 * is noise.
 */
export function FluorChannelChip({
  fluor,
  channel,
  compact = false,
}: {
  fluor: string;
  channel?: number;
  compact?: boolean;
}) {
  return (
    <span className="plate__chip mono">
      <span className="decoded__swatch" style={{ background: fluorColor(fluor) }} />
      {fluor}
      {!compact && channel !== undefined && (
        <>
          {" "}
          <span className="plate__chipch">{channelLabel(channel)}</span>
        </>
      )}
    </span>
  );
}
