import { channelColor, channelLabel, UNKNOWN_CHANNEL_LABEL } from "../../lib/channelColors";

/**
 * Why a fluor can have no optical channel, in the words the UI uses to explain it. A `.pltd`
 * always states the channel; a `.plt.csv` names its fluor columns by dye alone and leans on the
 * run's `.Dcal` set to resolve them, so a dye no calibration covers — or a plate CSV opened on
 * its own, with no run to consult — genuinely has none.
 */
export const UNKNOWN_CHANNEL_TITLE =
  "Optical channel unknown: this plate names the dye but not its channel, and no matching .Dcal " +
  "calibration was available to resolve it. Nothing is guessed from column order, so this dye " +
  "has no channel color or channel grouping.";

/** True when any of a plate's fluors is missing its channel — drives {@link UnknownChannelNote}. */
export function hasUnknownChannel(fluors: { channel?: number }[]): boolean {
  return fluors.some((f) => f.channel === undefined);
}

/**
 * One `FAM Ch1` chip: the dye, its channel swatch, and its channel label — with the channel
 * shown as `Ch?` and the chip outlined dashed when it isn't known, rather than being coloured
 * as some channel it may not be on.
 *
 * `compact` names the channel only when it *isn't* known, for the dense per-well lists where a
 * `Ch<n>` on every chip is noise. The unknown marker still shows there: it's the case worth the
 * space, since a neutral swatch alone reads as "some colour" rather than "no channel".
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
  const unknown = channel === undefined;
  return (
    <span
      className={"plate__chip mono" + (unknown ? " plate__chip--unknown" : "")}
      title={unknown ? UNKNOWN_CHANNEL_TITLE : undefined}
    >
      <span className="decoded__swatch" style={{ background: channelColor(channel) }} />
      {fluor}
      {(!compact || unknown) && (
        <>
          {" "}
          <span className={"plate__chipch" + (unknown ? " plate__chipch--unknown" : "")}>
            {channelLabel(channel)}
          </span>
        </>
      )}
    </span>
  );
}

/** The footnote shown under a fluor list that contains at least one unknown channel. */
export function UnknownChannelNote() {
  return (
    <p className="plate__note">
      <b>{UNKNOWN_CHANNEL_LABEL}</b> — optical channel unknown for one or more dyes. This plate
      names the dye but not its channel, and no matching <code>.Dcal</code> calibration was
      available to resolve it. Channel order is never inferred from column order, so these dyes
      have no channel colour and are left out of channel-based grouping.
    </p>
  );
}
