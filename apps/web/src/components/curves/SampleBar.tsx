import { useHoverCard, type HoverCardData } from "./HoverCard";

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

/** One chip per distinct sample name (`PlateDefinition.samples`) — toggles curves for wells
 * carrying that sample on/off, mirroring {@link import("./FluorBar").FluorBar}'s chips but
 * without a channel color, since a sample has no optical channel of its own. */
export function SampleBar({ items, disabled, onToggle, onHover, onSolo, cardData }: Props) {
  const { show, hide, node } = useHoverCard(cardData ?? (() => null));
  return (
    <div className="chanbar">
      {items.map((name) => {
        const on = !disabled.has(name);
        return (
          <button
            key={name}
            className={"chanchip" + (on ? " is-on" : "")}
            onClick={() => onToggle(name)}
            onDoubleClick={() => onSolo?.(name)}
            onMouseEnter={(e) => {
              onHover?.(name);
              show(name, e.currentTarget);
            }}
            onMouseLeave={() => {
              onHover?.(null);
              hide();
            }}
            aria-pressed={on}
            title={name}
            style={{ ["--chan" as string]: "var(--neon-cyan)" }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch mono">{name}</span>
            </span>
          </button>
        );
      })}
      {node}
    </div>
  );
}
