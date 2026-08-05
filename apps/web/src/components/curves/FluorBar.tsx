import { fluorColor } from "../../lib/fluorColors";
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
  /** The dye this chip stands for — used only for coloring (`fluorColors.ts`). Nullish when the
   * chip covers more than one dye (a target spanning several fluorophores), which colors it
   * neutrally instead; an unrecognized dye lands on the same neutral. */
  fluor?: string | null;
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
 * the dye itself, over the shared {@link ChipBar}. Dyes in the same emission band share a color,
 * distinguished by their label.
 */
export function FluorBar({ items, disabled, onToggle, onHover, onSolo, cardData }: Props) {
  return (
    <ChipBar
      chips={items.map((f) => ({
        key: f.key,
        label: f.label,
        sublabel: f.sublabel,
        color: fluorColor(f.fluor),
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
