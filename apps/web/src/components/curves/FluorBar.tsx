import { channelColor } from "../../lib/channelColors";
import { ChipBar } from "./ChipBar";
import type { HoverCardData } from "./HoverCard";

/** One chip's worth of data — a fluorophore or, in target view mode, a target/gene. */
export interface FluorChip {
  /** Toggle key, and the `disabled` set's membership key. */
  key: string;
  /** Primary label, e.g. the fluorophore or target name. */
  label: string;
  /** Secondary label shown below — the channel (fluorophore mode) or the fluorophore itself
   * (target mode). */
  sublabel: string;
  /** Optical channel — used only for coloring, so a channel's hue stays consistent between
   * channel-space and dye-space views. Nullish when the chip covers more than one channel (a
   * target spanning several fluorophores) or when the channel isn't known at all, either of
   * which colors it neutrally instead. */
  channel?: number | null;
  /** False when no matching `.Dcal` calibration was found — shown dimmed and non-interactive,
   * so its absence from the plot is visible rather than silent. */
  calibrated: boolean;
}

interface Props {
  items: FluorChip[];
  /** Keys *not* shown; anything else calibrated is on. */
  disabled: Set<string>;
  onToggle: (key: string) => void;
  /** Hovering a chip (by its `key`, or `null` on leave) — drives the curve-chart highlight. */
  onHover?: (key: string | null) => void;
  /** Double-clicking a chip — isolates it: only this fluorophore/target stays enabled. */
  onSolo?: (key: string) => void;
  /** Hover-card content for a chip's `key`, or `null`/undefined to show none. */
  cardData?: (key: string) => HoverCardData | null | undefined;
}

/**
 * One chip per fluorophore or target (see {@link FluorChip}) present on the plate — colored by
 * its primary channel, over the shared {@link ChipBar}. Multiple items sharing a channel simply
 * share a color, distinguished by their label.
 */
export function FluorBar({ items, disabled, onToggle, onHover, onSolo, cardData }: Props) {
  return (
    <ChipBar
      chips={items.map((f) => ({
        key: f.key,
        label: f.label,
        sublabel: f.sublabel,
        color: channelColor(f.channel),
        on: f.calibrated && !disabled.has(f.key),
        selectable: f.calibrated,
        title: f.calibrated
          ? f.label
          : `${f.label}: no calibration data for this tube type`,
      }))}
      onToggle={onToggle}
      onHover={onHover}
      onSolo={onSolo}
      cardData={cardData}
    />
  );
}
