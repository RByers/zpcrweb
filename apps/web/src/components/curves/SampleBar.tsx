import { ChipBar } from "./ChipBar";
import type { HoverCardData } from "./HoverCard";

interface Props {
  /** Distinct sample names present on the plate. */
  items: string[];
  /** Names *not* shown; anything else is on. */
  disabled: Set<string>;
  onToggle: (name: string) => void;
  /** Hovering a chip (by its sample name, or `null` on leave) — drives the curve-chart
   * highlight, mirroring {@link import("./FluorBar").FluorBar}'s `onHover`. */
  onHover?: (name: string | null) => void;
  /** Double-clicking a chip — isolates it: only this sample stays enabled. */
  onSolo?: (name: string) => void;
  /** Hover-card content for a sample name, or `null`/undefined to show none. */
  cardData?: (name: string) => HoverCardData | null | undefined;
}

/** One chip per distinct sample name (`PlateDefinition.samples`) over the shared
 * {@link ChipBar} — toggles curves for wells carrying that sample on/off, without a channel
 * color, since a sample has no optical channel of its own. */
export function SampleBar({ items, disabled, onToggle, onHover, onSolo, cardData }: Props) {
  return (
    <ChipBar
      chips={items.map((name) => ({
        key: name,
        label: name,
        color: "var(--neon-cyan)",
        on: !disabled.has(name),
      }))}
      onToggle={onToggle}
      onHover={onHover}
      onSolo={onSolo}
      cardData={cardData}
    />
  );
}
