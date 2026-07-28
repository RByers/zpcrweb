import { ChipBar } from "./ChipBar";
import type { HoverCardData } from "./HoverCard";

interface Props {
  enabled: Set<number>;
  /** Number of reference columns to offer (from the plate width). */
  columns: number;
  onToggle: (col: number) => void;
  /** Hovering a chip (`null` on leave) — peeks at a disabled column and dims the rest. */
  onHover?: (col: number | null) => void;
  /** Double-clicking a chip — isolates it: only this column stays enabled. */
  onSolo?: (col: number) => void;
  /** Hover-card content for a column, or `null`/undefined to show none. */
  cardData?: (col: number) => HoverCardData | null | undefined;
}

/** Reference-column chip bar over the shared {@link ChipBar} — selecting plate columns (R1–R12)
 * rather than optical channels; see the Reference view. It used to carry a per-chip "only"
 * button instead of the double-click solo every other bar uses; unifying on `ChipBar` retired
 * that one-off in favor of the same click/double-click/hover contract. */
export function RefColBar({ enabled, columns, onToggle, onHover, onSolo, cardData }: Props) {
  return (
    <ChipBar
      chips={Array.from({ length: columns }, (_, col) => ({
        key: String(col),
        label: `R${col + 1}`,
        color: "var(--neon-magenta)",
        on: enabled.has(col),
      }))}
      onToggle={(key) => onToggle(Number(key))}
      onHover={onHover && ((key) => onHover(key == null ? null : Number(key)))}
      onSolo={onSolo && ((key) => onSolo(Number(key)))}
      cardData={cardData && ((key) => cardData(Number(key)))}
    />
  );
}
